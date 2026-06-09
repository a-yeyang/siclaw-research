#!/usr/bin/env node
/**
 * Judge GPU/RDMA case diagnoses against ground truth.
 * Uses keyword matching + semantic scoring (same approach as the main 100-case eval).
 */
import fs from "node:fs";
import path from "node:path";

const CASES = JSON.parse(fs.readFileSync("experiments/aaai-paper/gpu-rdma-cases.json", "utf8"));
const LOGS_DIR = "experiments/aaai-paper/gpu-rdma-logs";

function score(text, keywords) {
  if (!text) return { score: 0, matched: [] };
  const lower = text.toLowerCase();
  const matched = keywords.filter(kw => lower.includes(kw.toLowerCase()));
  return { score: Math.min(1, matched.length / Math.max(keywords.length * 0.6, 1)), matched };
}

const results = [];

for (const c of CASES) {
  const resultPath = path.join(LOGS_DIR, c.id, "result.json");
  if (!fs.existsSync(resultPath)) { console.log(`SKIP ${c.id}: no result`); continue; }

  const r = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const diag = (r.finalText || "").toLowerCase();

  // Localization: check if target resources are mentioned
  const locKeywords = c.targets.map(t => t.split("/").pop());
  // Add node names and GPU IDs from ground truth
  const gtLoc = c.groundTruth.localization.toLowerCase();
  if (gtLoc.includes("gpu")) {
    const gpuMatch = gtLoc.match(/gpu\s*(\d+)/);
    if (gpuMatch) locKeywords.push("gpu " + gpuMatch[1], "gpu" + gpuMatch[1]);
  }
  if (gtLoc.includes("fake-node")) {
    const nodeMatch = gtLoc.match(/fake-node-\d+/);
    if (nodeMatch) locKeywords.push(nodeMatch[0]);
  }
  if (gtLoc.includes("mlx5")) locKeywords.push("mlx5");
  if (gtLoc.includes("nvlink")) locKeywords.push("nvlink");
  const locScore = score(diag, locKeywords);

  // Mechanism: check for key technical terms
  const mechTerms = c.groundTruth.mechanism.toLowerCase()
    .split(/[\s,.()\-\/]+/)
    .filter(w => w.length > 3 && !["that", "this", "with", "from", "node", "the", "and", "for", "are", "its"].includes(w));
  // Add key phrases
  const mechKeywords = [...new Set(mechTerms)].slice(0, 20);
  // Add category-specific keywords
  if (c.category === "gpu-hardware") mechKeywords.push("xid", "ecc", "nvlink", "thermal", "gpu", "cuda", "memory");
  if (c.category === "rdma-network") mechKeywords.push("rdma", "nccl", "pfc", "infiniband", "link", "congestion", "timeout");
  if (c.category === "compound-gpu-rdma") mechKeywords.push("two", "both", "independent", "compound", "simultaneously");
  const mechScore = score(diag, mechKeywords);

  // Scope: check for impact description
  const scopeKeywords = ["single", "all", "node", "cluster", "affected", "impact", "scope", "other"];
  if (c.groundTruth.scope.includes("cluster-wide")) scopeKeywords.push("cluster-wide", "cluster wide", "fabric");
  const scopeScore = score(diag, scopeKeywords);

  // Evidence: check for concrete data references
  const evidenceKeywords = ["evidence", "configmap", "dmesg", "nvidia-smi", "ibstat", "nccl", "error", "log", "counter", "annotation"];
  const evidenceScore = score(diag, evidenceKeywords);

  // Remediation: check for actionable fix
  const remKeywords = ["replace", "cordon", "drain", "cable", "reboot", "fix", "repair", "recommend", "remediation", "inspect", "isolat"];
  const remScore = score(diag, remKeywords);

  // Total weighted score
  const total = 0.30 * locScore.score + 0.30 * mechScore.score + 0.15 * scopeScore.score + 0.15 * evidenceScore.score + 0.10 * remScore.score;
  const passed = total >= 0.62 && locScore.score >= 0.4 && mechScore.score >= 0.4;

  results.push({
    caseId: c.id, category: c.category, difficulty: c.difficulty, title: c.title,
    passed, totalScore: total,
    localization: locScore.score, mechanism: mechScore.score,
    scope: scopeScore.score, evidence: evidenceScore.score, remediation: remScore.score,
    toolCalls: r.toolCalls?.length || 0, durationMs: r.durationMs,
  });
}

