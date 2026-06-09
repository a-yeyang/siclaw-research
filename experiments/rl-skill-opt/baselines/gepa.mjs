#!/usr/bin/env node
/**
 * gepa.mjs — GEPA-style reflective Pareto evolution of the diagnostic skill.
 *
 * GEPA (ICLR'26 oral, 2507.19457): training-free prompt optimization that beats
 * GRPO with up to 35x fewer rollouts by (1) REFLECTING on a failed execution trace
 * in natural language to propose a TARGETED edit to the prompt/skill, and (2)
 * keeping a PARETO FRONT of candidates — the best skill PER training instance, not
 * one global winner — which preserves diversity and prevents mode-collapse.
 *
 * Our instantiation (the "skill" is the unit being optimized):
 *   - Seed the front with a minimal SOP (or --seed-skill, e.g. the hand-crafted one
 *     as behavioural prior) AND the no-skill empty string baseline is the floor.
 *   - Each generation:
 *       a. SELECT a parent from the Pareto front (round-robin over the instances
 *          where the front is weakest — GEPA samples by per-instance need).
 *       b. Pick a training case where the parent scored LOW; pull its real trace.
 *       c. REFLECT: ask the reflector LLM to read {skill, case symptom, the agent's
 *          actual trace + diagnosis, the verifiable rubric result} and propose a
 *          REVISED skill that fixes the observed failure WITHOUT overfitting to
 *          this one case (it never sees ground truth — only the symptom + trace).
 *       d. EVALUATE the child on ALL training cases (real Siclaw + judge + composite).
 *       e. UPDATE the Pareto front: keep the child if it is non-dominated on any
 *          instance; recompute the per-instance best.
 *   - Output: the front member with the best MEAN composite (the deployable skill),
 *     plus the full front for the cross-brain/held-out comparison.
 *
 * Budget accounting: rollouts = (#candidates evaluated) x (#train cases). We cap
 * candidates with --generations so the budget is MATCHED to the RL method.
 *
 * Usage:
 *   node experiments/rl-skill-opt/baselines/gepa.mjs \
 *     --category network-dns --train-cases c068,c069,c070,c071,c072,c073 \
 *     --provider gpt --reflector gpt-5.4 --generations 6 \
 *     --baseline-judge <no-skill judgments.json> \
 *     --seed-skill experiments/rl-skill-opt/skills/minimal-seed.txt \
 *     --run-root experiments/rl-skill-opt/results-v2/gepa_netdns
 */
import fs from "node:fs";
import path from "node:path";
import { LLM, cleanSkill } from "../llm-client.mjs";
import { scoreSkill } from "../score-skill.mjs";

function arg(name, fb) { const i = process.argv.indexOf(name); return i < 0 ? fb : process.argv[i + 1] ?? fb; }
const CATEGORY = arg("--category", "network-dns");
const TRAIN_CASES = arg("--train-cases", "").split(",").map((s) => s.trim()).filter(Boolean);
const PROVIDER = arg("--provider", "gpt");
const REFLECTOR = arg("--reflector", "gpt-5.4");
const GENERATIONS = Number(arg("--generations", "6"));
const BASELINE_JUDGE = arg("--baseline-judge", "");
const SEED_SKILL = arg("--seed-skill", "");
const EXAMPLES_FILE = arg("--examples-file", "");
const RUN_ROOT = arg("--run-root", `experiments/rl-skill-opt/results-v2/gepa_${CATEGORY}_${Date.now()}`);
const TEMPERATURE = Number(arg("--temperature", "0.8"));
const CONCURRENCY = arg("--concurrency", "3");

if (!TRAIN_CASES.length) { console.error("Need --train-cases"); process.exit(2); }
fs.mkdirSync(RUN_ROOT, { recursive: true });

