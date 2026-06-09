#!/usr/bin/env node
/**
 * eval-matrix.mjs — evaluate ONE skill (or no-skill) across the standard
 * evaluation sets used by the headline table, sequentially (to avoid overloading
 * the shared cluster). Writes one reward.json per set under <out-root>/<set>.
 *
 *   sets:
 *     train      c068..c073   (gpt brain)        — training cases
 *     heldout    c074..c077   (gpt brain)        — held-out within category
 *     audit      ca1..ca3     (gpt brain)        — adversarial anti-DNS audit
 *     xbrain     c074..c077   (kimi brain)       — cross-brain transfer
 *
 * Usage:
 *   node experiments/rl-skill-opt/eval-matrix.mjs --label handcrafted \
 *     --skill-file experiments/rl-skill-opt/skills/network-dns-handcrafted.txt \
 *     --out-root experiments/rl-skill-opt/results-v2/eval/handcrafted \
 *     [--sets heldout,audit,xbrain] [--baseline-root <dir with per-set baselines>]
 *
 * --baseline-root <dir>: if given, each set's advantage is computed vs
 *   <dir>/<set>/judgments.json (the no-skill baseline for that set).
 */
import fs from "node:fs";
import path from "node:path";
import { scoreSkill } from "./score-skill.mjs";

function arg(name, fb) { const i = process.argv.indexOf(name); return i < 0 ? fb : process.argv[i + 1] ?? fb; }
const LABEL = arg("--label", "skill");
const SKILL_FILE = arg("--skill-file", "");
const OUT_ROOT = arg("--out-root", `experiments/rl-skill-opt/results-v2/eval/${LABEL}`);
const SETS = arg("--sets", "heldout,audit,xbrain").split(",").map((s) => s.trim()).filter(Boolean);
const BASELINE_ROOT = arg("--baseline-root", "");
const CONCURRENCY = arg("--concurrency", "3");

const AUDIT_CASES = "experiments/rl-skill-opt/audit/audit-cases.json";
const AUDIT_PROMPTS = "experiments/rl-skill-opt/audit/prompts";

const SET_DEFS = {
  train: { cases: ["c068", "c069", "c070", "c071", "c072", "c073"], provider: "gpt" },
  heldout: { cases: ["c074", "c075", "c076", "c077"], provider: "gpt" },
  audit: { cases: ["ca1", "ca2", "ca3"], provider: "gpt", casesFile: AUDIT_CASES, promptDir: AUDIT_PROMPTS },
  xbrain: { cases: ["c074", "c075", "c076", "c077"], provider: "kimi" },
};

async function main() {
  const skillText = SKILL_FILE && fs.existsSync(SKILL_FILE) ? fs.readFileSync(SKILL_FILE, "utf8") : "";
  console.error(`=== eval-matrix label=${LABEL} skill=${SKILL_FILE || "(none)"} chars=${skillText.length} sets=${SETS.join(",")} ===`);
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const summary = { label: LABEL, skillFile: SKILL_FILE || null, skillChars: skillText.length, sets: {} };

  for (const set of SETS) {
    const def = SET_DEFS[set];
    if (!def) { console.error(`unknown set ${set}, skipping`); continue; }
    const runDir = path.join(OUT_ROOT, set);
    const baselineJudge = BASELINE_ROOT ? path.join(BASELINE_ROOT, set, "judgments.json") : "";
    console.error(`\n--- eval set=${set} provider=${def.provider} cases=${def.cases.join(",")} ---`);
    let r;
    try {
      r = await scoreSkill({
        skillText, cases: def.cases, provider: def.provider, runDir,
        casesFile: def.casesFile, promptDir: def.promptDir,
        baselineJudge: baselineJudge && fs.existsSync(baselineJudge) ? baselineJudge : "",
        composite: true, concurrency: CONCURRENCY,
      });
    } catch (e) {
      console.error(`  set ${set} FAILED: ${e.message}`);
      summary.sets[set] = { error: String(e).slice(0, 200) };
      continue;
    }
    summary.sets[set] = {
      composite: r.composite?.composite ?? r.reward,
      judge: r.judgeReward,
      rubricMean: r.composite?.rubricMean,
      rewardTruthGap: r.composite?.rewardTruthGap,
      mislabelRate: r.composite?.mislabelRate,
      spuriousMean: r.composite?.spuriousMean,
      passRate: r.passRate,
      advantage: r.advantage,
      perCaseJudge: r.perCase,
      perCaseComposite: Object.fromEntries(def.cases.map((id) => [id, r.composite?.perCase?.[id]?.composite ?? null])),
      tokens: r.tokens?.total,
      provider: def.provider,
    };
    console.error(`  set ${set}: composite=${summary.sets[set].composite} judge=${summary.sets[set].judge} mislabel=${summary.sets[set].mislabelRate} adv=${summary.sets[set].advantage}`);
    fs.writeFileSync(path.join(OUT_ROOT, "summary.json"), JSON.stringify(summary, null, 2));
  }
  fs.writeFileSync(path.join(OUT_ROOT, "summary.json"), JSON.stringify(summary, null, 2));
  console.error(`\n=== eval-matrix done -> ${path.join(OUT_ROOT, "summary.json")}`);
  console.log(JSON.stringify({ label: LABEL, sets: Object.fromEntries(Object.entries(summary.sets).map(([k, v]) => [k, v.composite ?? null])) }));
}

main().catch((e) => { console.error("[eval-matrix] ERROR", e?.stack || e?.message || String(e)); process.exit(1); });
