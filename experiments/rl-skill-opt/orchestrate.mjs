#!/usr/bin/env node
/**
 * orchestrate.mjs — the agent-in-the-loop RL orchestrator (runs LOCALLY).
 *
 * Bridges the H100 pod (proposer policy + RAFT updater) and the local real
 * environment (reward.mjs = real Siclaw agent + real LLM judge). One round:
 *
 *   1. exec  proposer.py   on the pod  -> K candidate skills (no ground truth)
 *   2. cp    candidates    back to local
 *   3. local reward.mjs    for each candidate -> REAL reward (Siclaw runs here,
 *                           MaaS tokens flow), advantage vs no-skill baseline
 *   4. cp    scored.json   to the pod
 *   5. exec  update.py     on the pod  -> RAFT/ReST LoRA update, new adapter
 *   6. next round loads that adapter
 *
 * The proposer + optimizer live on the pod (GPU); reward eval runs locally
 * (where the harness, kubeconfig, and scitix live). No port-forward needed.
 *
 * Usage:
 *   node experiments/rl-skill-opt/orchestrate.mjs \
 *     --category network-dns \
 *     --train-cases c068,c069,c070,c071,c072,c073 \
 *     --baseline-judge experiments/rl-skill-opt/results/baseline_netdns6/judgments.json \
 *     --rounds 3 --k 4 --provider kimi [--model Qwen/Qwen2.5-3B-Instruct]
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const REPO = process.cwd();
const CODEX_NODE = "/Users/yye/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";
const NODE = fs.existsSync(CODEX_NODE) ? CODEX_NODE : process.execPath;
const REWARD = "experiments/rl-skill-opt/reward.mjs";
const CASES_PATH = "experiments/siclaw-agent-eval/cases/cases.json";

const NS = "siclaw-rl-yye";
const POD = "rl-skill-trainer";
const POD_RL = "/workspace/rl";                 // scripts live here
const POD_OUT = "/workspace/out/skillprop";     // run artifacts here
const HF_HOME = "/workspace/hf";

function arg(name, fb) { const i = process.argv.indexOf(name); return i < 0 ? fb : process.argv[i + 1] ?? fb; }
const CATEGORY = arg("--category", "network-dns");
const TRAIN_CASES = arg("--train-cases", "").split(",").map((s) => s.trim()).filter(Boolean);
const BASELINE_JUDGE = arg("--baseline-judge", "");
const ROUNDS = Number(arg("--rounds", "3"));
const K = Number(arg("--k", "4"));
const PROVIDER = arg("--provider", "kimi");
const MODEL = arg("--model", "Qwen/Qwen2.5-3B-Instruct");
const TEMPERATURE = arg("--temperature", "0.9");
const MAX_NEW = arg("--max-new-tokens", "700");
const CONCURRENCY = arg("--concurrency", "3");
const TIMEOUT_MS = arg("--timeout-ms", "240000");
const RUN_ROOT = arg("--run-root", `experiments/rl-skill-opt/results/rl_${CATEGORY}_${Date.now()}`);

if (!TRAIN_CASES.length) { console.error("Need --train-cases"); process.exit(2); }
fs.mkdirSync(RUN_ROOT, { recursive: true });

function sh(desc, cmd, args, { capture = false } = {}) {
  console.error(`\n$ ${desc}\n  ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (r.status !== 0) {
    if (capture) console.error(r.stdout, r.stderr);
    throw new Error(`${desc} failed (exit ${r.status})`);
  }
  return r;
}

// kubectl helpers
const KEXEC = (bashScript) => ["-n", NS, "exec", POD, "--", "bash", "-lc", bashScript];
function kcpTo(local, podPath) { sh(`cp ${local} -> pod`, "kubectl", ["-n", NS, "cp", local, `${NS}/${POD}:${podPath}`]); }
function kcpFrom(podPath, local) { sh(`cp pod ${podPath} -> ${local}`, "kubectl", ["-n", NS, "cp", `${NS}/${POD}:${podPath}`, local]); }

// example incident symptoms for the category (NO ground truth, NO target names)
function buildExamples() {
  const all = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
  const inCat = all.filter((c) => c.category === CATEGORY && !TRAIN_CASES.includes(c.id));
  // prefer cases NOT in the train set, dedupe by symptom shape, take up to 2
  const seen = new Set();
  const ex = [];
  for (const c of inCat) {
    const key = c.title;
    if (seen.has(key)) continue;
    seen.add(key);
    ex.push(c.symptom);
    if (ex.length >= 2) break;
  }
  if (!ex.length) {
    for (const c of all.filter((c) => c.category === CATEGORY).slice(0, 2)) ex.push(c.symptom);
  }
  return ex;
}

// run reward.mjs for one skill file, return its compact result
function scoreSkill(skillFile, runDir) {
  return new Promise((resolve, reject) => {
    const argv = [
      REWARD, "--cases", TRAIN_CASES.join(","), "--provider", PROVIDER,
      "--run-dir", runDir, "--concurrency", CONCURRENCY, "--timeout-ms", TIMEOUT_MS,
    ];
    if (skillFile) argv.push("--skill-file", skillFile);
    if (BASELINE_JUDGE) argv.push("--baseline-judge", BASELINE_JUDGE);
    const child = spawn(NODE, argv, { cwd: REPO, env: { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH}` } });
    let last = "";
    child.stdout.on("data", (d) => { const s = d.toString(); process.stderr.write(s); for (const line of s.split("\n")) if (line.trim().startsWith("{")) last = line.trim(); });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`reward.mjs exit ${code}`));
      try { resolve(JSON.parse(last)); } catch { reject(new Error("could not parse reward summary")); }
    });
  });
}

async function main() {
  console.error(`=== RL skill-proposer  category=${CATEGORY} rounds=${ROUNDS} k=${K} provider=${PROVIDER} ===`);
  console.error(`train cases: ${TRAIN_CASES.join(",")}`);

  // 0) stage scripts + examples on the pod
  for (const f of ["proposer.py", "update.py"]) kcpTo(`experiments/rl-skill-opt/${f}`, `${POD_RL}/${f}`);
  const examples = buildExamples();
  const exLocal = path.join(RUN_ROOT, "examples.json");
  fs.writeFileSync(exLocal, JSON.stringify(examples, null, 2));
  kcpTo(exLocal, `${POD_RL}/examples.json`);
  console.error(`examples (no ground truth):\n${examples.map((e, i) => `  ${i + 1}. ${e}`).join("\n")}`);
  sh("mkdir pod out", "kubectl", KEXEC(`mkdir -p ${POD_OUT}`));

  const trajectory = [];
  let inAdapter = null; // first round: base model, no adapter

  for (let round = 0; round < ROUNDS; round++) {
    const rdir = `${POD_OUT}/round${round}`;
    const candPod = `${rdir}/candidates.json`;
    const seed = 100 + round * 7;
    console.error(`\n########## ROUND ${round} ##########`);

    // 1) generate K candidates on the pod
    const adapterArg = inAdapter ? `--adapter ${inAdapter}` : "";
    sh(`round${round}: proposer.py`, "kubectl", KEXEC(
      `cd ${POD_RL} && HF_HOME=${HF_HOME} python proposer.py --model ${MODEL} ${adapterArg} ` +
      `--category ${CATEGORY} --examples-file ${POD_RL}/examples.json --k ${K} ` +
      `--out ${candPod} --temperature ${TEMPERATURE} --max-new-tokens ${MAX_NEW} --seed ${seed}`));

    // 2) pull candidates back
    const localRoundDir = path.join(RUN_ROOT, `round${round}`);
    fs.mkdirSync(localRoundDir, { recursive: true });
    const candLocal = path.join(localRoundDir, "candidates.json");
    kcpFrom(candPod, candLocal);
    const cand = JSON.parse(fs.readFileSync(candLocal, "utf8"));

    // 3) score each candidate with the REAL environment (sequential — rollouts are slow + share the cluster)
    const scoredCands = [];
    for (const c of cand.candidates) {
      const skillFile = path.join(localRoundDir, `cand${c.idx}.txt`);
      fs.writeFileSync(skillFile, c.skill);
      if (!c.skill.trim()) { scoredCands.push({ ...c, reward: 0, advantage: -1, note: "empty" }); continue; }
      const runDir = path.join(localRoundDir, `eval_cand${c.idx}`);
      console.error(`\n--- round ${round} candidate ${c.idx} (${c.chars} chars): scoring ---`);
      let res;
      try { res = await scoreSkill(skillFile, runDir); }
      catch (e) { console.error(`  scoring failed: ${e.message}`); res = { reward: 0, advantage: -1, tokensTotal: 0 }; }
      scoredCands.push({ idx: c.idx, skill: c.skill, chars: c.chars, reward: res.reward, advantage: res.advantage, passRate: res.passRate, tokensTotal: res.tokensTotal, runDir });
      console.error(`  -> reward=${res.reward} advantage=${res.advantage} tokens=${res.tokensTotal}`);
    }
    scoredCands.sort((a, b) => (b.reward ?? 0) - (a.reward ?? 0));
    const rewards = scoredCands.map((c) => c.reward ?? 0);
    const meanR = rewards.reduce((a, b) => a + b, 0) / (rewards.length || 1);
    const best = scoredCands[0];
    const roundTokens = scoredCands.reduce((a, c) => a + (c.tokensTotal || 0), 0);
    console.error(`\n### round ${round} summary: meanReward=${meanR.toFixed(3)} bestReward=${(best?.reward ?? 0).toFixed(3)} (cand ${best?.idx}) tokens=${roundTokens}`);

    // save the round's best skill where validation can find it
    const bestSkillPath = path.join(localRoundDir, `best_skill_round${round}.txt`);
    fs.writeFileSync(bestSkillPath, best?.skill ?? "");
    const scored = { round, category: CATEGORY, meanReward: meanR, bestReward: best?.reward ?? 0, bestIdx: best?.idx, roundTokens, candidates: scoredCands.map(({ skill, ...rest }) => ({ ...rest, skill })) };
    const scoredLocal = path.join(localRoundDir, "scored.json");
    fs.writeFileSync(scoredLocal, JSON.stringify(scored, null, 2));
    trajectory.push({ round, meanReward: meanR, bestReward: best?.reward ?? 0, bestIdx: best?.idx, rewards, roundTokens, bestSkillPath });
    fs.writeFileSync(path.join(RUN_ROOT, "trajectory.json"), JSON.stringify({ category: CATEGORY, model: MODEL, provider: PROVIDER, trainCases: TRAIN_CASES, baselineJudge: BASELINE_JUDGE, trajectory }, null, 2));

    // 4) push scored.json to the pod, 5) RAFT update -> new adapter (skip on last round if you only need the skill)
    const outAdapter = `${rdir}/adapter`;
    kcpTo(scoredLocal, `${rdir}/scored.json`);
    try {
      sh(`round${round}: update.py (RAFT)`, "kubectl", KEXEC(
        `cd ${POD_RL} && HF_HOME=${HF_HOME} python update.py --model ${MODEL} ` +
        `${inAdapter ? `--in-adapter ${inAdapter}` : ""} --scored-file ${rdir}/scored.json ` +
        `--category ${CATEGORY} --examples-file ${POD_RL}/examples.json --out-adapter ${outAdapter}`));
      inAdapter = outAdapter; // next round continues from here
    } catch (e) {
      console.error(`[orchestrate] update failed round ${round}: ${e.message} — keeping previous adapter`);
    }
  }

  // overall best skill across rounds
  let overallBest = { reward: -1 };
  for (const t of trajectory) if (t.bestReward > overallBest.reward) overallBest = t;
  if (overallBest.bestSkillPath) {
    fs.copyFileSync(overallBest.bestSkillPath, path.join(RUN_ROOT, "BEST_SKILL.txt"));
  }
  console.error(`\n=== DONE. reward trajectory (meanReward / bestReward per round): ===`);
  for (const t of trajectory) console.error(`  round ${t.round}: mean=${t.meanReward.toFixed(3)} best=${t.bestReward.toFixed(3)} (cand ${t.bestIdx})`);
  console.error(`best skill -> ${path.join(RUN_ROOT, "BEST_SKILL.txt")} (round ${overallBest.round}, reward ${overallBest.bestReward?.toFixed(3)})`);
  console.log(JSON.stringify({ runRoot: RUN_ROOT, trajectory: trajectory.map((t) => ({ round: t.round, meanReward: t.meanReward, bestReward: t.bestReward })), bestSkill: path.join(RUN_ROOT, "BEST_SKILL.txt") }));
}

main().catch((e) => { console.error(`[orchestrate] ERROR`, e?.stack || e?.message || String(e)); process.exit(1); });
