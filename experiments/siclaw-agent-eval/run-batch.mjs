#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = "experiments/siclaw-agent-eval";
const CASES_PATH = path.join(ROOT, "cases", "cases.json");
const HARNESS = path.join(ROOT, "eval-harness.mjs");
const NODE = process.execPath;

function argValue(name, fallback = undefined) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

const concurrency = Number(argValue("--concurrency", process.env.SICLAW_EVAL_CONCURRENCY || "1"));
const timeoutMs = Number(argValue("--timeout-ms", process.env.SICLAW_EVAL_TIMEOUT_MS || "240000"));
const caseRetries = Number(argValue("--case-retries", process.env.SICLAW_EVAL_CASE_RETRIES || "0"));
const harnessGuard = argValue("--harness-guard", process.env.SICLAW_EVAL_GUARD || "low-cost");
const limit = argValue("--limit") ? Number(argValue("--limit")) : null;
const only = new Set((argValue("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean));
const rerun = process.argv.includes("--rerun");

let cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
if (only.size > 0) cases = cases.filter((c) => only.has(c.id));
if (limit !== null) cases = cases.slice(0, limit);

function existingDone(c) {
  const out = path.join(ROOT, "logs", c.id, "result.json");
  if (!fs.existsSync(out)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
    const finalText = parsed.finalText ?? parsed.result?.finalText ?? "";
    const toolCalls = parsed.toolCalls ?? parsed.result?.toolCalls ?? [];
    return parsed.status === "completed"
      && typeof finalText === "string"
      && finalText.trim().length > 0
      && Array.isArray(toolCalls)
      && toolCalls.length > 0;
  } catch {
    return false;
  }
}

const queue = cases.filter((c) => rerun || !existingDone(c));
const completed = [];
const failed = [];
let active = 0;
let cursor = 0;
const startedAt = Date.now();

function runCase(c, attempt = 1) {
  active += 1;
  const dir = path.join(ROOT, "logs", c.id);
  fs.mkdirSync(dir, { recursive: true });
  const stdoutPath = path.join(dir, "runner.stdout.log");
  const stderrPath = path.join(dir, "runner.stderr.log");
  const outPath = path.join(dir, "result.json");
  const promptPath = path.join(dir, "prompt.txt");
  const stdout = fs.createWriteStream(stdoutPath, { flags: "a" });
  const stderr = fs.createWriteStream(stderrPath, { flags: "a" });
  const args = [
    HARNESS,
    "--case-id", c.id,
    "--prompt-file", promptPath,
    "--output-file", outPath,
    "--timeout-ms", String(timeoutMs),
    "--guard", harnessGuard,
  ];
  const child = spawn(NODE, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: process.env.PATH,
    },
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.on("close", (code) => {
    active -= 1;
    stdout.end();
    stderr.end();
    let status = code === 0 ? "ok" : `exit-${code}`;
    try {
      const parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
      status = parsed.status;
    } catch {
      // keep process status
    }
    const rec = { id: c.id, category: c.category, status, code };
    if (!(code === 0 && status === "completed") && attempt <= caseRetries) {
      const delayMs = Math.min(30000, 3000 * attempt);
      console.log(JSON.stringify({
        retrying: true,
        id: c.id,
        category: c.category,
        status,
        code,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      }));
      setTimeout(() => runCase(c, attempt + 1), delayMs);
      return;
    }
    if (code === 0 && status === "completed") completed.push({ ...rec, attempts: attempt });
    else failed.push({ ...rec, attempts: attempt });
    console.log(JSON.stringify({
      done: completed.length + failed.length,
      total: queue.length,
      active,
      ...rec,
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    }));
    pump();
  });
}

function pump() {
  while (active < concurrency && cursor < queue.length) {
    runCase(queue[cursor++]);
  }
  if (active === 0 && cursor >= queue.length) {
    const summary = {
      totalSelected: cases.length,
      skippedExisting: cases.length - queue.length,
      attempted: queue.length,
      completed: completed.length,
      failed: failed.length,
      failures: failed,
      durationSec: Math.round((Date.now() - startedAt) / 1000),
    };
    fs.writeFileSync(path.join(ROOT, "logs", "batch-summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log(JSON.stringify(summary));
    process.exit(failed.length > 0 ? 1 : 0);
  }
}

console.log(JSON.stringify({ totalSelected: cases.length, queued: queue.length, concurrency, timeoutMs, caseRetries, harnessGuard }));
pump();
