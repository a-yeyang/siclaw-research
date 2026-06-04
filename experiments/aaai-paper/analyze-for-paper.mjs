#!/usr/bin/env node
/**
 * AAAI Paper Experiment: Deep Statistical Analysis of 100-Case Evaluation
 *
 * Reads judgments-20260603.json and produces paper-ready statistics:
 * - Per-dimension score distributions
 * - Difficulty-level analysis
 * - Tool efficiency analysis
 * - Failure mode classification
 * - LaTeX table fragments
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const JUDGMENTS_PATH = resolve(
  import.meta.dirname,
  "../siclaw-agent-eval/reports/judgments-20260603.json",
);
const CASES_PATH = resolve(
  import.meta.dirname,
  "../siclaw-agent-eval/cases/cases.json",
);

const rawJudgments = JSON.parse(readFileSync(JUDGMENTS_PATH, "utf-8"));
const cases = JSON.parse(readFileSync(CASES_PATH, "utf-8"));

// Build case lookup for category/difficulty
const caseLookup = {};
for (const c of cases) {
  caseLookup[c.id] = c;
}

// Enrich judgments with category/difficulty from cases.json
const judgments = rawJudgments.map((j) => ({
  ...j,
  category: caseLookup[j.caseId]?.category ?? "unknown",
  difficulty: caseLookup[j.caseId]?.difficulty ?? "unknown",
}));

// ── Per-dimension statistics ──────────────────────────────────────

console.log("========== AAAI PAPER: EVALUATION DEEP ANALYSIS ==========\n");

const dimensions = ["localization", "mechanism", "scope", "evidence", "remediation"];
const dimScores = {};
for (const d of dimensions) {
  dimScores[d] = judgments.map((j) => j.dimensions?.[d]?.score ?? 0);
}

console.log("--- Per-Dimension Score Statistics ---");
console.log("Dimension | Mean | Median | Std | Min | Max | Perfect(=1.0)");
console.log("----------|------|--------|-----|-----|-----|-------------");
for (const d of dimensions) {
  const scores = dimScores[d];
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  const std = Math.sqrt(variance);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const perfect = scores.filter((s) => s >= 0.99).length;
  console.log(
    `${d.padEnd(13)} | ${mean.toFixed(3)} | ${median.toFixed(3)} | ${std.toFixed(3)} | ${min.toFixed(3)} | ${max.toFixed(3)} | ${perfect}/${scores.length}`,
  );
}

// ── Difficulty-level analysis ─────────────────────────────────────

console.log("\n--- Difficulty-Level Analysis ---");
const difficulties = ["easy", "medium", "hard"];
for (const diff of difficulties) {
  const cases = judgments.filter((j) => j.difficulty === diff);
  if (cases.length === 0) continue;
  const passRate = cases.filter((j) => j.passed).length / cases.length;
  const avgScore = cases.reduce((a, j) => a + j.totalScore, 0) / cases.length;
  const avgTools = cases.reduce((a, j) => a + (j.toolCallCount ?? 0), 0) / cases.length;
  const avgDuration =
    cases.reduce((a, j) => a + (j.durationMs ?? 0), 0) / cases.length / 1000;
  console.log(
    `${diff.padEnd(8)}: ${cases.length} cases, pass=${(100 * passRate).toFixed(1)}%, score=${avgScore.toFixed(3)}, tools=${avgTools.toFixed(1)}, time=${avgDuration.toFixed(1)}s`,
  );
}

// ── Tool efficiency analysis ──────────────────────────────────────

console.log("\n--- Tool Efficiency Analysis ---");
const toolCounts = judgments.map((j) => j.toolCallCount ?? 0);
const durations = judgments.map((j) => (j.durationMs ?? 0) / 1000);
const avgTools = toolCounts.reduce((a, b) => a + b, 0) / toolCounts.length;
const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
console.log(`Average tool calls: ${avgTools.toFixed(1)}`);
console.log(`Average duration: ${avgDuration.toFixed(1)}s`);
console.log(`Tool-call range: ${Math.min(...toolCounts)} - ${Math.max(...toolCounts)}`);
console.log(`Duration range: ${Math.min(...durations).toFixed(1)}s - ${Math.max(...durations).toFixed(1)}s`);

// Correlation between tool calls and score
const n = judgments.length;
const scores = judgments.map((j) => j.totalScore);
const meanScore = scores.reduce((a, b) => a + b, 0) / n;
const meanTools = avgTools;
let covST = 0, varS = 0, varT = 0;
for (let i = 0; i < n; i++) {
  covST += (scores[i] - meanScore) * (toolCounts[i] - meanTools);
  varS += (scores[i] - meanScore) ** 2;
  varT += (toolCounts[i] - meanTools) ** 2;
}
const corrST = covST / Math.sqrt(varS * varT);
console.log(`Correlation(score, tool_calls): ${corrST.toFixed(3)}`);

// ── Failure mode classification ───────────────────────────────────

console.log("\n--- Failure Mode Classification ---");
const failures = judgments.filter((j) => !j.passed);
console.log(`Total failures: ${failures.length}/${judgments.length}`);

for (const f of failures) {
  const dims = f.dimensions || {};
  const weakestDim = dimensions.reduce((min, d) =>
    (dims[d]?.score ?? 1) < (dims[min]?.score ?? 1) ? d : min
  , dimensions[0]);

  console.log(
    `  ${f.caseId} (${f.category}, ${f.difficulty}): score=${f.totalScore.toFixed(3)}, ` +
    `weakest=${weakestDim}(${(dims[weakestDim]?.score ?? 0).toFixed(3)}), ` +
    `loc=${(dims.localization?.score ?? 0).toFixed(2)}, ` +
    `mech=${(dims.mechanism?.score ?? 0).toFixed(2)}, ` +
    `scope=${(dims.scope?.score ?? 0).toFixed(2)}`,
  );
}

// Classify failure root causes
const failureModes = {
  localization_miss: 0,
  mechanism_miss: 0,
  scope_miss: 0,
  evidence_miss: 0,
  compound_difficulty: 0,
};
for (const f of failures) {
  const dims = f.dimensions || {};
  if ((dims.localization?.score ?? 0) < 0.5) failureModes.localization_miss++;
  if ((dims.mechanism?.score ?? 0) < 0.45) failureModes.mechanism_miss++;
  if ((dims.scope?.score ?? 0) < 0.3) failureModes.scope_miss++;
  if (f.category === "compound") failureModes.compound_difficulty++;
}
console.log("\nFailure mode distribution:");
for (const [mode, count] of Object.entries(failureModes)) {
  console.log(`  ${mode}: ${count}`);
}

// ── Category-dimension heatmap ────────────────────────────────────

console.log("\n--- Category × Dimension Score Heatmap ---");
const categories = [...new Set(judgments.map((j) => j.category))];
console.log("Category".padEnd(20) + dimensions.map((d) => d.slice(0, 5).padStart(8)).join(""));
console.log("-".repeat(60));
for (const cat of categories) {
  const catCases = judgments.filter((j) => j.category === cat);
  let row = cat.padEnd(20);
  for (const d of dimensions) {
    const dimMean =
      catCases.reduce((a, j) => a + (j.dimensions?.[d]?.score ?? 0), 0) /
      catCases.length;
    row += dimMean.toFixed(3).padStart(8);
  }
  console.log(row);
}

// ── LaTeX table fragments ─────────────────────────────────────────

console.log("\n\n========== LaTeX TABLE: Per-Dimension Scores ==========\n");
console.log("\\begin{table}[t]");
console.log("\\centering");
console.log("\\caption{Per-dimension diagnostic scores averaged across 100 cases.}");
console.log("\\label{tab:dimensions}");
console.log("\\small");
console.log("\\begin{tabular}{@{}lrrrr@{}}");
console.log("\\toprule");
console.log("\\textbf{Dimension} & \\textbf{Weight} & \\textbf{Mean} & \\textbf{Std} & \\textbf{Perfect} \\\\");
console.log("\\midrule");
const weights = { localization: 0.30, mechanism: 0.30, scope: 0.15, evidence: 0.15, remediation: 0.10 };
for (const d of dimensions) {
  const s = dimScores[d];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length;
  const std = Math.sqrt(variance);
  const perfect = s.filter((x) => x >= 0.99).length;
  const name = d.charAt(0).toUpperCase() + d.slice(1);
  console.log(`${name} & ${weights[d]} & ${mean.toFixed(3)} & ${std.toFixed(3)} & ${perfect}/100 \\\\`);
}
console.log("\\bottomrule");
console.log("\\end{tabular}");
console.log("\\end{table}");

console.log("\n\n========== LaTeX TABLE: Difficulty Breakdown ==========\n");
console.log("\\begin{table}[t]");
console.log("\\centering");
console.log("\\caption{Performance by difficulty level.}");
console.log("\\label{tab:difficulty}");
console.log("\\small");
console.log("\\begin{tabular}{@{}lrrrr@{}}");
console.log("\\toprule");
console.log("\\textbf{Difficulty} & \\textbf{Cases} & \\textbf{Pass\\%} & \\textbf{Score} & \\textbf{Time} \\\\");
console.log("\\midrule");
for (const diff of difficulties) {
  const cases = judgments.filter((j) => j.difficulty === diff);
  if (cases.length === 0) continue;
  const passRate = cases.filter((j) => j.passed).length / cases.length;
  const avgScore = cases.reduce((a, j) => a + j.totalScore, 0) / cases.length;
  const avgDur = cases.reduce((a, j) => a + (j.durationMs ?? 0), 0) / cases.length / 1000;
  const name = diff.charAt(0).toUpperCase() + diff.slice(1);
  console.log(`${name} & ${cases.length} & ${(100 * passRate).toFixed(1)}\\% & ${avgScore.toFixed(3)} & ${avgDur.toFixed(1)}s \\\\`);
}
console.log("\\bottomrule");
console.log("\\end{tabular}");
console.log("\\end{table}");

console.log("\n\n========== LaTeX TABLE: Category × Dimension Heatmap ==========\n");
console.log("\\begin{table*}[t]");
console.log("\\centering");
console.log("\\caption{Average scores per category and scoring dimension. Bold indicates scores below 0.70.}");
console.log("\\label{tab:heatmap}");
console.log("\\small");
console.log("\\begin{tabular}{@{}lrrrrrrr@{}}");
console.log("\\toprule");
console.log("\\textbf{Category} & \\textbf{$n$} & \\textbf{Loc.} & \\textbf{Mech.} & \\textbf{Scope} & \\textbf{Evid.} & \\textbf{Remed.} & \\textbf{Total} \\\\");
console.log("\\midrule");
for (const cat of categories) {
  const catCases = judgments.filter((j) => j.category === cat);
  let row = `${cat} & ${catCases.length}`;
  for (const d of dimensions) {
    const mean = catCases.reduce((a, j) => a + (j.dimensions?.[d]?.score ?? 0), 0) / catCases.length;
    const val = mean.toFixed(3);
    row += mean < 0.70 ? ` & \\textbf{${val}}` : ` & ${val}`;
  }
  const total = catCases.reduce((a, j) => a + j.totalScore, 0) / catCases.length;
  row += ` & ${total.toFixed(3)} \\\\`;
  console.log(row);
}
console.log("\\midrule");
{
  let row = `\\textbf{Overall} & \\textbf{100}`;
  for (const d of dimensions) {
    const mean = dimScores[d].reduce((a, b) => a + b, 0) / dimScores[d].length;
    row += ` & ${mean.toFixed(3)}`;
  }
  const overall = scores.reduce((a, b) => a + b, 0) / scores.length;
  row += ` & \\textbf{${overall.toFixed(3)}} \\\\`;
  console.log(row);
}
console.log("\\bottomrule");
console.log("\\end{tabular}");
console.log("\\end{table*}");

console.log("\n========== ANALYSIS COMPLETE ==========");
