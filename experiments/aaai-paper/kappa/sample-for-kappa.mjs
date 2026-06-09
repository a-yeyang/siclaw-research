#!/usr/bin/env node
/**
 * κ-validation step 1: stratified-sample diagnoses for inter-rater agreement.
 *
 * Produces:
 *   kappa/sample.json            — sampled cases + the Claude judge's per-question
 *                                  and per-dimension answers (for κ computation).
 *   kappa/annotation-template.md — a BLIND human-annotation form (no judge answers
 *                                  shown). A human reads each agent diagnosis and
 *                                  writes Yes/No per dimension. → judge-vs-human κ.
 *
 * Why: the paper's diagnostic numbers rest on an LLM judge. SREGym validated its
 * judge at κ=0.90 vs humans. This kit reproduces that validation.
 *
 *   node experiments/aaai-paper/kappa/sample-for-kappa.mjs [--n 24]
 */
import fs from "node:fs";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const N = Number(arg("--n", "24"));
const JUDGMENTS = "experiments/aaai-paper/reports/llm-judgments-claude-sonnet-4-6.json";
const CASES = "experiments/siclaw-agent-eval/cases/cases.json";
const TRACES = "experiments/siclaw-agent-eval/logs";
const OUT = "experiments/aaai-paper/kappa";

const judg = JSON.parse(fs.readFileSync(JUDGMENTS, "utf8")).filter((j) => j.status === "completed");
const cases = Object.fromEntries(JSON.parse(fs.readFileSync(CASES, "utf8")).map((c) => [c.id, c]));
const DIMS = ["localization", "mechanism", "scope", "evidence", "remediation"];

// stratified by category, ~proportional, with a pass/fail mix
const byCat = {};
for (const j of judg) (byCat[cases[j.caseId]?.category || "?"] ||= []).push(j);
const cats = Object.keys(byCat);
const perCat = Math.max(1, Math.round(N / cats.length));
const sampled = [];
for (const c of cats) {
  const pool = byCat[c];
  const passed = pool.filter((j) => j.passed), failed = pool.filter((j) => !j.passed);
  // deterministic: take alternating fail/pass to guarantee a mix (no RNG → reproducible)
  const pick = [...failed, ...passed].slice(0, perCat);
  sampled.push(...pick);
}
const sample = sampled.slice(0, N);

function diagnosisFor(caseId) {
  const p = path.join(TRACES, caseId, "result.json");
  if (!fs.existsSync(p)) return "(trace missing)";
  try { return (JSON.parse(fs.readFileSync(p, "utf8")).finalText || "").trim(); } catch { return "(unreadable)"; }
}
// judge per-dimension binary: dimension satisfied iff score >= 0.5
const dimBinary = (j, d) => (j.dimensions?.[d]?.score ?? 0) >= 0.5 ? "Yes" : "No";

const records = sample.map((j) => {
  const c = cases[j.caseId] || {};
  return {
    caseId: j.caseId, category: c.category, difficulty: c.difficulty,
    groundTruth: c.groundTruth, symptom: c.symptom,
    diagnosis: diagnosisFor(j.caseId),
    judgeClaude: { perDimension: Object.fromEntries(DIMS.map((d) => [d, dimBinary(j, d)])),
                   perQuestion: (j.checklist || []).map((q) => ({ id: q.id, dim: q.dim, answer: q.answer })) },
  };
});

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "sample.json"), JSON.stringify(records, null, 2) + "\n");

// ── human annotation template (BLIND: judge answers NOT shown) ──
const Q = {
  localization: "Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?",
  mechanism: "Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?",
  scope: "Did it correctly state the blast radius / scope (single resource vs service path vs compound)?",
  evidence: "Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?",
  remediation: "Did it propose a fix that would actually address the root cause and is safe?",
};
let md = `# Human annotation for judge validation (κ)

**You are the human expert here.** For each of the ${records.length} cases below, read the **AGENT DIAGNOSIS** and answer the 5 Yes/No questions, comparing against the **GROUND TRUTH**. Write \`Yes\` or \`No\` in each \`[ ]\`. Don't overthink — your honest judgment is the point.

- "Yes" = the diagnosis satisfies that question. "No" = it doesn't (wrong, missing, or vague).
- You are NOT shown the LLM judge's answers (so your labels are unbiased). We later compute how often you and the judge agree (Cohen's κ).
- ~5–10 min total. When done, save this file and run \`compute-kappa.mjs\`.

---
`;
for (const [i, r] of records.entries()) {
  md += `\n## ${i + 1}. ${r.caseId} (${r.category}, ${r.difficulty})\n`;
  md += `**Symptom:** ${r.symptom || "(n/a)"}\n\n`;
  md += `**GROUND TRUTH** — localization: \`${r.groundTruth?.localization}\`; mechanism: ${r.groundTruth?.mechanism}; scope: ${r.groundTruth?.scope}\n\n`;
  md += `**AGENT DIAGNOSIS:**\n> ${(r.diagnosis || "(empty)").replace(/\n/g, "\n> ").slice(0, 1600)}\n\n`;
  for (const d of DIMS) md += `- **${d}**: ${Q[d]}  →  [ ]\n`;
  md += `\n---\n`;
}
fs.writeFileSync(path.join(OUT, "annotation-template.md"), md);

console.log(`Sampled ${records.length} cases across ${cats.length} categories (${sample.filter((j)=>!j.passed).length} fail / ${sample.filter((j)=>j.passed).length} pass).`);
console.log(`  → ${OUT}/sample.json (judge answers, for κ)`);
console.log(`  → ${OUT}/annotation-template.md (BLANK human form — fill the [ ] with Yes/No)`);
console.log(`  sampled ids: ${records.map((r) => r.caseId).join(",")}`);