const REFLECT_SYSTEM = (
  "You are an expert SRE who IMPROVES a diagnostic SOP (skill) for an automated, read-only " +
  "Kubernetes agent by reflecting on a real failed investigation. You are given the current " +
  "SOP, an incident symptom, the agent's ACTUAL trace and final diagnosis, and an automatic " +
  "rubric saying what the agent missed. Diagnose WHY the SOP let the agent go wrong, then " +
  "rewrite the SOP so a future agent would investigate correctly. You never see the ground " +
  "truth — infer the right procedure from the trace. Do NOT hard-code this incident's specific " +
  "names; keep the SOP a GENERAL procedure for the whole category. Avoid tunnel-vision: a good " +
  "SOP enumerates ALL plausible causes (and the order to check them) rather than fixating on one."
);

const SEED_SYSTEM = (
  "You are an expert SRE who writes a concise, general diagnostic SOP (skill) for an automated, " +
  "read-only Kubernetes agent. Tell it which resources to inspect, in what order, how to separate " +
  "root cause from symptoms, and what a correct diagnosis must name."
);

function reflectUser(skill, caseObj, trace, comp) {
  const cmds = (trace?.toolCalls || []).map((t) => {
    let a = t.args; if (typeof a !== "string") { try { a = JSON.stringify(a); } catch { a = ""; } }
    return `  - ${t.toolName}: ${String(a).replace(/\s+/g, " ").slice(0, 140)}`;
  }).join("\n");
  const rub = comp?.rubric
    ? `enumeratedNetworkPolicies=${comp.rubric.enumeratedNetworkPolicies}, inspectedDnsConfig=${comp.rubric.inspectedDnsConfig}, ` +
      `rootCauseClassCorrect=${comp.rubric.rootCauseClassCorrect} (the agent diagnosed class "${comp.rubric.predictedClass}"; ` +
      `the automatic check thinks the correct class is "${comp.rubric.trueClass}")` +
      (comp.spuriousPenalty?.value ? `; SPURIOUS-CUE PENALTY fired: ${comp.spuriousPenalty.reason}` : "")
    : "(no rubric available)";
  return `CURRENT SOP (skill) being improved:
"""
${skill || "(empty — there is no SOP yet; write one from scratch)"}
"""

A real incident the agent handled poorly under this SOP.
INCIDENT SYMPTOM (all the agent was told): ${caseObj.symptom}

THE AGENT'S ACTUAL INVESTIGATION (ordered tool calls):
${cmds || "  (no tool calls recorded)"}

THE AGENT'S FINAL DIAGNOSIS (verbatim):
"""
${(trace?.finalText || "(empty)").slice(0, 2000)}
"""

AUTOMATIC RUBRIC ON THIS ATTEMPT (judge score ${comp?.judgeScore ?? "?"} / 1.0): ${rub}

TASK: The agent scored poorly here. Reflect on what the SOP failed to make the agent do
(wrong check order? fixated on one cause class and ignored another? concluded before
enumerating the real culprit?), then OUTPUT A REVISED SOP that would fix this class of
mistake while staying a GENERAL category-wide procedure (no incident-specific names).
150-400 words. Output ONLY the revised SOP text.`;
}

function seedUser(category, examples) {
  const ex = examples.length ? examples.map((e, i) => `  Example incident ${i + 1}: ${e}`).join("\n") : "  (none)";
  return `Write ONE general diagnostic SOP for the fault category "${category}".
Representative symptoms (no answers revealed):\n${ex}
Give the ordered read-only checks, how to tell root cause from symptom, and what a correct
diagnosis must name. 150-400 words. No incident-specific names. Output ONLY the SOP text.`;
}

// Pareto front: list of { id, skill, perCase:{caseId->composite}, mean }
function perInstanceBest(front, ids) {
  const best = {};
  for (const id of ids) {
    let bv = -Infinity, bi = null;
    for (const m of front) { const v = m.perCase[id] ?? -Infinity; if (v > bv) { bv = v; bi = m; } }
    best[id] = { value: bv, member: bi };
  }
  return best;
}

function isNonDominated(child, front, ids) {
  // child is kept if NO existing member is >= on every instance and > on at least one
  for (const m of front) {
    let geAll = true, gtAny = false;
    for (const id of ids) {
      const mv = m.perCase[id] ?? -Infinity, cv = child.perCase[id] ?? -Infinity;
      if (mv < cv) geAll = false;
      if (mv > cv) gtAny = true;
    }
    if (geAll && gtAny) return false; // dominated by m
  }
  return true;
}

