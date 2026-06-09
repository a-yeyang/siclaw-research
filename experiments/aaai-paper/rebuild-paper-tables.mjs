#!/usr/bin/env node
// Read-only aggregator: rebuilds the paper's Evaluation tables from the REAL
// LLM-judge per-case judgments (no agent runs, no cluster, no LLM calls — pure
// data processing over committed judgment files). Produces authoritative numbers
// to replace the keyword-era figures in paper/siclaw-aaai.tex.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const R = (p) => JSON.parse(readFileSync(join(HERE, p), 'utf8'));

// Real LLM-judge (Claude Sonnet 4.6) per-case judgments, one file per agent brain.
const MODELS = {
  claude:   'reports/llm-judgments-claude-sonnet-4-6.json',
  kimi:     'reports/judged/kimi.json',
  deepseek: 'reports/judged/deepseek.json',
  qwen:     'reports/judged/qwen.json',
};
const DIMS = ['localization', 'mechanism', 'scope', 'evidence', 'remediation'];
const CAT_ORDER = ['image-pull','crashloop','config','scheduling-gpu','storage',
  'service-readiness','network-dns','controller','volcano-gpu','compound'];

function mean(xs){ return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0; }
function f(x,d=3){ return Number(x).toFixed(d); }

const loaded = {};
for (const [m,p] of Object.entries(MODELS)) {
  const arr = R(p);
  loaded[m] = (Array.isArray(arr)?arr:Object.values(arr)).filter(r=>r && r.dimensions);
}

console.log('=== PER-MODEL OVERALL (real LLM judge, N=100 each) ===');
console.log('model      n   pass%  score   loc    mech   scope  evid   remed');
for (const m of Object.keys(MODELS)) {
  const rows = loaded[m];
  const pass = mean(rows.map(r=>r.passed?1:0));
  const tot  = mean(rows.map(r=>r.totalScore));
  const dim  = DIMS.map(d=>mean(rows.map(r=>r.dimensions[d]?.score ?? 0)));
  console.log(`${m.padEnd(9)} ${String(rows.length).padStart(3)}  ${f(pass*100,1).padStart(5)}  ${f(tot)}  ${dim.map(x=>f(x,3)).join('  ')}`);
}

console.log('\n=== PER-CATEGORY PASS% (per model) + MEAN ===');
console.log('category            n  '+Object.keys(MODELS).map(m=>m.slice(0,4).padStart(6)).join(' ')+'   mean');
for (const cat of CAT_ORDER) {
  const cells = [];
  let n = 0;
  for (const m of Object.keys(MODELS)) {
    const rows = loaded[m].filter(r=>r.category===cat);
    n = rows.length;
    cells.push(mean(rows.map(r=>r.passed?1:0))*100);
  }
  console.log(`${cat.padEnd(18)} ${String(n).padStart(2)}  ${cells.map(x=>f(x,1).padStart(6)).join(' ')}   ${f(mean(cells),1)}`);
}

console.log('\n=== PER-CATEGORY SCORE (per model) + MEAN ===');
console.log('category            n  '+Object.keys(MODELS).map(m=>m.slice(0,4).padStart(6)).join(' ')+'   mean');
for (const cat of CAT_ORDER) {
  const cells = [];
  let n=0;
  for (const m of Object.keys(MODELS)) {
    const rows = loaded[m].filter(r=>r.category===cat);
    n = rows.length;
    cells.push(mean(rows.map(r=>r.totalScore)));
  }
  console.log(`${cat.padEnd(18)} ${String(n).padStart(2)}  ${cells.map(x=>f(x,3).padStart(6)).join(' ')}   ${f(mean(cells),3)}`);
}

console.log('\n=== CATEGORY x DIMENSION heatmap (Claude reference brain) ===');
console.log('category            n   '+DIMS.map(d=>d.slice(0,5).padStart(6)).join(' ')+'   total');
for (const cat of CAT_ORDER) {
  const rows = loaded.claude.filter(r=>r.category===cat);
  const dimv = DIMS.map(d=>mean(rows.map(r=>r.dimensions[d]?.score ?? 0)));
  const tot = mean(rows.map(r=>r.totalScore));
  console.log(`${cat.padEnd(18)} ${String(rows.length).padStart(2)}   ${dimv.map(x=>f(x,3).padStart(6)).join(' ')}   ${f(tot)}`);
}
{
  const rows = loaded.claude;
  const dimv = DIMS.map(d=>mean(rows.map(r=>r.dimensions[d]?.score ?? 0)));
  console.log(`${'OVERALL'.padEnd(18)} ${String(rows.length).padStart(2)}   ${dimv.map(x=>f(x,3).padStart(6)).join(' ')}   ${f(mean(rows.map(r=>r.totalScore)))}`);
}

console.log('\n=== DIFFICULTY SCALING (Claude reference) ===');
for (const diff of ['easy','medium','hard']) {
  const rows = loaded.claude.filter(r=>r.difficulty===diff);
  if (!rows.length) continue;
  console.log(`${diff.padEnd(7)} n=${String(rows.length).padStart(3)}  pass%=${f(mean(rows.map(r=>r.passed?1:0))*100,1)}  score=${f(mean(rows.map(r=>r.totalScore)))}`);
}

console.log('\n=== MEASURED SECURITY VIOLATIONS (benign diagnosis, 4 models x 100) ===');
const bv = R('reports/benign-violations.json');
let totBlocked=0, totTools=0;
console.log('model      blocked  cases-w/-viol  per-case  toolcalls');
for (const [m,v] of Object.entries(bv.perModel)) {
  totBlocked += v.blocked; totTools += v.totalToolCalls;
  console.log(`${m.padEnd(9)} ${String(v.blocked).padStart(7)}  ${String(v.casesWithViolation).padStart(12)}  ${f(v.perCase,2).padStart(8)}  ${String(v.totalToolCalls).padStart(8)}`);
}
console.log(`TOTAL     ${String(totBlocked).padStart(7)}  ${''.padStart(12)}  ${f(totBlocked/400,3).padStart(8)}  ${String(totTools).padStart(8)}`);
console.log('by-layer:', JSON.stringify(bv.byCat));

console.log('\n=== INDIRECT INJECTION (12 payloads x 3 models = 36) ===');
const inj = R('runs-injection/injection-summary.json');
let iN=0,iAtt=0,iLeak=0;
for (const [m,v] of Object.entries(inj.rows)) { iN+=v.n; iAtt+=v.attempted; iLeak+=v.leaked;
  console.log(`${m.padEnd(9)} n=${v.n} attempted=${v.attempted} blocked/neutralized=${v.blocked} leaked=${v.leaked}`); }
console.log(`TOTAL trials=${iN}  refused=${iN-iAtt}/${iN}  attempted=${iAtt}  exfiltrated=${iLeak}`);
