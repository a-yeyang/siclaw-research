#!/usr/bin/env node
/**
 * Multi-model agent-run orchestrator (Track 1 + Track 4).
 *
 * Runs the SAME 100 cases through several models by pointing each child
 * eval-harness at a per-model SICLAW_CONFIG_DIR. Reuses the canonical prompts
 * already generated under siclaw-agent-eval/logs/<case>/prompt.txt. Outputs to
 * experiments/aaai-paper/runs/<model>/<case>[/s<seed>]/result.json.
 *
 *   node experiments/aaai-paper/run-models.mjs \
 *     --models claude,kimi,deepseek,qwen --concurrency 6 --seeds 1 \
 *     [--only c001,c002] [--limit N] [--timeout-ms 240000] [--rerun]
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const CODEX_NODE = "/Users/yye/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";
const NODE = fs.existsSync(CODEX_NODE) ? CODEX_NODE : process.execPath;
const EVAL_ROOT = "experiments/siclaw-agent-eval";
const HARNESS = path.join(EVAL_ROOT, "eval-harness.mjs");
const CASES_PATH = path.join(EVAL_ROOT, "cases", "cases.json");
const PROMPT_DIR = arg("--prompt-dir", path.join(EVAL_ROOT, "logs"));   // canonical prompts; override for hard mode
const OUT_ROOT = arg("--out-root", "experiments/aaai-paper/runs");      // per-experiment output root
const PROVIDERS = "experiments/aaai-paper/providers";
const KUBECONFIG = ".siclaw/credentials/cks-test.kubeconfig";

function arg(name, fb) { const i = process.argv.indexOf(name); return i < 0 ? fb : process.argv[i + 1] ?? fb; }
const MODELS = (arg("--models", "claude,kimi,deepseek,qwen")).split(",").map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Number(arg("--concurrency", "6"));
const SEEDS = Number(arg("--seeds", "1"));
const TIMEOUT_MS = Number(arg("--timeout-ms", "240000"));
const GUARD = arg("--guard", "low-cost");
const LIMIT = arg("--limit") ? Number(arg("--limit")) : null;
const ONLY = new Set((arg("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean));
const RERUN = process.argv.includes("--rerun");

let cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
if (ONLY.size) cases = cases.filter((c) => ONLY.has(c.id));
if (LIMIT != null) cases = cases.slice(0, LIMIT);

function outPath(model, caseId, seed) {
  const leaf = SEEDS > 1 ? path.join(caseId, `s${seed}`) : caseId;
  return path.join(OUT_ROOT, model, leaf, "result.json");
}
function done(model, caseId, seed) {
  const p = outPath(model, caseId, seed);
  if (!fs.existsSync(p)) return false;
  try { const r = JSON.parse(fs.readFileSync(p, "utf8")); return r.status === "completed" && (r.finalText || "").trim() && (r.toolCalls || []).length > 0; }
  catch { return false; }
}

// build task list
const tasks = [];
for (const model of MODELS) {
  const cfg = path.join(PROVIDERS, model, ".siclaw", "config");
  if (!fs.existsSync(path.join(cfg, "settings.json"))) { console.error(`[skip] no provider config for ${model} (run setup-providers.mjs)`); continue; }
  for (const c of cases) {
    const promptFile = path.join(PROMPT_DIR, c.id, "prompt.txt");
    if (!fs.existsSync(promptFile)) { console.error(`[skip] missing prompt ${promptFile}`); continue; }
    for (let seed = 1; seed <= SEEDS; seed++) {
      if (!RERUN && done(model, c.id, seed)) continue;
      tasks.push({ model, cfg, c, seed, promptFile });
    }
  }
}

console.log(JSON.stringify({ models: MODELS, cases: cases.length, seeds: SEEDS, queued: tasks.length, concurrency: CONCURRENCY }));
const started = Date.now();
let cursor = 0, active = 0, ndone = 0;
const tally = {};

function run(t) {
  active++;
  const out = outPath(t.model, t.c.id, t.seed);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const so = fs.createWriteStream(path.join(path.dirname(out), "runner.stdout.log"), { flags: "a" });
  const se = fs.createWriteStream(path.join(path.dirname(out), "runner.stderr.log"), { flags: "a" });
  const child = spawn(NODE, [
    HARNESS, "--case-id", t.c.id, "--prompt-file", t.promptFile,
    "--output-file", out, "--kubeconfig", KUBECONFIG,
    "--timeout-ms", String(TIMEOUT_MS), "--guard", GUARD,
    // scitix's claude proxy rejects pi-ai's adaptive-thinking effort param → disable thinking for claude.
    "--thinking", t.model === "claude" ? "off" : "high",
  ], { cwd: process.cwd(), env: { ...process.env, SICLAW_CONFIG_DIR: t.cfg, PATH: `${path.dirname(NODE)}:${process.env.PATH}` } });
  child.stdout.pipe(so); child.stderr.pipe(se);
  child.on("close", (code) => {
    active--; so.end(); se.end();
    let status = code === 0 ? "ok" : `exit-${code}`;
    try { status = JSON.parse(fs.readFileSync(out, "utf8")).status; } catch {}
    tally[t.model] = tally[t.model] || { completed: 0, failed: 0 };
    if (status === "completed") tally[t.model].completed++; else tally[t.model].failed++;
    ndone++;
    console.log(JSON.stringify({ done: ndone, total: tasks.length, active, model: t.model, id: t.c.id, seed: t.seed, status, sec: Math.round((Date.now() - started) / 1000) }));
    pump();
  });
}
function pump() {
  while (active < CONCURRENCY && cursor < tasks.length) run(tasks[cursor++]);
  if (active === 0 && cursor >= tasks.length) {
    const summary = { models: MODELS, queued: tasks.length, tally, durationSec: Math.round((Date.now() - started) / 1000) };
    fs.mkdirSync(OUT_ROOT, { recursive: true });
    fs.writeFileSync(path.join(OUT_ROOT, "run-summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify(summary));
    process.exit(0);
  }
}
pump();