async function evalSkill(skill, tag) {
  const runDir = path.join(RUN_ROOT, "evals", tag);
  const r = await scoreSkill({
    skillText: skill, cases: TRAIN_CASES, provider: PROVIDER, runDir,
    baselineJudge: BASELINE_JUDGE, composite: true, concurrency: CONCURRENCY,
  });
  const perCase = {};
  for (const id of TRAIN_CASES) perCase[id] = r.composite?.perCase?.[id]?.composite ?? r.perCase?.[id] ?? 0;
  return { runDir, mean: r.composite?.composite ?? r.reward, judgeMean: r.judgeReward, perCase, reward: r };
}

async function main() {
  const examples = EXAMPLES_FILE && fs.existsSync(EXAMPLES_FILE) ? JSON.parse(fs.readFileSync(EXAMPLES_FILE, "utf8")) : [];
  const allCases = JSON.parse(fs.readFileSync("experiments/siclaw-agent-eval/cases/cases.json", "utf8"));
  const byId = Object.fromEntries(allCases.map((c) => [c.id, c]));
  const llm = new LLM();
  console.error(`=== GEPA  category=${CATEGORY} provider=${PROVIDER} reflector=${REFLECTOR} generations=${GENERATIONS} train=${TRAIN_CASES.join(",")} ===`);

  const front = [];
  const log = [];
  let rolloutCount = 0;

  // ── seed the front ──
  let seedSkill;
  if (SEED_SKILL && fs.existsSync(SEED_SKILL)) {
    seedSkill = fs.readFileSync(SEED_SKILL, "utf8").trim();
    console.error(`[gepa] seeding from ${SEED_SKILL} (${seedSkill.length} chars, behavioural prior)`);
  } else {
    const { text } = await llm.chat({ model: REFLECTOR, system: SEED_SYSTEM, user: seedUser(CATEGORY, examples), temperature: 0.6, maxTokens: 1100 });
    seedSkill = cleanSkill(text);
    console.error(`[gepa] seeded a fresh SOP via reflector (${seedSkill.length} chars)`);
  }
  const seedEval = await evalSkill(seedSkill, "gen0_seed");
  rolloutCount += TRAIN_CASES.length;
  front.push({ id: "gen0_seed", skill: seedSkill, perCase: seedEval.perCase, mean: seedEval.mean, judgeMean: seedEval.judgeMean });
  log.push({ gen: 0, action: "seed", id: "gen0_seed", mean: seedEval.mean, judgeMean: seedEval.judgeMean, perCase: seedEval.perCase, chars: seedSkill.length });
  console.error(`[gepa] gen0 seed: composite=${seedEval.mean} judge=${seedEval.judgeMean} perCase=${JSON.stringify(seedEval.perCase)}`);

  // ── reflective generations ──
  for (let gen = 1; gen <= GENERATIONS; gen++) {
    // select the weakest instance across the front, and the front member that is
    // currently best on it (the parent to improve).
    const pib = perInstanceBest(front, TRAIN_CASES);
    let weakId = TRAIN_CASES[0], weakV = Infinity;
    for (const id of TRAIN_CASES) { if (pib[id].value < weakV) { weakV = pib[id].value; weakId = id; } }
    // parent = the member that scores lowest on weakId among those that aren't already maxed
    let parent = front.reduce((a, b) => ((b.perCase[weakId] ?? 0) < (a.perCase[weakId] ?? 0) ? b : a), front[0]);
    // get the parent's real trace on the weak case (already produced during its eval)
    const parentEvalTag = parent.id;
    const tracePath = path.join(RUN_ROOT, "evals", parentEvalTag, "traces", weakId, "result.json");
    let trace = null;
    try { trace = JSON.parse(fs.readFileSync(tracePath, "utf8")); } catch {}
    // recover the composite breakdown for that case from the parent's reward.json
    let comp = null;
    try {
      const rj = JSON.parse(fs.readFileSync(path.join(RUN_ROOT, "evals", parentEvalTag, "reward.json"), "utf8"));
      comp = rj.composite?.perCase?.[weakId] ?? null;
    } catch {}

    console.error(`\n[gepa] gen${gen}: improving on weak case ${weakId} (parent ${parent.id} scored ${parent.perCase[weakId]})`);
    let child;
    try {
      const { text } = await llm.chat({
        model: REFLECTOR, system: REFLECT_SYSTEM,
        user: reflectUser(parent.skill, byId[weakId], trace, comp),
        temperature: TEMPERATURE, maxTokens: 1200,
      });
      child = cleanSkill(text);
    } catch (e) {
      console.error(`[gepa] reflector failed gen${gen}: ${e.message}; skipping`);
      log.push({ gen, action: "reflect-failed", weakId, error: String(e).slice(0, 200) });
      continue;
    }
    if (!child || child.length < 40) { console.error(`[gepa] child too short; skip`); continue; }

    const childEval = await evalSkill(child, `gen${gen}_child`);
    rolloutCount += TRAIN_CASES.length;
    const member = { id: `gen${gen}_child`, skill: child, perCase: childEval.perCase, mean: childEval.mean, judgeMean: childEval.judgeMean };
    const kept = isNonDominated(member, front, TRAIN_CASES);
    if (kept) {
      // prune now-dominated members
      const survivors = front.filter((m) => {
        let geAll = true, gtAny = false;
        for (const id of TRAIN_CASES) {
          const mv = member.perCase[id] ?? -Infinity, cv = m.perCase[id] ?? -Infinity;
          if (mv < cv) geAll = false;
          if (mv > cv) gtAny = true;
        }
        return !(geAll && gtAny); // drop m if member dominates it
      });
      survivors.push(member);
      front.length = 0; front.push(...survivors);
    }
    log.push({ gen, action: "reflect", weakId, parent: parent.id, id: member.id, mean: member.mean, judgeMean: member.judgeMean, kept, perCase: member.perCase, chars: child.length, frontSize: front.length });
    console.error(`[gepa] gen${gen} child: composite=${member.mean} judge=${member.judgeMean} kept=${kept} frontSize=${front.length} perCase=${JSON.stringify(member.perCase)}`);

    // persist progress each generation
    writeOut(front, log, llm, rolloutCount);
  }

  writeOut(front, log, llm, rolloutCount);
  // deployable = best mean composite on the front
  const best = front.reduce((a, b) => (b.mean > a.mean ? b : a), front[0]);
  fs.writeFileSync(path.join(RUN_ROOT, "BEST_SKILL.txt"), best.skill);
  console.error(`\n=== GEPA done. front=${front.length} members. best mean composite=${best.mean} (${best.id}) -> BEST_SKILL.txt`);
  console.error(`rollouts=${rolloutCount} reflectorTokens=${llm.totals.totalTokens} reflectorCalls=${llm.totals.calls}`);
  console.log(JSON.stringify({ runRoot: RUN_ROOT, bestSkill: path.join(RUN_ROOT, "BEST_SKILL.txt"), bestMean: best.mean, frontSize: front.length, rollouts: rolloutCount, reflectorTokens: llm.totals.totalTokens }));
}

function writeOut(front, log, llm, rolloutCount) {
  fs.writeFileSync(path.join(RUN_ROOT, "front.json"), JSON.stringify(front.map((m) => ({ id: m.id, mean: m.mean, judgeMean: m.judgeMean, perCase: m.perCase, chars: m.skill.length })), null, 2));
  for (const m of front) fs.writeFileSync(path.join(RUN_ROOT, `front_${m.id}.txt`), m.skill);
  fs.writeFileSync(path.join(RUN_ROOT, "gepa_log.json"), JSON.stringify({ category: CATEGORY, provider: PROVIDER, reflector: REFLECTOR, trainCases: TRAIN_CASES, generations: GENERATIONS, rollouts: rolloutCount, reflectorTokens: llm.totals.totalTokens, reflectorCalls: llm.totals.calls, log }, null, 2));
}

main().catch((e) => { console.error("[gepa] ERROR", e?.stack || e?.message || String(e)); process.exit(1); });
