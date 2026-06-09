#!/usr/bin/env node
/**
 * opro.mjs — OPRO-style LLM-as-optimizer over the diagnostic skill text.
 *
 * OPRO (ICLR'24, 2309.03409): "Large Language Models as Optimizers." The LLM is the
 * optimizer; at each step it reads the *optimization trajectory* — a sorted list of
 * (solution, score) pairs seen so far — plus the task description, and PROPOSES a new
 * solution intended to score higher. No gradients, no weight updates; the frozen LLM
 * is asked to do the search by in-context meta-reasoning over its own history.
 *
 * Our instantiation (the "solution" is the skill SOP, the "score" is the composite
 * reward from the real environment):
 *   - The meta-prompt lists every previously-proposed SOP with its measured mean
 *     composite score (the optimization trajectory), ascending so the best is last
 *     (the format OPRO found works best), and asks for a NEW, different SOP that
 *     should score higher. The optimizer never sees ground truth or per-case traces —
 *     ONLY (skill text, scalar score) pairs, which is exactly OPRO's interface and is
 *     STRICTLY LESS information than GEPA (which reflects on the failed trace). That
 *     asymmetry is the point: OPRO optimizes the scalar; GEPA reflects on the trace.
 *   - Each proposal is EVALUATED on ALL train cases (real Siclaw + judge + composite),
 *     appended to the trajectory, and the best-by-mean-composite is kept and deployed.
 *
 * Budget accounting: rollouts = (1 seed + #steps) x (#train cases) — IDENTICAL to
 * GEPA's accounting (1 seed eval + GENERATIONS child evals). Match by --steps.
 *
 * Usage:
 *   node experiments/rl-skill-opt/baselines/opro.mjs \
 *     --category network-dns --train-cases c068,c069,c070,c071,c072,c073 \
 *     --provider gpt --optimizer gpt-5.4 --steps 5 \
 *     --baseline-judge experiments/rl-skill-opt/results-v2/gpt_baseline_train6/judgments.json \
 *     --seed-skill experiments/rl-skill-opt/skills/minimal-seed.txt \
 *     --examples-file experiments/rl-skill-opt/results-v2/opro_netdns/examples.json \
 *     --run-root experiments/rl-skill-opt/results-v2/opro_netdns
 */
import fs from "node:fs";
import path from "node:path";
import { LLM, cleanSkill } from "../llm-client.mjs";
import { scoreSkill } from "../score-skill.mjs";

function arg(name, fb) { const i = process.argv.indexOf(name); return i < 0 ? fb : process.argv[i + 1] ?? fb; }
const CATEGORY = arg("--category", "network-dns");
const TRAIN_CASES = arg("--train-cases", "").split(",").map((s) => s.trim()).filter(Boolean);
const PROVIDER = arg("--provider", "gpt");
const OPTIMIZER = arg("--optimizer", "gpt-5.4");
const STEPS = Number(arg("--steps", "5")); // # NEW proposals after the seed
const BASELINE_JUDGE = arg("--baseline-judge", "");
const SEED_SKILL = arg("--seed-skill", "");
const EXAMPLES_FILE = arg("--examples-file", "");
const RUN_ROOT = arg("--run-root", `experiments/rl-skill-opt/results-v2/opro_${CATEGORY}_${Date.now()}`);
const TEMPERATURE = Number(arg("--temperature", "1.0")); // OPRO uses high optimizer temp for exploration
const CONCURRENCY = arg("--concurrency", "3");
const TRAJ_KEEP = Number(arg("--traj-keep", "8")); // most-recent/best N pairs shown in the meta-prompt

if (!TRAIN_CASES.length) { console.error("Need --train-cases"); process.exit(2); }
fs.mkdirSync(RUN_ROOT, { recursive: true });

