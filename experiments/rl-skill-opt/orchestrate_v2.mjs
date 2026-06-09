#!/usr/bin/env node
/**
 * orchestrate_v2.mjs — GRPO-upgraded skill-proposer RL loop (ours, AAAI v2).
 *
 * Same bridge as orchestrate.mjs (pod proposer/updater + local real reward) but:
 *   - uses proposer_v2.py / update_v2.py (group advantage, Pareto-keep, entropy
 *     floor, content-coverage imitation, behavioural prior),
 *   - scores with the COMPOSITE reward and passes PER-CASE composite into
 *     scored.json so the updater can do per-instance Pareto keeping,
 *   - records per-round collapse diagnostics: generation diversity (mean edit
 *     distance + token entropy from the proposer), candidate reward spread, and the
 *     per-candidate per-case composite (for Pass@k computation in analyze.mjs).
 *
 * Usage:
 *   node experiments/rl-skill-opt/orchestrate_v2.mjs \
 *     --category network-dns --train-cases c068,c069,c070,c071,c072,c073 \
 *     --provider gpt --rounds 3 --k 4 --seed-tag s1 \
 *     --prior-skill experiments/rl-skill-opt/skills/network-dns-handcrafted.txt \
 *     --baseline-judge <no-skill judgments.json> \
 *     --run-root experiments/rl-skill-opt/results-v2/grpo_netdns_s1
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const REPO = process.cwd();
const CODEX_NODE = "/Users/yye/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";
const NODE = fs.existsSync(CODEX_NODE) ? CODEX_NODE : process.execPath;
const REWARD = "experiments/rl-skill-opt/reward.mjs";

const NS = "siclaw-rl-yye";
const POD = process.env.RL_POD || "rl-skill-trainer-3";
const POD_CONTAINER = process.env.RL_POD_CONTAINER || "trainer";
const POD_RL = "/workspace/rl";
const POD_OUT = "/workspace/out/skillprop_v2";
const HF_HOME = "/workspace/hf";

function arg(name, fb) { const i = process.argv.indexOf(name); return i < 0 ? fb : process.argv[i + 1] ?? fb; }
const CATEGORY = arg("--category", "network-dns");
const TRAIN_CASES = arg("--train-cases", "").split(",").map((s) => s.trim()).filter(Boolean);
const BASELINE_JUDGE = arg("--baseline-judge", "");
const ROUNDS = Number(arg("--rounds", "3"));
const K = Number(arg("--k", "4"));
const PROVIDER = arg("--provider", "gpt");
const MODEL = arg("--model", "Qwen/Qwen2.5-3B-Instruct");
const TEMPERATURE = arg("--temperature", "1.05");
const MAX_NEW = arg("--max-new-tokens", "700");
const CONCURRENCY = arg("--concurrency", "3");
const TIMEOUT_MS = arg("--timeout-ms", "240000");
const SEED_TAG = arg("--seed-tag", "s1");
const SEED_BASE = Number(arg("--seed-base", "100"));
const PRIOR_SKILL = arg("--prior-skill", "");
const ENTROPY_BETA = arg("--entropy-beta", "0.01");
const COVERAGE_BONUS = arg("--coverage-bonus", "0.3");
const CUDA_DEVICE = arg("--cuda-device", ""); // pin GPU for parallel-seed training
const CUDA_ENV = CUDA_DEVICE !== "" ? `CUDA_VISIBLE_DEVICES=${CUDA_DEVICE} ` : "";
const RUN_ROOT = arg("--run-root", `experiments/rl-skill-opt/results-v2/grpo_${CATEGORY}_${SEED_TAG}`);

if (!TRAIN_CASES.length) { console.error("Need --train-cases"); process.exit(2); }
fs.mkdirSync(RUN_ROOT, { recursive: true });

function sh(desc, cmd, args) {
  console.error(`\n$ ${desc}\n  ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${desc} failed (exit ${r.status})`);
  return r;
}
const KEXEC = (s) => ["-n", NS, "exec", POD, "-c", POD_CONTAINER, "--", "bash", "-lc", s];
function kcpTo(local, podPath) { sh(`cp ${local} -> pod`, "kubectl", ["-n", NS, "cp", "-c", POD_CONTAINER, local, `${NS}/${POD}:${podPath}`]); }
function kcpFrom(podPath, local) { sh(`cp pod ${podPath} -> ${local}`, "kubectl", ["-n", NS, "cp", "-c", POD_CONTAINER, `${NS}/${POD}:${podPath}`, local]); }

function buildExamples() {
  const all = JSON.parse(fs.readFileSync("experiments/siclaw-agent-eval/cases/cases.json", "utf8"));
  const inCat = all.filter((c) => c.category === CATEGORY && !TRAIN_CASES.includes(c.id));
  const seen = new Set(); const ex = [];
  for (const c of inCat) { if (seen.has(c.title)) continue; seen.add(c.title); ex.push(c.symptom); if (ex.length >= 2) break; }
  if (!ex.length) for (const c of all.filter((c) => c.category === CATEGORY).slice(0, 2)) ex.push(c.symptom);
  return ex;
}

// score a skill, return {reward(composite), judgeReward, perCase composite, tokens}
function scoreSkillLocal(skillFile, runDir) {
  return new Promise((resolve, reject) => {
    const argv = [REWARD, "--cases", TRAIN_CASES.join(","), "--provider", PROVIDER,
      "--run-dir", runDir, "--concurrency", CONCURRENCY, "--timeout-ms", TIMEOUT_MS, "--composite"];
    if (skillFile) argv.push("--skill-file", skillFile);
    if (BASELINE_JUDGE) argv.push("--baseline-judge", BASELINE_JUDGE);
    const child = spawn(NODE, argv, { cwd: REPO, env: { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH}` } });
    child.stdout.on("data", (d) => process.stderr.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`reward.mjs exit ${code}`));
      try { resolve(JSON.parse(fs.readFileSync(path.join(runDir, "reward.json"), "utf8"))); }
      catch (e) { reject(e); }
    });
  });
}

async function main() {
  console.error(`=== GRPO-v2 skill-proposer  category=${CATEGORY} rounds=${ROUNDS} k=${K} provider=${PROVIDER} seed=${SEED_TAG} prior=${PRIOR_SKILL || "(none)"} ===`);
  const podOut = `${POD_OUT}/${SEED_TAG}`;

  // stage scripts + examples (+ prior) on the pod
  for (const f of ["proposer_v2.py", "update_v2.py"]) kcpTo(`experiments/rl-skill-opt/${f}`, `${POD_RL}/${f}`);
  const examples = buildExamples();
  const exLocal = path.join(RUN_ROOT, "examples.json");
  fs.writeFileSync(exLocal, JSON.stringify(examples, null, 2));
  kcpTo(exLocal, `${POD_RL}/examples_${SEED_TAG}.json`);
  let priorArg = "";
  if (PRIOR_SKILL && fs.existsSync(PRIOR_SKILL)) {
    kcpTo(PRIOR_SKILL, `${POD_RL}/prior_${SEED_TAG}.txt`);
    priorArg = `--prior-skill ${POD_RL}/prior_${SEED_TAG}.txt`;
  }
  sh("mkdir pod out", "kubectl", KEXEC(`mkdir -p ${podOut}`));

  const trajectory = [];
  let inAdapter = null;

  for (let round = 0; round < ROUNDS; round++) {
    const rdir = `${podOut}/round${round}`;
    const candPod = `${rdir}/candidates.json`;
    const seed = SEED_BASE + round * 7;
    console.error(`\n########## ${SEED_TAG} ROUND ${round} ##########`);

    // 1) generate K candidates (proposer_v2: prior + diversity tracking)
    const adapterArg = inAdapter ? `--adapter ${inAdapter}` : "";
    sh(`round${round}: proposer_v2.py`, "kubectl", KEXEC(
      `cd ${POD_RL} && ${CUDA_ENV}HF_HOME=${HF_HOME} python proposer_v2.py --model ${MODEL} ${adapterArg} ${priorArg} ` +
      `--category ${CATEGORY} --examples-file ${POD_RL}/examples_${SEED_TAG}.json --k ${K} ` +
      `--out ${candPod} --temperature ${TEMPERATURE} --max-new-tokens ${MAX_NEW} --seed ${seed}`));

    const localRoundDir = path.join(RUN_ROOT, `round${round}`);
    fs.mkdirSync(localRoundDir, { recursive: true });
    const candLocal = path.join(localRoundDir, "candidates.json");
    kcpFrom(candPod, candLocal);
    const cand = JSON.parse(fs.readFileSync(candLocal, "utf8"));
    console.error(`[orchestrate_v2] round ${round} diversity: ${JSON.stringify(cand.diversity)}`);

    // 2) score each candidate (real env + composite); record per-case composite
    const scoredCands = [];
    for (const c of cand.candidates) {
      const skillFile = path.join(localRoundDir, `cand${c.idx}.txt`);
      fs.writeFileSync(skillFile, c.skill);
      if (!c.skill.trim()) { scoredCands.push({ idx: c.idx, skill: c.skill, chars: c.chars, coverage: c.coverage, reward: 0, judgeReward: 0, advantage: -1, perCase: {} }); continue; }
      const runDir = path.join(localRoundDir, `eval_cand${c.idx}`);
      console.error(`\n--- ${SEED_TAG} round ${round} candidate ${c.idx} (${c.chars} chars, cov=${JSON.stringify(c.coverage)}): scoring ---`);
      let r;
      try { r = await scoreSkillLocal(skillFile, runDir); }
      catch (e) { console.error(`  scoring failed: ${e.message}`); r = { reward: 0, judgeReward: 0, advantage: -1, tokens: { total: 0 }, composite: { perCase: {} } }; }
      const perCase = {};
      for (const id of TRAIN_CASES) perCase[id] = r.composite?.perCase?.[id]?.composite ?? r.perCase?.[id] ?? 0;
      scoredCands.push({
        idx: c.idx, skill: c.skill, chars: c.chars, coverage: c.coverage,
        reward: r.reward, judgeReward: r.judgeReward, advantage: r.advantage,
        perCase, tokensTotal: r.tokens?.total ?? 0, runDir,
        rubricMean: r.composite?.rubricMean, mislabelRate: r.composite?.mislabelRate,
      });
      console.error(`  -> composite=${r.reward} judge=${r.judgeReward} mislabel=${r.composite?.mislabelRate} tokens=${r.tokens?.total}`);
    }
    scoredCands.sort((a, b) => (b.reward ?? 0) - (a.reward ?? 0));
    const rewards = scoredCands.map((c) => c.reward ?? 0);
    const meanR = rewards.reduce((a, b) => a + b, 0) / (rewards.length || 1);
    const best = scoredCands[0];
    const roundTokens = scoredCands.reduce((a, c) => a + (c.tokensTotal || 0), 0);
    console.error(`\n### ${SEED_TAG} round ${round}: meanComposite=${meanR.toFixed(3)} best=${(best?.reward ?? 0).toFixed(3)} (cand ${best?.idx}) diversity=${JSON.stringify(cand.diversity)} tokens=${roundTokens}`);

    fs.writeFileSync(path.join(localRoundDir, `best_skill_round${round}.txt`), best?.skill ?? "");
    const scored = {
      round, category: CATEGORY, seedTag: SEED_TAG, meanReward: meanR, bestReward: best?.reward ?? 0,
      bestIdx: best?.idx, roundTokens, diversity: cand.diversity, trainCases: TRAIN_CASES,
      candidates: scoredCands.map(({ runDir, ...rest }) => rest),
    };
    const scoredLocal = path.join(localRoundDir, "scored.json");
    fs.writeFileSync(scoredLocal, JSON.stringify(scored, null, 2));
    trajectory.push({ round, meanReward: meanR, bestReward: best?.reward ?? 0, bestJudge: best?.judgeReward, bestIdx: best?.idx, rewards, diversity: cand.diversity, roundTokens, bestSkillPath: path.join(localRoundDir, `best_skill_round${round}.txt`), perCandPerCase: scoredCands.map((c) => ({ idx: c.idx, perCase: c.perCase, reward: c.reward })) });
    fs.writeFileSync(path.join(RUN_ROOT, "trajectory.json"), JSON.stringify({ category: CATEGORY, model: MODEL, provider: PROVIDER, seedTag: SEED_TAG, trainCases: TRAIN_CASES, prior: PRIOR_SKILL, trajectory }, null, 2));

    // 3) push scored.json, 4) GRPO update -> new adapter
    const outAdapter = `${rdir}/adapter`;
    kcpTo(scoredLocal, `${rdir}/scored.json`);
    try {
      sh(`round${round}: update_v2.py (GRPO)`, "kubectl", KEXEC(
        `cd ${POD_RL} && ${CUDA_ENV}HF_HOME=${HF_HOME} python update_v2.py --model ${MODEL} ` +
        `${inAdapter ? `--in-adapter ${inAdapter}` : ""} --scored-file ${rdir}/scored.json ` +
        `--category ${CATEGORY} --examples-file ${POD_RL}/examples_${SEED_TAG}.json ${priorArg} ` +
        `--train-cases ${TRAIN_CASES.join(",")} --entropy-beta ${ENTROPY_BETA} --coverage-bonus ${COVERAGE_BONUS} ` +
        `--out-adapter ${outAdapter}`));
      // pull the update summary for diagnostics
      try { kcpFrom(`${rdir}/update_summary.json`, path.join(localRoundDir, "update_summary.json")); } catch {}
      inAdapter = outAdapter;
    } catch (e) {
      console.error(`[orchestrate_v2] update failed round ${round}: ${e.message} — keeping previous adapter`);
    }
  }

  let overallBest = { reward: -1 };
  for (const t of trajectory) if (t.bestReward > overallBest.reward) overallBest = t;
  if (overallBest.bestSkillPath) fs.copyFileSync(overallBest.bestSkillPath, path.join(RUN_ROOT, "BEST_SKILL.txt"));
  console.error(`\n=== ${SEED_TAG} DONE. composite trajectory: ===`);
  for (const t of trajectory) console.error(`  round ${t.round}: mean=${t.meanReward.toFixed(3)} best=${t.bestReward.toFixed(3)} diversity=${JSON.stringify(t.diversity)}`);
  console.log(JSON.stringify({ runRoot: RUN_ROOT, seedTag: SEED_TAG, trajectory: trajectory.map((t) => ({ round: t.round, meanReward: t.meanReward, bestReward: t.bestReward, diversity: t.diversity })), bestSkill: path.join(RUN_ROOT, "BEST_SKILL.txt") }));
}

main().catch((e) => { console.error("[orchestrate_v2] ERROR", e?.stack || e?.message || String(e)); process.exit(1); });
