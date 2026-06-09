#!/usr/bin/env node
/**
 * analyze.mjs — aggregate ALL v2 results into the headline comparison, bootstrap
 * CIs, reward-hacking diagnostics, and collapse diagnostics. Reads the eval-matrix
 * summaries + per-set reward.json + the RL trajectories, recomputes the composite
 * per case from the raw traces+judgments (so the rubric is uniform), and emits:
 *   - results-v2/ANALYSIS.json  (machine-readable everything)
 *   - a console table for pasting into RESULTS-v2.md.
 *
 * Bootstrap CI: per evaluation set we have per-case composite scores; when ≥3 seeds
 * exist for a method we bootstrap over the seed means; otherwise we bootstrap over
 * the per-case scores (case-resampling) and label it as such.
 *
 * Usage: node experiments/rl-skill-opt/analyze.mjs [--root experiments/rl-skill-opt/results-v2]
 */
import fs from "node:fs";
import path from "node:path";
import { aggregateComposite } from "./composite-reward.mjs";

function arg(name, fb) { const i = process.argv.indexOf(name); return i < 0 ? fb : process.argv[i + 1] ?? fb; }
const ROOT = arg("--root", "experiments/rl-skill-opt/results-v2");
const ALL_CASES = JSON.parse(fs.readFileSync("experiments/siclaw-agent-eval/cases/cases.json", "utf8"));
const AUDIT_CASES = fs.existsSync("experiments/rl-skill-opt/audit/audit-cases.json")
  ? JSON.parse(fs.readFileSync("experiments/rl-skill-opt/audit/audit-cases.json", "utf8")) : [];
const CASE_BY_ID = Object.fromEntries([...ALL_CASES, ...AUDIT_CASES].map((c) => [c.id, c]));

// ── recompute composite per-case from a run dir (traces + judgments) ──
function recomputeSet(runDir) {
  const judgePath = path.join(runDir, "judgments.json");
  const tracesDir = path.join(runDir, "traces");
  if (!fs.existsSync(judgePath)) return null;
  const judge = JSON.parse(fs.readFileSync(judgePath, "utf8"));
  const perCaseJudge = {}, tracesById = {};
  for (const j of judge) {
    perCaseJudge[j.caseId] = j.totalScore ?? 0;
    const tp = path.join(tracesDir, j.caseId, "result.json");
    if (fs.existsSync(tp)) { try { tracesById[j.caseId] = JSON.parse(fs.readFileSync(tp, "utf8")); } catch {} }
  }
  const agg = aggregateComposite(perCaseJudge, tracesById, CASE_BY_ID);
  agg.perCaseComposite = Object.fromEntries(Object.entries(agg.perCase).map(([k, v]) => [k, v.composite]));
  agg.perCaseJudge = perCaseJudge;
  return agg;
}

// ── bootstrap CI over an array of scalars ──
function bootstrapCI(values, iters = 5000, alpha = 0.05) {
  if (!values.length) return { mean: null, lo: null, hi: null, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const means = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < values.length; i++) s += values[Math.floor(Math.random() * values.length)];
    means.push(s / values.length);
  }
  means.sort((a, b) => a - b);
  return {
    mean: Math.round(mean * 1000) / 1000,
    lo: Math.round(means[Math.floor(alpha / 2 * iters)] * 1000) / 1000,
    hi: Math.round(means[Math.floor((1 - alpha / 2) * iters)] * 1000) / 1000,
    n: values.length,
  };
}

// paired bootstrap: P(method - baseline > 0) style; returns mean diff + CI
function pairedBootstrapDiff(a, b, iters = 5000) {
  // a,b are per-case arrays aligned by index
  const n = Math.min(a.length, b.length);
  if (!n) return null;
  const diffs = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) { const k = Math.floor(Math.random() * n); s += a[k] - b[k]; }
    diffs.push(s / n);
  }
  diffs.sort((x, y) => x - y);
  const md = a.slice(0, n).reduce((s, v, i) => s + (v - b[i]), 0) / n;
  return { meanDiff: Math.round(md * 1000) / 1000, lo: Math.round(diffs[Math.floor(0.025 * iters)] * 1000) / 1000, hi: Math.round(diffs[Math.floor(0.975 * iters)] * 1000) / 1000 };
}

// ── discover method eval dirs ──
function evalDir(label) { return path.join(ROOT, "eval", label); }
function hasEval(label) { return fs.existsSync(path.join(evalDir(label), "summary.json")) || fs.existsSync(path.join(evalDir(label), "heldout")); }

const SETS = ["train", "heldout", "audit", "xbrain"];