// The OPTIMIZER system role: it is told it is an optimizer searching the SOP space by
// reading (SOP, score) history. It must avoid tunnel-vision (same anti-hack framing as
// the other baselines so the comparison isolates the SEARCH operator, not the prompt).
const OPT_SYSTEM = (
  "You are an optimization engine searching for the best diagnostic SOP (skill) for an automated, " +
  "read-only Kubernetes diagnosis agent. You are shown the task and a trajectory of previously-tried " +
  "SOPs, each with the score it achieved on real incidents (higher is better). Reason about what the " +
  "higher-scoring SOPs did right and the lower-scoring ones did wrong, then produce ONE NEW SOP, " +
  "different from all previous ones, that you predict will score higher. A strong SOP enumerates ALL " +
  "plausible causes for the category and the order to check them (do not fixate on a single cause), " +
  "separates root cause from downstream symptoms, names the read-only checks, and states what a correct " +
  "diagnosis must contain. Output ONLY the new SOP text."
);

function metaPrompt(category, examples, trajectory) {
  const ex = examples.length ? examples.map((e, i) => `  Example incident ${i + 1}: ${e}`).join("\n") : "  (none)";
  // OPRO format: sort ASCENDING by score so the best candidates are nearest the task
  // (the paper reports the model attends most to the trajectory tail).
  const sorted = [...trajectory].sort((a, b) => a.score - b.score).slice(-TRAJ_KEEP);
  const hist = sorted.map((t, i) =>
    `--- Previous SOP #${i + 1} (measured score: ${t.score.toFixed(3)}) ---\n${t.skill}\n`).join("\n");
  return `TASK: write a general diagnostic SOP for the Kubernetes fault category "${category}".
Representative symptoms (these do NOT reveal the answer):
${ex}

OPTIMIZATION TRAJECTORY — SOPs already tried, with their measured scores (ascending; the
last is the best so far). Study why the higher-scoring SOPs outperformed the lower ones:

${hist}

Now write ONE NEW general SOP for "${category}" that should score HIGHER than every SOP above.
It must be a GENERAL category-wide procedure (no incident-specific names/IPs), give the ordered
read-only checks, separate root cause from symptom, and state what the diagnosis must name and a
safe remediation. Make it meaningfully different from the SOPs above (do not just paraphrase the
best one). 150-400 words. Output ONLY the new SOP text.`;
}

// seed SOP (cold-start) when no --seed-skill is given
const SEED_SYSTEM = (
  "You are an expert SRE who writes a concise, general diagnostic SOP (skill) for an automated, " +
  "read-only Kubernetes agent. Tell it which resources to inspect, in what order, how to separate " +
  "root cause from symptoms, and what a correct diagnosis must name."
);
function seedUser(category, examples) {
  const ex = examples.length ? examples.map((e, i) => `  Example incident ${i + 1}: ${e}`).join("\n") : "  (none)";
  return `Write ONE general diagnostic SOP for the fault category "${category}".
Representative symptoms (no answers revealed):\n${ex}
Give the ordered read-only checks, how to tell root cause from symptom, and what a correct
diagnosis must name. 150-400 words. No incident-specific names. Output ONLY the SOP text.`;
}

async function evalSkill(skill, tag) {
  const runDir = path.join(RUN_ROOT, "evals", tag);
  const r = await scoreSkill({
    skillText: skill, cases: TRAIN_CASES, provider: PROVIDER, runDir,
    baselineJudge: BASELINE_JUDGE, composite: true, concurrency: CONCURRENCY,
  });
  const perCase = {};
  for (const id of TRAIN_CASES) perCase[id] = r.composite?.perCase?.[id]?.composite ?? r.perCase?.[id] ?? 0;
  return { runDir, mean: r.composite?.composite ?? r.reward, judgeMean: r.judgeReward, perCase };
}

function writeOut(trajectory, llm, rolloutCount) {
  fs.writeFileSync(path.join(RUN_ROOT, "trajectory.json"), JSON.stringify({
    category: CATEGORY, provider: PROVIDER, optimizer: OPTIMIZER, trainCases: TRAIN_CASES,
    steps: STEPS, rollouts: rolloutCount, optimizerTokens: llm.totals.totalTokens, optimizerCalls: llm.totals.calls,
    trajectory: trajectory.map((t) => ({ step: t.step, id: t.id, score: t.score, judgeMean: t.judgeMean, chars: t.skill.length, perCase: t.perCase })),
  }, null, 2));
  for (const t of trajectory) fs.writeFileSync(path.join(RUN_ROOT, `cand_${t.id}.txt`), t.skill);
}

