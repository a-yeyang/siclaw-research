#!/usr/bin/env node
/**
 * κ-validation step 3: compute Cohen's κ (SREGym Table-2 style).
 *
 *   node compute-kappa.mjs                       # inter-judge κ (Claude vs Kimi vs DeepSeek)
 *   node compute-kappa.mjs --human kappa/annotation-template.md   # + judge-vs-human κ
 *
 * Inter-judge uses per-QUESTION binaries (10/case). Judge-vs-human uses per-DIMENSION
 * binaries (5/case, the granularity of the human form).
 */
import fs from "node:fs";

const arg = (k) => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1]; };
const DIR = "experiments/aaai-paper/kappa";
const DIMS = ["localization", "mechanism", "scope", "evidence", "remediation"];
const yn = (s) => /^y/i.test(String(s)) ? 1 : 0;

function cohenKappa(a, b) {
  const n = a.length; if (!n) return { kappa: NaN, agree: NaN, n: 0 };
  let agree = 0; const c = [[0, 0], [0, 0]];
  for (let i = 0; i < n; i++) { c[a[i]][b[i]]++; if (a[i] === b[i]) agree++; }
  const po = agree / n;
  const pa1 = (c[1][0] + c[1][1]) / n, pb1 = (c[0][1] + c[1][1]) / n;
  const pe = pa1 * pb1 + (1 - pa1) * (1 - pb1);
  return { kappa: pe === 1 ? 1 : (po - pe) / (1 - pe), agree: po, n };
}

// ── load each judge's per-question answers, keyed by caseId ──
function loadJudgeQuestions(file, isSample) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const map = {};
  for (const r of raw) {
    const cid = r.caseId;
    const checklist = isSample ? r.judgeClaude?.perQuestion : r.checklist;
    if (!checklist) continue;
    map[cid] = Object.fromEntries(checklist.map((q) => [q.id, yn(q.answer)]));
  }
  return map;
}
function loadJudgeDims(file, isSample) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const map = {};
  for (const r of raw) {
    if (isSample) { map[r.caseId] = Object.fromEntries(DIMS.map((d) => [d, yn(r.judgeClaude.perDimension[d])])); }
    else { map[r.caseId] = Object.fromEntries(DIMS.map((d) => [d, (r.dimensions?.[d]?.score ?? 0) >= 0.5 ? 1 : 0])); }
  }
  return map;
}

const judges = { Claude: { q: loadJudgeQuestions(`${DIR}/sample.json`, true), d: loadJudgeDims(`${DIR}/sample.json`, true) } };
for (const [name, f] of [["Kimi", `${DIR}/judge-kimi.json`], ["DeepSeek", `${DIR}/judge-deepseek.json`]]) {
  if (fs.existsSync(f)) judges[name] = { q: loadJudgeQuestions(f, false), d: loadJudgeDims(f, false) };
}

const names = Object.keys(judges);
const caseIds = Object.keys(judges.Claude.q);

console.log(`\n=== Inter-judge agreement (per-question, ${caseIds.length} cases × 10 q) ===`);
console.log("Judges agreeing on the same diagnoses → the judge metric is stable across models.\n");
console.log("| Pair | κ | Agreement |");
console.log("|---|---|---|");
for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
  const A = [], B = [];
  for (const cid of caseIds) {
    const qa = judges[names[i]].q[cid], qb = judges[names[j]].q[cid];
    if (!qa || !qb) continue;
    for (const qid of Object.keys(qa)) if (qb[qid] != null) { A.push(qa[qid]); B.push(qb[qid]); }
  }
  const { kappa, agree, n } = cohenKappa(A, B);
  console.log(`| ${names[i]} vs ${names[j]} | ${kappa.toFixed(3)} | ${(100 * agree).toFixed(1)}% (n=${n}) |`);
}

// ── judge-vs-human (per dimension) ──
const humanFile = arg("--human");
if (humanFile && fs.existsSync(humanFile)) {
  const txt = fs.readFileSync(humanFile, "utf8");
  const human = {}; let cur = null;
  for (const line of txt.split("\n")) {
    const h = line.match(/^##\s*\d+\.\s*(\S+)/); if (h) { cur = h[1]; human[cur] = {}; continue; }
    const m = line.match(/\*\*(\w+)\*\*:.*\[\s*(Yes|No|Y|N)\s*\]/i);
    if (m && cur && DIMS.includes(m[1])) human[cur][m[1]] = yn(m[2]);
  }
  const filled = Object.values(human).filter((h) => Object.keys(h).length).length;
  console.log(`\n=== Judge (Claude) vs Human (per-dimension, ${filled} cases filled) ===`);
  if (!filled) { console.log("  (no answers filled in the template yet — write Yes/No in the [ ] then re-run)"); }
  else {
    console.log("| Dimension | κ | Agreement |");
    console.log("|---|---|---|");
    let allA = [], allB = [];
    for (const d of DIMS) {
      const A = [], B = [];
      for (const cid of Object.keys(human)) {
        if (human[cid][d] == null || judges.Claude.d[cid]?.[d] == null) continue;
        A.push(judges.Claude.d[cid][d]); B.push(human[cid][d]);
      }
      const { kappa, agree } = cohenKappa(A, B); allA.push(...A); allB.push(...B);
      console.log(`| ${d} | ${isNaN(kappa) ? "—" : kappa.toFixed(3)} | ${isNaN(agree) ? "—" : (100 * agree).toFixed(0) + "%"} |`);
    }
    const ov = cohenKappa(allA, allB);
    console.log(`| **overall** | **${ov.kappa.toFixed(3)}** | **${(100 * ov.agree).toFixed(1)}%** |`);
    console.log(`\nSREGym reports κ≈0.90 judge-vs-human. Target ≥0.7 (substantial) — ideally ≥0.8.`);
  }
}
console.log("");
