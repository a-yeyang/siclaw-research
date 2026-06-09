#!/usr/bin/env node
/**
 * Aggregate per-model LLM-judge results into the Track 1 multi-model comparison.
 * Reads each model's judgments file (uniform judge-llm.mjs output shape) and
 * prints overall + per-dimension + per-category metrics, plus a markdown table.
 */
import fs from "node:fs";

const DIMS = ["localization", "mechanism", "scope", "evidence", "remediation"];
const CASES = JSON.parse(fs.readFileSync("experiments/siclaw-agent-eval/cases/cases.json", "utf8"));
const CAT = Object.fromEntries(CASES.map((c) => [c.id, c.category]));
const CATS = [...new Set(CASES.map((c) => c.category))];

// model tag -> judgments file (claude uses the existing-traces judgment)
const SOURCES = {
  claude: "experiments/aaai-paper/reports/llm-judgments-claude-sonnet-4-6.json",
  kimi: "experiments/aaai-paper/reports/judged/kimi.json",
  deepseek: "experiments/aaai-paper/reports/judged/deepseek.json",
  qwen: "experiments/aaai-paper/reports/judged/qwen.json",
  gpt: "experiments/aaai-paper/reports/judged/gpt.json",
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const rows = {};
for (const [tag, path] of Object.entries(SOURCES)) {
  if (!fs.existsSync(path)) continue;
  const j = JSON.parse(fs.readFileSync(path, "utf8"));
  const ok = j.filter((r) => r.status === "completed");
  if (!ok.length) continue;
  rows[tag] = {
    n: ok.length,
    pass: ok.filter((r) => r.passed).length / ok.length,
    total: mean(ok.map((r) => r.totalScore)),
    dims: Object.fromEntries(DIMS.map((d) => [d, mean(ok.map((r) => r.dimensions?.[d]?.score ?? 0))])),
    tools: mean(ok.map((r) => r.toolCallCount ?? 0)),
    durS: mean(ok.map((r) => (r.durationMs ?? 0) / 1000)),
    byCat: Object.fromEntries(CATS.map((c) => {
      const cc = ok.filter((r) => CAT[r.caseId] === c);
      return [c, cc.length ? { pass: cc.filter((r) => r.passed).length / cc.length, total: mean(cc.map((r) => r.totalScore)), n: cc.length } : null];
    })),
  };
}

const tags = Object.keys(rows);
if (!tags.length) { console.log("no model judgments found yet."); process.exit(0); }

console.log("\n=== Multi-model diagnostic comparison (LLM judge = claude-sonnet-4-6) ===\n");
const hdr = ["Model", "n", "Pass%", "Score", ...DIMS.map((d) => d.slice(0, 5)), "Tools", "Time"];
console.log("| " + hdr.join(" | ") + " |");
console.log("|" + hdr.map(() => "---").join("|") + "|");
for (const t of tags) {
  const r = rows[t];
  const cells = [t, r.n, (100 * r.pass).toFixed(1), r.total.toFixed(3),
    ...DIMS.map((d) => r.dims[d].toFixed(3)), r.tools.toFixed(1), r.durS.toFixed(1) + "s"];
  console.log("| " + cells.join(" | ") + " |");
}

console.log("\n=== Per-category pass% by model ===\n");
console.log("| Category | " + tags.join(" | ") + " |");
console.log("|" + ["---", ...tags.map(() => "---")].join("|") + "|");
for (const c of CATS) {
  const cells = tags.map((t) => { const x = rows[t].byCat[c]; return x ? (100 * x.pass).toFixed(0) + "%" : "—"; });
  console.log("| " + c + " | " + cells.join(" | ") + " |");
}

fs.writeFileSync("experiments/aaai-paper/reports/multimodel-summary.json", JSON.stringify(rows, null, 2) + "\n");
console.log("\nwrote experiments/aaai-paper/reports/multimodel-summary.json");