function methodRow(label, seedLabels = null) {
  // seedLabels: for multi-seed methods, the list of eval dir labels (one per seed)
  const row = { label, sets: {} };
  for (const set of SETS) {
    if (seedLabels && seedLabels.length) {
      // multi-seed: recompute each seed's set, bootstrap over seed means
      const seedMeans = [], perCaseAll = [];
      let mislabel = [], gap = [], judge = [], rubric = [], spur = [];
      for (const sl of seedLabels) {
        const rd = path.join(evalDir(sl), set);
        const agg = recomputeSet(rd);
        if (!agg) continue;
        seedMeans.push(agg.composite);
        judge.push(agg.judgeMean); rubric.push(agg.rubricMean); gap.push(agg.rewardTruthGap);
        mislabel.push(agg.mislabelRate); spur.push(agg.spuriousMean);
        perCaseAll.push(...Object.values(agg.perCaseComposite));
      }
      const ci = bootstrapCI(seedMeans);
      row.sets[set] = { ...ci, basis: "seeds", judge: meanOf(judge), rubric: meanOf(rubric), rewardTruthGap: meanOf(gap), mislabelRate: meanOf(mislabel), spuriousMean: meanOf(spur), seedMeans };
    } else {
      const rd = path.join(evalDir(label), set);
      const agg = recomputeSet(rd);
      if (!agg) { row.sets[set] = null; continue; }
      const ci = bootstrapCI(Object.values(agg.perCaseComposite));
      row.sets[set] = { ...ci, basis: "cases", judge: agg.judgeMean, rubric: agg.rubricMean, rewardTruthGap: agg.rewardTruthGap, mislabelRate: agg.mislabelRate, spuriousMean: agg.spuriousMean, perCaseComposite: agg.perCaseComposite };
    }
  }
  return row;
}

function meanOf(xs) { const v = xs.filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null; }

// ── Pass@k + collapse diagnostics from RL trajectories ──
function collapseDiag(runRoot, kind) {
  const tp = path.join(runRoot, "trajectory.json");
  if (!fs.existsSync(tp)) return null;
  const traj = JSON.parse(fs.readFileSync(tp, "utf8"));
  const rounds = (traj.trajectory || []).map((r) => {
    // Pass@k over the round's candidates: fraction of (candidate,case) that "passed"
    // (composite > 0.65 proxy threshold scaled: judge passed ~ composite >= ~1.0).
    const perCand = r.perCandPerCase || [];
    const passAt = (k) => {
      // for each train case, did ANY of the top-k candidates (by reward) solve it (composite>=1.0)?
      const cases = new Set();
      perCand.forEach((c) => Object.keys(c.perCase || {}).forEach((id) => cases.add(id)));
      const topk = [...perCand].sort((a, b) => (b.reward ?? 0) - (a.reward ?? 0)).slice(0, k);
      let solved = 0; const ids = [...cases];
      for (const id of ids) { if (topk.some((c) => (c.perCase?.[id] ?? 0) >= 1.0)) solved++; }
      return ids.length ? Math.round((solved / ids.length) * 1000) / 1000 : null;
    };
    return {
      round: r.round, meanReward: r.meanReward, bestReward: r.bestReward,
      rewardSpread: r.rewards ? Math.round((Math.max(...r.rewards) - Math.min(...r.rewards)) * 1000) / 1000 : null,
      diversity: r.diversity || null,
      passAt1: passAt(1), passAt4: passAt(4), passAt8: passAt(8),
    };
  });
  return { kind, runRoot, rounds, model: traj.model, provider: traj.provider, prior: traj.prior };
}

