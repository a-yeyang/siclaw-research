#!/usr/bin/env node
/**
 * reward.mjs — the REAL RL reward for the skill-proposer policy.
 *
 *   Given (skill_text, [case ids]) it:
 *     1. Runs the REAL Siclaw agent (eval-harness.mjs) on each case, with the
 *        candidate skill injected into the system prompt via --skill-file.
 *        The agent investigates the LIVE cluster with its tools/skills, using a
 *        scitix API model as the brain (so MaaS token usage visibly increases —
 *        that is the proof Siclaw is actually running).
 *     2. Runs the REAL LLM judge (experiments/aaai-paper/judge-llm.mjs, scitix
 *        Claude) over the produced traces.
 *     3. Returns the mean judge total score (+ per-case scores + aggregate token
 *        usage), and — if --baseline-dir points at a no-skill judge file — the
 *        ADVANTAGE = score − baseline.
 *
 * This is the slow, real environment. Callers (the orchestrator) treat it as a
 * black-box scalar reward for an injected skill.
 *
 * Usage:
 *   node experiments/rl-skill-opt/reward.mjs \
 *     --skill-file <path|"">            # "" or omitted => no-skill baseline run
 *     --cases c068,c070,c073 \         # OR --category network-dns [--n 4]
 *     --provider kimi \                # provider dir under aaai-paper/providers
 *     --run-dir experiments/rl-skill-opt/results/run_xyz \
 *     [--judge-model claude-sonnet-4-6] [--concurrency 3] [--timeout-ms 240000]
 *     [--baseline-judge <path-to-no-skill-judgments.json>] [--reuse]
 *
 * Output: prints a JSON summary to stdout (last line) and writes
 *   <run-dir>/reward.json  (the full structured result).
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { aggregateComposite } from "./composite-reward.mjs";

const REPO = process.cwd();
const CODEX_NODE = "/Users/yye/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";
const NODE = fs.existsSync(CODEX_NODE) ? CODEX_NODE : process.execPath;
const EVAL_ROOT = "experiments/siclaw-agent-eval";
const HARNESS = path.join(EVAL_ROOT, "eval-harness.mjs");
const PROVIDERS = "experiments/aaai-paper/providers";
const JUDGE = "experiments/aaai-paper/judge-llm.mjs";
const KUBECONFIG = ".siclaw/credentials/cks-test.kubeconfig";

function arg(name, fb) {
  const i = process.argv.indexOf(name);
  return i < 0 ? fb : process.argv[i + 1] ?? fb;
}

const SKILL_FILE = arg("--skill-file", "") || "";
const CATEGORY = arg("--category", "");
const N = arg("--n") ? Number(arg("--n")) : null;
const CASES_ARG = arg("--cases", "");
// custom case set (e.g. audit cases) + custom prompt dir; default to the canonical eval set
const CASES_PATH = arg("--cases-file", path.join(EVAL_ROOT, "cases", "cases.json"));
const PROMPT_DIR = arg("--prompt-dir", path.join(EVAL_ROOT, "logs")); // per-case prompts
const PROVIDER = arg("--provider", "kimi");
const RUN_DIR = arg("--run-dir", `experiments/rl-skill-opt/results/run_${Date.now()}`);
const JUDGE_MODEL = arg("--judge-model", "claude-sonnet-4-6");
const CONCURRENCY = Number(arg("--concurrency", "3"));
const TIMEOUT_MS = Number(arg("--timeout-ms", "240000"));
const GUARD = arg("--guard", "low-cost");
const THINKING = arg("--thinking", "high");
const BASELINE_JUDGE = arg("--baseline-judge", "");
const REUSE = process.argv.includes("--reuse"); // reuse existing traces if complete
const COMPOSITE = process.argv.includes("--composite"); // composite reward as scalar

function log(...a) {
  console.error(`[reward]`, ...a);
}

function resolveCases() {
  const all = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
  let ids = [];
  if (CASES_ARG) {
    ids = CASES_ARG.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (CATEGORY) {
    let pool = all.filter((c) => c.category === CATEGORY).map((c) => c.id);
    ids = N ? pool.slice(0, N) : pool;
  } else {
    throw new Error("Specify --cases <ids> or --category <name> [--n K]");
  }
  const byId = Object.fromEntries(all.map((c) => [c.id, c]));
  for (const id of ids) if (!byId[id]) throw new Error(`Unknown case ${id}`);
  return ids.map((id) => byId[id]);
}

function traceComplete(p) {
  if (!fs.existsSync(p)) return false;
  try {
    const r = JSON.parse(fs.readFileSync(p, "utf8"));
    return r.status === "completed" && (r.finalText || "").trim() && (r.toolCalls || []).length > 0;
  } catch {
    return false;
  }
}

// ── 1) run the real Siclaw agent on each case (concurrency-limited) ──────────
function runHarness(c, cfg, tracesDir) {
  return new Promise((resolve) => {
    const out = path.join(tracesDir, c.id, "result.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const promptFile = path.join(PROMPT_DIR, c.id, "prompt.txt");
    if (!fs.existsSync(promptFile)) {
      resolve({ id: c.id, status: "no-prompt", out });
      return;
    }
    if (REUSE && traceComplete(out)) {
      resolve({ id: c.id, status: "reused", out });
      return;
    }
    const argv = [
      HARNESS,
      "--case-id", c.id,
      "--prompt-file", promptFile,
      "--output-file", out,
      "--kubeconfig", KUBECONFIG,
      "--timeout-ms", String(TIMEOUT_MS),
      "--guard", GUARD,
      "--thinking", THINKING,
    ];
    if (SKILL_FILE) argv.push("--skill-file", SKILL_FILE);
    const so = fs.createWriteStream(path.join(path.dirname(out), "runner.stdout.log"), { flags: "a" });
    const se = fs.createWriteStream(path.join(path.dirname(out), "runner.stderr.log"), { flags: "a" });
    const child = spawn(NODE, argv, {
      cwd: REPO,
      env: { ...process.env, SICLAW_CONFIG_DIR: cfg, PATH: `${path.dirname(NODE)}:${process.env.PATH}` },
    });
    child.stdout.pipe(so);
    child.stderr.pipe(se);
    child.on("close", (code) => {
      so.end();
      se.end();
      let status = code === 0 ? "ok" : `exit-${code}`;
      try {
        status = JSON.parse(fs.readFileSync(out, "utf8")).status;
      } catch {}
      resolve({ id: c.id, status, out });
    });
  });
}

async function pool(items, n, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await worker(items[idx], idx);
      }
    }),
  );
  return out;
}

function aggregateTokens(tracesDir, cases) {
  let input = 0, output = 0, total = 0, toolCalls = 0, completed = 0;
  for (const c of cases) {
    const p = path.join(tracesDir, c.id, "result.json");
    if (!fs.existsSync(p)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(p, "utf8"));
      const t = r.stats?.tokens || {};
      input += t.input || 0;
      output += t.output || 0;
      total += t.total || 0;
      toolCalls += (r.toolCalls || []).length;
      if (r.status === "completed") completed++;
    } catch {}
  }
  return { input, output, total, toolCalls, completed, cases: cases.length };
}

// ── 2) run the real LLM judge over the produced traces ───────────────────────
function runJudge(tracesDir, onlyIds, outPath) {
  return new Promise((resolve, reject) => {
    const argv = [
      JUDGE,
      "--judge-model", JUDGE_MODEL,
      "--traces-dir", tracesDir,
      "--cases", CASES_PATH,
      "--out", outPath,
      "--only", onlyIds.join(","),
      "--concurrency", String(CONCURRENCY),
    ];
    const child = spawn(NODE, argv, {
      cwd: REPO,
      env: { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH}` },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.stdout.on("data", (d) => process.stderr.write(d)); // surface judge summary
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`judge exited ${code}: ${stderr.slice(-500)}`));
      resolve();
    });
  });
}

function summarizeJudge(judgePath) {
  const arr = JSON.parse(fs.readFileSync(judgePath, "utf8"));
  const ok = arr.filter((r) => r.status === "completed");
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const scores = Object.fromEntries(arr.map((r) => [r.caseId, r.totalScore ?? 0]));
  return {
    n: arr.length,
    graded: ok.length,
    meanScore: Math.round(mean(ok.map((r) => r.totalScore)) * 1000) / 1000,
    passRate: ok.length ? ok.filter((r) => r.passed).length / ok.length : 0,
    perCase: scores,
    notGraded: arr.filter((r) => r.status !== "completed").map((r) => `${r.caseId}:${r.status}`),
  };
}

async function main() {
  const cases = resolveCases();
  const ids = cases.map((c) => c.id);
  const cfg = path.join(PROVIDERS, PROVIDER, ".siclaw", "config");
  if (!fs.existsSync(path.join(cfg, "settings.json"))) {
    throw new Error(`no provider config for ${PROVIDER} at ${cfg}`);
  }
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const tracesDir = path.join(RUN_DIR, "traces");
  const judgePath = path.join(RUN_DIR, "judgments.json");

  const skillText = SKILL_FILE ? fs.readFileSync(SKILL_FILE, "utf8") : "";
  log(`provider=${PROVIDER} cases=${ids.join(",")} skill=${SKILL_FILE || "(none/baseline)"} skillChars=${skillText.length}`);

  const t0 = Date.now();
  // 1) run the real agent
  const runResults = await pool(cases, CONCURRENCY, async (c) => {
    const r = await runHarness(c, cfg, tracesDir);
    log(`agent ${c.id} -> ${r.status}`);
    return r;
  });
  const tokens = aggregateTokens(tracesDir, cases);
  log(`agent done in ${Math.round((Date.now() - t0) / 1000)}s | tokens in=${tokens.input} out=${tokens.output} total=${tokens.total} toolCalls=${tokens.toolCalls} completed=${tokens.completed}/${tokens.cases}`);

  // 2) judge
  await runJudge(tracesDir, ids, judgePath);
  const judge = summarizeJudge(judgePath);
  log(`judge meanScore=${judge.meanScore} passRate=${(100 * judge.passRate).toFixed(0)}% graded=${judge.graded}/${judge.n}`);

  // 2.5) composite, partially-verifiable reward (always computed; scalar when --composite)
  // Loads each trace + case to compute the 3-item rubric + spurious penalty.
  let composite = null;
  try {
    const casesById = Object.fromEntries(cases.map((c) => [c.id, c]));
    const tracesById = {};
    for (const id of ids) {
      const p = path.join(tracesDir, id, "result.json");
      if (fs.existsSync(p)) {
        try { tracesById[id] = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
      }
    }
    composite = aggregateComposite(judge.perCase, tracesById, casesById);
    log(`composite=${composite.composite} rubric=${composite.rubricMean} rewardTruthGap=${composite.rewardTruthGap} mislabelRate=${composite.mislabelRate} spurious=${composite.spuriousMean}`);
  } catch (e) {
    log(`composite computation failed: ${e?.message || e}`);
  }

  // 3) advantage vs baseline (optional)
  let baseline = null, advantage = null, perCaseAdvantage = null;
  if (BASELINE_JUDGE && fs.existsSync(BASELINE_JUDGE)) {
    baseline = summarizeJudge(BASELINE_JUDGE);
    advantage = Math.round((judge.meanScore - baseline.meanScore) * 1000) / 1000;
    perCaseAdvantage = {};
    for (const id of ids) {
      if (baseline.perCase[id] != null && judge.perCase[id] != null) {
        perCaseAdvantage[id] = Math.round((judge.perCase[id] - baseline.perCase[id]) * 1000) / 1000;
      }
    }
  }

  // the scalar reward used by the RL loop: composite when --composite, else judge mean
  const scalarReward = COMPOSITE && composite ? composite.composite : judge.meanScore;
  const out = {
    runDir: RUN_DIR,
    provider: PROVIDER,
    judgeModel: JUDGE_MODEL,
    skillFile: SKILL_FILE || null,
    skillChars: skillText.length,
    cases: ids,
    rewardMode: COMPOSITE ? "composite" : "judge",
    reward: scalarReward, // the scalar reward (composite or judge per --composite)
    judgeReward: judge.meanScore, // always keep the raw judge mean
    passRate: judge.passRate,
    perCase: judge.perCase, // per-case JUDGE scores
    composite, // full composite breakdown (rubric, gap, mislabel, per-case)
    advantage,
    perCaseAdvantage,
    baselineMeanScore: baseline?.meanScore ?? null,
    tokens, // proof Siclaw ran (MaaS usage)
    runStatuses: Object.fromEntries(runResults.map((r) => [r.id, r.status])),
    notGraded: judge.notGraded,
    durationSec: Math.round((Date.now() - t0) / 1000),
  };
  fs.writeFileSync(path.join(RUN_DIR, "reward.json"), JSON.stringify(out, null, 2) + "\n");
  // last stdout line = compact machine-readable summary for the orchestrator
  console.log(JSON.stringify({
    reward: out.reward,
    judgeReward: out.judgeReward,
    composite: composite?.composite ?? null,
    rubricMean: composite?.rubricMean ?? null,
    rewardTruthGap: composite?.rewardTruthGap ?? null,
    mislabelRate: composite?.mislabelRate ?? null,
    advantage: out.advantage,
    passRate: out.passRate,
    tokensTotal: tokens.total,
    completed: tokens.completed,
    runDir: RUN_DIR,
  }));
}

main().catch((e) => {
  console.error(`[reward] ERROR`, e?.stack || e?.message || String(e));
  process.exit(1);
});