async function main() {
  const examples = EXAMPLES_FILE && fs.existsSync(EXAMPLES_FILE) ? JSON.parse(fs.readFileSync(EXAMPLES_FILE, "utf8")) : [];
  const llm = new LLM();
  console.error(`=== OPRO  category=${CATEGORY} provider=${PROVIDER} optimizer=${OPTIMIZER} steps=${STEPS} train=${TRAIN_CASES.join(",")} ===`);

  const trajectory = [];
  let rolloutCount = 0;

  // ── seed the trajectory ──
  let seedSkill;
  if (SEED_SKILL && fs.existsSync(SEED_SKILL)) {
    seedSkill = fs.readFileSync(SEED_SKILL, "utf8").trim();
    console.error(`[opro] seeding trajectory from ${SEED_SKILL} (${seedSkill.length} chars)`);
  } else {
    const { text } = await llm.chat({ model: OPTIMIZER, system: SEED_SYSTEM, user: seedUser(CATEGORY, examples), temperature: 0.6, maxTokens: 1100 });
    seedSkill = cleanSkill(text);
    console.error(`[opro] seeded a fresh SOP via optimizer (${seedSkill.length} chars)`);
  }
  const seedEval = await evalSkill(seedSkill, "step0_seed");
  rolloutCount += TRAIN_CASES.length;
  trajectory.push({ step: 0, id: "step0_seed", skill: seedSkill, score: seedEval.mean, judgeMean: seedEval.judgeMean, perCase: seedEval.perCase });
  console.error(`[opro] step0 seed: composite=${seedEval.mean} judge=${seedEval.judgeMean} perCase=${JSON.stringify(seedEval.perCase)}`);
  writeOut(trajectory, llm, rolloutCount);

  // ── optimizer steps: read (SOP,score) trajectory, propose a higher-scoring SOP ──
  for (let step = 1; step <= STEPS; step++) {
    console.error(`\n[opro] step${step}: optimizer proposing from trajectory of ${trajectory.length} (best so far=${Math.max(...trajectory.map((t) => t.score)).toFixed(3)})`);
    let child;
    try {
      const { text } = await llm.chat({
        model: OPTIMIZER, system: OPT_SYSTEM,
        user: metaPrompt(CATEGORY, examples, trajectory),
        temperature: TEMPERATURE, maxTokens: 1200,
      });
      child = cleanSkill(text);
    } catch (e) {
      console.error(`[opro] optimizer failed step${step}: ${e.message}; skipping (no rollouts spent)`);
      continue;
    }
    if (!child || child.length < 40) { console.error(`[opro] proposal too short; skip`); continue; }

    const childEval = await evalSkill(child, `step${step}_cand`);
    rolloutCount += TRAIN_CASES.length;
    trajectory.push({ step, id: `step${step}_cand`, skill: child, score: childEval.mean, judgeMean: childEval.judgeMean, perCase: childEval.perCase });
    console.error(`[opro] step${step} cand: composite=${childEval.mean} judge=${childEval.judgeMean} perCase=${JSON.stringify(childEval.perCase)}`);
    writeOut(trajectory, llm, rolloutCount);
  }

  writeOut(trajectory, llm, rolloutCount);
  // deployable = best mean composite across the whole trajectory
  const best = trajectory.reduce((a, b) => (b.score > a.score ? b : a), trajectory[0]);
  fs.writeFileSync(path.join(RUN_ROOT, "BEST_SKILL.txt"), best.skill);
  console.error(`\n=== OPRO done. trajectory=${trajectory.length}. best mean composite=${best.score} (${best.id}) -> BEST_SKILL.txt`);
  console.error(`rollouts=${rolloutCount} optimizerTokens=${llm.totals.totalTokens} optimizerCalls=${llm.totals.calls}`);
  console.log(JSON.stringify({ runRoot: RUN_ROOT, bestSkill: path.join(RUN_ROOT, "BEST_SKILL.txt"), bestMean: best.score, trajLen: trajectory.length, rollouts: rolloutCount, optimizerTokens: llm.totals.totalTokens }));
}

main().catch((e) => { console.error("[opro] ERROR", e?.stack || e?.message || String(e)); process.exit(1); });