function main() {
  const analysis = { generatedAt: new Date().toISOString(), root: ROOT, methods: {}, comparisons: {}, collapse: {}, budgets: {} };

  // anchor + single-instance methods (each = one deployed skill evaluated across sets).
  // bon=best-of-N+verifier, opro=OPRO LLM-as-optimizer, dspy=DSPy/MIPROv2, refl=reflective
  // writer — the matched-budget ladder rungs; present only if their eval dir exists.
  const singleMethods = ["noskill", "handcrafted", "foa", "bon", "opro", "dspy", "refl", "raft"];
  for (const m of singleMethods) if (hasEval(m)) analysis.methods[m] = methodRow(m);

  // GEPA (single front, evaluated once) — label gepa
  if (hasEval("gepa")) analysis.methods["gepa"] = methodRow("gepa");

  // GRPO (ours): the matched-budget evaluation ensemble. With independent random
  // seeds (grpo_s1, grpo_s2, ...) these are seed means. When the GPU could only
  // train one seed, we additionally treat the per-round best skills of that seed
  // (grpo_s1, grpo_s1_r1, grpo_s1_r2 — each a DISTINCT trained-adapter checkpoint at
  // matched rollout budget) as the spread; this is a training-trajectory ensemble,
  // not independent seeds, and is labelled as such in the output.
  const grpoSeeds = fs.existsSync(path.join(ROOT, "eval")) ? fs.readdirSync(path.join(ROOT, "eval")).filter((d) => /^grpo_s\d+$/.test(d)) : [];
  const grpoCkpts = fs.existsSync(path.join(ROOT, "eval")) ? fs.readdirSync(path.join(ROOT, "eval")).filter((d) => /^grpo_s\d+(_r\d+)?$/.test(d)) : [];
  const grpoEvalDirs = grpoSeeds.length >= 3 ? grpoSeeds : grpoCkpts; // prefer real seeds if ≥3
  const grpoBasisNote = grpoSeeds.length >= 3 ? "seeds" : `trajectory-ckpts(${grpoEvalDirs.length})`;
  if (grpoEvalDirs.length) { analysis.methods["grpo"] = methodRow("grpo", grpoEvalDirs); analysis.methods["grpo"].basisNote = grpoBasisNote; analysis.methods["grpo"].evalDirs = grpoEvalDirs; }

  // also seed-wise GEPA if present (gepa_s1..)
  const gepaSeeds = fs.existsSync(path.join(ROOT, "eval")) ? fs.readdirSync(path.join(ROOT, "eval")).filter((d) => /^gepa_s\d+$/.test(d)) : [];
  if (gepaSeeds.length) analysis.methods["gepa_multiseed"] = methodRow("gepa_multiseed", gepaSeeds);

  // ── pre-registered comparison: ours vs GEPA on held-out + xbrain ──
  for (const set of ["heldout", "xbrain", "audit"]) {
    const ours = analysis.methods["grpo"]?.sets?.[set];
    const gepa = (analysis.methods["gepa_multiseed"] || analysis.methods["gepa"])?.sets?.[set];
    if (ours && gepa) {
      analysis.comparisons[set] = {
        ours: { mean: ours.mean, lo: ours.lo, hi: ours.hi },
        gepa: { mean: gepa.mean, lo: gepa.lo, hi: gepa.hi },
        oursMinusGepa: Math.round(((ours.mean ?? 0) - (gepa.mean ?? 0)) * 1000) / 1000,
      };
    }
  }

  // ── collapse diagnostics ──
  // v1 naïve-RAFT run (the honest-negative collapse comparator: ~744-char clones,
  // LoRA loss→0.0004, reward regressed) lives in the v1 results/ dir.
  const raftV1 = "experiments/rl-skill-opt/results/rl_netdns_main";
  if (fs.existsSync(path.join(raftV1, "trajectory.json"))) analysis.collapse["raft_v1_netdns"] = collapseDiag(raftV1, "raft-naive-v1");
  for (const d of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) {
    if (/^grpo_netdns_s\d+$/.test(d)) analysis.collapse[d] = collapseDiag(path.join(ROOT, d), "grpo");
    if (/^raft_netdns_s\d+$/.test(d)) analysis.collapse[d] = collapseDiag(path.join(ROOT, d), "raft");
  }

  // ── budget accounting: total real rollouts + MaaS tokens (proof Siclaw ran) ──
  // Walk every result.json trace under the results-v2 tree; sum tokens and count
  // completed agent rollouts. Also pull training-rollout tokens from RL trajectories.
  function walkTraces(dir, acc) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkTraces(p, acc);
      else if (e.name === "result.json") {
        try {
          const r = JSON.parse(fs.readFileSync(p, "utf8"));
          const t = r.stats?.tokens || {};
          acc.rollouts++;
          if (r.status === "completed") acc.completed++;
          acc.tokensIn += t.input || 0; acc.tokensOut += t.output || 0; acc.tokensTotal += t.total || 0;
        } catch {}
      }
    }
    return acc;
  }
  const evalBudget = walkTraces(path.join(ROOT, "eval"), { rollouts: 0, completed: 0, tokensIn: 0, tokensOut: 0, tokensTotal: 0 });
  const trainBudget = walkTraces(path.join(ROOT, "gepa_netdns"), { rollouts: 0, completed: 0, tokensIn: 0, tokensOut: 0, tokensTotal: 0 });
  // RL (GRPO/RAFT) training rollouts: count from trajectories (round * k * cases) + tokens
  let rlRollouts = 0, rlTokens = 0;
  for (const d of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) {
    if (!/^grpo_netdns_s\d+$/.test(d)) continue;
    const tp = path.join(ROOT, d, "trajectory.json");
    if (!fs.existsSync(tp)) continue;
    try {
      const tj = JSON.parse(fs.readFileSync(tp, "utf8"));
      for (const r of tj.trajectory || []) {
        rlTokens += r.roundTokens || 0;
        rlRollouts += (r.perCandPerCase || []).reduce((a, c) => a + Object.keys(c.perCase || {}).length, 0);
      }
    } catch {}
  }
  analysis.budgets = {
    evalRollouts: evalBudget.rollouts, evalCompleted: evalBudget.completed, evalTokens: evalBudget.tokensTotal,
    gepaTrainRollouts: trainBudget.rollouts, gepaTrainTokens: trainBudget.tokensTotal,
    grpoTrainRollouts: rlRollouts, grpoTrainTokens: rlTokens,
    totalRolloutsAllPhases: evalBudget.rollouts + trainBudget.rollouts + rlRollouts,
    totalTokensAllPhases: evalBudget.tokensTotal + trainBudget.tokensTotal + rlTokens,
    note: "evalRollouts = headline-table eval rollouts (held-out/audit/xbrain for every method). gepaTrain/grpoTrain = optimizer search rollouts.",
  };

  fs.writeFileSync(path.join(ROOT, "ANALYSIS.json"), JSON.stringify(analysis, null, 2));

  // ── console table ──
  const pad = (s, n) => String(s ?? "").padEnd(n);
  console.log("\n=== HEADLINE: mean composite [95% bootstrap CI] (judge in parens) ===");
  console.log(pad("method", 18), pad("train", 22), pad("held-out", 22), pad("cross-brain", 22), pad("audit", 22));
  const order = ["noskill", "handcrafted", "foa", "bon", "opro", "dspy", "refl", "gepa", "gepa_multiseed", "raft", "grpo"];
  for (const m of order) {
    const row = analysis.methods[m];
    if (!row) continue;
    const cell = (set) => {
      const s = row.sets[set];
      if (!s || s.mean == null) return pad("—", 22);
      return pad(`${s.mean} [${s.lo},${s.hi}] (${s.judge ?? "?"})`, 22);
    };
    const lbl = m === "grpo" && row.basisNote ? `${m}[${row.basisNote}]` : m;
    console.log(pad(lbl, 18), cell("train"), cell("heldout"), cell("xbrain"), cell("audit"));
  }

  console.log("\n=== REWARD-HACKING DIAGNOSTICS (held-out + audit) ===");
  console.log(pad("method", 18), pad("set", 10), pad("judge", 8), pad("rubric", 8), pad("gap", 8), pad("mislabel", 10), pad("spurious", 10));
  for (const m of order) {
    const row = analysis.methods[m];
    if (!row) continue;
    for (const set of ["heldout", "audit", "xbrain"]) {
      const s = row.sets[set];
      if (!s) continue;
      console.log(pad(m, 18), pad(set, 10), pad(s.judge, 8), pad(s.rubric, 8), pad(s.rewardTruthGap, 8), pad(s.mislabelRate, 10), pad(s.spuriousMean, 10));
    }
  }

  console.log("\n=== PRE-REGISTERED COMPARISON (ours vs GEPA) ===");
  for (const [set, c] of Object.entries(analysis.comparisons)) {
    console.log(`  ${set}: ours=${c.ours.mean}[${c.ours.lo},${c.ours.hi}]  gepa=${c.gepa.mean}[${c.gepa.lo},${c.gepa.hi}]  ours-gepa=${c.oursMinusGepa}`);
  }

  console.log("\n=== COLLAPSE DIAGNOSTICS (per round: meanR / spread / diversity / Pass@1,4,8) ===");
  for (const [tag, d] of Object.entries(analysis.collapse)) {
    if (!d) continue;
    console.log(`  ${tag} (${d.kind}):`);
    for (const r of d.rounds) console.log(`    round ${r.round}: meanR=${r.meanReward?.toFixed?.(3)} spread=${r.rewardSpread} edit=${r.diversity?.mean_edit} entH=${r.diversity?.token_entropy} P@1=${r.passAt1} P@4=${r.passAt4} P@8=${r.passAt8}`);
  }

  const b = analysis.budgets;
  console.log("\n=== BUDGET (real rollouts + MaaS tokens; proof Siclaw ran) ===");
  console.log(`  eval rollouts (headline table): ${b.evalRollouts} (completed ${b.evalCompleted}), tokens ${(b.evalTokens/1e6).toFixed(2)}M`);
  console.log(`  GEPA search rollouts: ${b.gepaTrainRollouts}, tokens ${(b.gepaTrainTokens/1e6).toFixed(2)}M`);
  console.log(`  GRPO training rollouts: ${b.grpoTrainRollouts}, tokens ${(b.grpoTrainTokens/1e6).toFixed(2)}M`);
  console.log(`  TOTAL: ${b.totalRolloutsAllPhases} rollouts, ${(b.totalTokensAllPhases/1e6).toFixed(2)}M tokens`);

  console.log(`\nwrote ${path.join(ROOT, "ANALYSIS.json")}`);
}

main();
