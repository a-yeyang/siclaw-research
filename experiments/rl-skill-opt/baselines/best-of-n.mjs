#!/usr/bin/env node
/**
 * best-of-n.mjs — best-of-N + verifier (inference-time scaling, no training).
 *
 * SWE-Gym (ICML'25, 2412.21139) uses best-of-N with a learned verifier. Here the
 * "verifier" is the real environment (Siclaw + judge + composite reward): we sample
 * N candidate skills from the reflector LLM (varied temperature, NO ground truth —
 * same prompt the RL proposer uses), evaluate each on the train cases, and KEEP the
 * one with the best mean composite reward. No proposer weights are updated; this is
 * pure inference-time search and a direct, cheap competitor to RL.
 *
 * Budget accounting: rollouts = N x (#train cases). Matched to RL by choosing N.
 *
 * Usage:
 *   node experiments/rl-skill-opt/baselines/best-of-n.mjs \
 *     --category network-dns --train-cases c068,c069,c070,c071,c072,c073 \
 *     --provider gpt --proposer gpt-5.4 --n 6 \
 *     --baseline-judge <no-skill judgments.json> \
 *     --run-root experiments/rl-skill-opt/results-v2/bon_netdns
 */
import fs from "node:fs";
import path from "node:path";
import { LLM, cleanSkill } from "../llm-client.mjs";
import { scoreSkill } from "../score-skill.mjs";

function arg(name, fb) { const i = process.argv.indexOf(name); return i < 0 ? fb : process.argv[i + 1] ?? fb; }
const CATEGORY = arg("--category", "network-dns");
const TRAIN_CASES = arg("--train-cases", "").split(",").map((s) => s.trim()).filter(Boolean);
const PROVIDER = arg("--provider", "gpt");
const PROPOSER = arg("--proposer", "gpt-5.4");
const N = Number(arg("--n", "6"));
const BASELINE_JUDGE = arg("--baseline-judge", "");
const EXAMPLES_FILE = arg("--examples-file", "");
const RUN_ROOT = arg("--run-root", `experiments/rl-skill-opt/results-v2/bon_${CATEGORY}_${Date.now()}`);
const CONCURRENCY = arg("--concurrency", "3");

if (!TRAIN_CASES.length) { console.error("Need --train-cases"); process.exit(2); }
fs.mkdirSync(RUN_ROOT, { recursive: true });

const SYSTEM = (
  "You are an expert SRE who writes concise, reusable diagnostic SOPs (skills) for an automated, " +
  "read-only Kubernetes diagnosis agent. A good SOP names which resources to inspect, in what order, " +
  "how to separate root cause from downstream symptoms, and what a correct diagnosis must contain."
);

function userPrompt(category, examples, variant) {
  const ex = examples.length ? examples.map((e, i) => `  Example incident ${i + 1}: ${e}`).join("\n") : "  (none)";
  const styles = [
    "Write it as a numbered checklist of read-only checks in strict order.",
    "Write it emphasizing how to DISTINGUISH the candidate root causes from each other.",
    "Write it focusing on the exact kubectl commands and the fields to read in each.",
    "Write it as a decision tree: first rule out X, then Y, then Z.",
    "Write it stressing what a correct final diagnosis MUST name and the evidence required.",
    "Write a thorough general procedure covering every plausible cause for this category.",
  ];
  const hint = styles[variant % styles.length];
  return `Write ONE general diagnostic SOP for the fault category "${category}".
Representative symptoms (these do NOT reveal the answer):\n${ex}

${hint}
Constraints: a GENERAL category-wide procedure, no incident-specific names/IPs; give the ordered
read-only checks; separate root cause from symptom; state what the diagnosis must name and a safe
remediation. 150-400 words. Output ONLY the SOP text.`;
}

async function main() {
  const examples = EXAMPLES_FILE && fs.existsSync(EXAMPLES_FILE) ? JSON.parse(fs.readFileSync(EXAMPLES_FILE, "utf8")) : [];
  const llm = new LLM();
  console.error(`=== best-of-N  N=${N} category=${CATEGORY} provider=${PROVIDER} proposer=${PROPOSER} train=${TRAIN_CASES.join(",")} ===`);

  // 1) sample N candidate skills (varied temperature + style for diversity)
  const candidates = [];
  for (let i = 0; i < N; i++) {
    const temp = 0.6 + 0.1 * (i % 5); // 0.6..1.0
    try {
      const { text } = await llm.chat({ model: PROPOSER, system: SYSTEM, user: userPrompt(CATEGORY, examples, i), temperature: temp, maxTokens: 1200 });
      const skill = cleanSkill(text);
      candidates.push({ idx: i, skill, chars: skill.length, temp });
      fs.writeFileSync(path.join(RUN_ROOT, `cand${i}.txt`), skill);
      console.error(`[bon] candidate ${i}: ${skill.length} chars (temp ${temp.toFixed(1)})`);
    } catch (e) {
      console.error(`[bon] candidate ${i} generation failed: ${e.message}`);
    }
  }
  if (!candidates.length) throw new Error("no candidates generated");

  // 2) verify each on the train cases (real env + composite)
  let rolloutCount = 0;
  for (const c of candidates) {
    if (!c.skill.trim()) { c.mean = 0; c.judgeMean = 0; c.perCase = {}; continue; }
    const runDir = path.join(RUN_ROOT, `eval_cand${c.idx}`);
    console.error(`\n[bon] verifying candidate ${c.idx} ...`);
    const r = await scoreSkill({ skillText: c.skill, cases: TRAIN_CASES, provider: PROVIDER, runDir, baselineJudge: BASELINE_JUDGE, composite: true, concurrency: CONCURRENCY });
    rolloutCount += TRAIN_CASES.length;
    c.mean = r.composite?.composite ?? r.reward;
    c.judgeMean = r.judgeReward;
    c.advantage = r.advantage;
    c.perCase = {};
    for (const id of TRAIN_CASES) c.perCase[id] = r.composite?.perCase?.[id]?.composite ?? r.perCase?.[id] ?? 0;
    c.runDir = runDir;
    console.error(`[bon] candidate ${c.idx}: composite=${c.mean} judge=${c.judgeMean}`);
    fs.writeFileSync(path.join(RUN_ROOT, "results.json"), JSON.stringify({ category: CATEGORY, provider: PROVIDER, proposer: PROPOSER, n: N, rollouts: rolloutCount, proposerTokens: llm.totals.totalTokens, candidates: candidates.map(({ skill, ...rest }) => ({ ...rest, chars: skill.length })) }, null, 2));
  }

  // 3) keep the best by mean composite
  candidates.sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0));
  const best = candidates[0];
  fs.writeFileSync(path.join(RUN_ROOT, "BEST_SKILL.txt"), best.skill);
  console.error(`\n=== best-of-N done. best candidate ${best.idx}: composite=${best.mean} judge=${best.judgeMean} -> BEST_SKILL.txt`);
  console.error(`rollouts=${rolloutCount} proposerTokens=${llm.totals.totalTokens}`);
  console.log(JSON.stringify({ runRoot: RUN_ROOT, bestSkill: path.join(RUN_ROOT, "BEST_SKILL.txt"), bestMean: best.mean, bestJudge: best.judgeMean, rollouts: rolloutCount, proposerTokens: llm.totals.totalTokens }));
}

main().catch((e) => { console.error("[bon] ERROR", e?.stack || e?.message || String(e)); process.exit(1); });