// Print results
console.log("\n========== GPU/RDMA FAULT DIAGNOSIS RESULTS ==========\n");
console.log("Case | Category | Diff | Pass | Score | Loc | Mech | Scope | Evid | Rem | Tools | Time");
console.log("-----|----------|------|------|-------|-----|------|-------|------|-----|-------|-----");
for (const r of results) {
  console.log(
    `${r.caseId} | ${r.category.padEnd(18)} | ${r.difficulty.padEnd(6)} | ${r.passed ? "✓" : "✗"} | ` +
    `${r.totalScore.toFixed(3)} | ${r.localization.toFixed(2)} | ${r.mechanism.toFixed(2)} | ` +
    `${r.scope.toFixed(2)} | ${r.evidence.toFixed(2)} | ${r.remediation.toFixed(2)} | ` +
    `${String(r.toolCalls).padStart(5)} | ${(r.durationMs / 1000).toFixed(1)}s`
  );
}

const passed = results.filter(r => r.passed).length;
const avgScore = results.reduce((a, r) => a + r.totalScore, 0) / results.length;
const avgTools = results.reduce((a, r) => a + r.toolCalls, 0) / results.length;
const avgTime = results.reduce((a, r) => a + r.durationMs, 0) / results.length / 1000;

console.log(`\n--- Summary ---`);
console.log(`Passed: ${passed}/${results.length} (${(100 * passed / results.length).toFixed(1)}%)`);
console.log(`Average score: ${avgScore.toFixed(3)}`);
console.log(`Average tools: ${avgTools.toFixed(1)}`);
console.log(`Average time: ${avgTime.toFixed(1)}s`);

// Per-category
const cats = [...new Set(results.map(r => r.category))];
console.log("\n--- Per-Category ---");
for (const cat of cats) {
  const cr = results.filter(r => r.category === cat);
  const cp = cr.filter(r => r.passed).length;
  const cs = cr.reduce((a, r) => a + r.totalScore, 0) / cr.length;
  console.log(`  ${cat}: ${cp}/${cr.length} passed, avg score ${cs.toFixed(3)}`);
}

// LaTeX table
console.log("\n\n--- LaTeX Table ---");
console.log("\\begin{table}[t]");
console.log("\\centering");
console.log("\\caption{GPU/RDMA fault diagnosis results (10 cases, Claude Sonnet 4.6). All cases based on observable-signal simulation of real hardware faults documented in Cui et al.~(2025), Ghorbani et al.~(IMC'25), and SHIFT~(2025).}");
console.log("\\label{tab:gpurdma}");
console.log("\\small");
console.log("\\begin{tabular}{@{}llrrrr@{}}");
console.log("\\toprule");
console.log("\\textbf{Case} & \\textbf{Fault Type} & \\textbf{Pass} & \\textbf{Score} & \\textbf{Tools} & \\textbf{Time} \\\\");
console.log("\\midrule");
for (const r of results) {
  const shortTitle = r.title.length > 45 ? r.title.slice(0, 42) + "..." : r.title;
  console.log(`${r.caseId} & ${shortTitle} & ${r.passed ? "\\checkmark" : "---"} & ${r.totalScore.toFixed(3)} & ${r.toolCalls} & ${(r.durationMs / 1000).toFixed(0)}s \\\\`);
}
console.log("\\midrule");
console.log(`\\textbf{Overall} & & \\textbf{${passed}/${results.length}} & \\textbf{${avgScore.toFixed(3)}} & \\textbf{${avgTools.toFixed(1)}} & \\textbf{${avgTime.toFixed(0)}s} \\\\`);
console.log("\\bottomrule");
console.log("\\end{tabular}");
console.log("\\end{table}");
