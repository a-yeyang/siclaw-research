#!/usr/bin/env node
/**
 * Track 0 — Real LLM-as-judge (replaces the keyword `lower.includes(kw)` scorer).
 *
 * Decomposes each diagnosis into a per-dimension Yes/No checklist (SREGym style),
 * grounds every question in the case's structured ground truth, and asks a judge
 * LLM to answer with supporting evidence + confidence. Scores are the fraction of
 * "Yes" per dimension; total is the equal-weighted mean; pass threshold 0.65.
 *
 * Unlike keyword matching, the judge reads for SEMANTIC correctness: a correct
 * mechanism stated in different words scores Yes; right keywords in a wrong
 * explanation score No.
 *
 * Usage:
 *   node experiments/aaai-paper/judge-llm.mjs \
 *     --judge-model claude-sonnet-4-6 \
 *     --traces-dir experiments/siclaw-agent-eval/logs \
 *     --cases experiments/siclaw-agent-eval/cases/cases.json \
 *     --out experiments/aaai-paper/reports/llm-judgments-claude.json \
 *     [--only c001,c002] [--limit N] [--concurrency 4]
 */
import fs from "node:fs";
import path from "node:path";

// ── args ──────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1] ?? fallback;
}
const JUDGE_MODEL = arg("--judge-model", "claude-sonnet-4-6");
const TRACES_DIR = arg("--traces-dir", "experiments/siclaw-agent-eval/logs");
const CASES_PATH = arg("--cases", "experiments/siclaw-agent-eval/cases/cases.json");
const OUT_PATH = arg("--out", `experiments/aaai-paper/reports/llm-judgments-${JUDGE_MODEL.replace(/[^a-z0-9]+/gi, "-")}.json`);
const COMPARE_PATH = arg("--compare", "experiments/siclaw-agent-eval/reports/judgments-20260603.json");
const CONCURRENCY = Number(arg("--concurrency", "4"));
const LIMIT = arg("--limit") ? Number(arg("--limit")) : null;
const ONLY = new Set((arg("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean));
const PASS_THRESHOLD = 0.65;

// ── secrets ───────────────────────────────────────────────────────────────
function loadSecrets() {
  const p = "experiments/aaai-paper/.secrets.env";
  const env = {};
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return {
    key: process.env.SCITIX_API_KEY || env.SCITIX_API_KEY,
    base: process.env.SCITIX_BASE || env.SCITIX_BASE || "https://api.scitix.ai/model-api",
  };
}
const { key: API_KEY, base: API_BASE } = loadSecrets();
if (!API_KEY) {
  console.error("Missing SCITIX_API_KEY (experiments/aaai-paper/.secrets.env).");
  process.exit(2);
}

// ── checklist: 5 dimensions × 2 Yes/No questions, grounded in ground truth ──
const CHECKLIST = [
  { dim: "localization", questions: [
    { id: "L1", text: "Does the diagnosis identify the SAME target resource(s) as the ground-truth localization (same pod / deployment / service / node / PVC / controller)? Different wording for the same resource counts as Yes." },
    { id: "L2", text: "Does the diagnosis avoid naming an unrelated or merely-downstream/healthy resource as the PRIMARY fault origin?" },
  ]},
  { dim: "mechanism", questions: [
    { id: "M1", text: "Does the diagnosis explain the SAME underlying root-cause mechanism as the ground truth (not just the surface symptom)? Judge the substance, not keyword overlap." },
    { id: "M2", text: "Does the diagnosis include the concrete mutated detail implied by the mechanism (e.g. the wrong image/tag, wrong port, missing env var, bad selector, exhausted quota), rather than a vague guess?" },
  ]},
  { dim: "scope", questions: [
    { id: "S1", text: "Is the stated blast radius / scope of impact consistent with the ground-truth scope (e.g. single pod vs one service path vs compound multi-resource)?" },
    { id: "S2", text: "Does the diagnosis avoid materially OVER-stating or UNDER-stating the impact?" },
  ]},
  { dim: "evidence", questions: [
    { id: "E1", text: "Does the diagnosis cite concrete OBSERVED evidence (pod events, describe output, logs, YAML fields, scheduler/Volcano state) rather than asserting the cause without support?" },
    { id: "E2", text: "Is the cited evidence actually CONSISTENT with the identified root cause (not fabricated, irrelevant, or contradictory)?" },
  ]},
  { dim: "remediation", questions: [
    { id: "R1", text: "Does the recommended remediation actually ADDRESS the identified root cause (would plausibly fix it if applied)?" },
    { id: "R2", text: "Is the remediation safe and appropriately scoped (no destructive over-reach, matches the real fault)?" },
  ]},
];
const ALL_Q = CHECKLIST.flatMap((d) => d.questions.map((q) => ({ ...q, dim: d.dim })));

function buildSystem() {
  return [
    "You are a rigorous Site Reliability Engineering (SRE) evaluator. You grade an AI agent's",
    "Kubernetes fault diagnosis against a known ground truth by answering a fixed Yes/No checklist.",
    "",
    "Principles:",
    "- Judge SEMANTIC correctness, not keyword presence. A correct cause described in different",
    "  words is Yes; the right keywords inside a wrong or unsupported explanation is No.",
    "- Be strict but fair. If the diagnosis is partially right, answer each question independently.",
    "- 'No' when the required content is absent, vague, wrong, or unsupported.",
    "- For each question give one short evidence quote/justification and a confidence (High/Medium/Low).",
    "",
    "Return ONLY a JSON object, no prose, no markdown fences:",
    '{"answers":[{"id":"L1","answer":"Yes|No","evidence":"...","confidence":"High|Medium|Low"}, ...]}',
    "Include exactly one entry per question id provided.",
  ].join("\n");
}

function buildUser(c, diagnosis) {
  const gt = c.groundTruth || {};
  const qlist = ALL_Q.map((q) => `- ${q.id} [${q.dim}]: ${q.text}`).join("\n");
  return [
    `CASE: ${c.id}  CATEGORY: ${c.category}  DIFFICULTY: ${c.difficulty || "?"}`,
    `SYMPTOM PROMPT GIVEN TO AGENT: ${c.symptom || "(n/a)"}`,
    "",
    "GROUND TRUTH:",
    `- localization: ${gt.localization ?? "(n/a)"}`,
    `- mechanism: ${gt.mechanism ?? "(n/a)"}`,
    `- scope: ${gt.scope ?? "(n/a)"}`,
    c.targets ? `- target resources: ${JSON.stringify(c.targets)}` : "",
    "",
    "AGENT DIAGNOSIS (verbatim final answer):",
    '"""',
    (diagnosis || "(empty)").slice(0, 12000),
    '"""',
    "",
    "CHECKLIST (answer every id):",
    qlist,
  ].filter(Boolean).join("\n");
}

// ── judge LLM callers (route by model id) ───────────────────────────────────
const isAnthropic = (model) => /^claude/i.test(model);

async function callJudge(model, system, user, { retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90_000);
      let resp, text;
      if (isAnthropic(model)) {
        resp = await fetch(`${API_BASE}/v1/messages`, {
          method: "POST", signal: ctrl.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}`, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: 2000, temperature: 0, system, messages: [{ role: "user", content: user }] }),
        });
        clearTimeout(timer);
        const j = await resp.json();
        if (j.error) throw new Error(j.error.message || j.error.msg || JSON.stringify(j.error));
        text = Array.isArray(j.content) ? j.content.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
      } else {
        resp = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST", signal: ctrl.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
          body: JSON.stringify({ model, max_tokens: 2000, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
        });
        clearTimeout(timer);
        const j = await resp.json();
        if (j.error) throw new Error(j.error.message || j.error.msg || JSON.stringify(j.error));
        text = j.choices?.[0]?.message?.content ?? "";
      }
      if (!text || !text.trim()) throw new Error("empty judge response");
      return text;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

function extractJSON(text) {
  let t = String(text).trim();
  t = t.replace(/```json\s*/gi, "").replace(/```/g, "");
  // strip <think> blocks some reasoning models emit
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

function scoreFromAnswers(answers) {
  const byId = {};
  for (const a of answers || []) byId[a.id] = a;
  const dims = {};
  for (const d of CHECKLIST) {
    let yes = 0, n = 0;
    const checklist = [];
    for (const q of d.questions) {
      const a = byId[q.id];
      const isYes = a && /^y/i.test(String(a.answer));
      if (a) { n++; if (isYes) yes++; }
      checklist.push({ id: q.id, dim: d.dim, answer: a ? (isYes ? "Yes" : "No") : "Missing", evidence: a?.evidence ?? "", confidence: a?.confidence ?? "" });
    }
    dims[d.dim] = { score: n ? yes / d.questions.length : 0, checklist };
  }
  const dimKeys = CHECKLIST.map((d) => d.dim);
  const total = dimKeys.reduce((s, k) => s + dims[k].score, 0) / dimKeys.length;
  return { dims, total: Math.round(total * 1000) / 1000 };
}

// ── trace loading ───────────────────────────────────────────────────────────
function readTrace(caseId) {
  const p = path.join(TRACES_DIR, caseId, "result.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

async function judgeCase(c) {
  const trace = readTrace(c.id);
  if (!trace) return { caseId: c.id, status: "no-trace", passed: false, totalScore: 0, dimensions: {}, judgeModel: JUDGE_MODEL };
  const diagnosis = trace.finalText ?? trace.result?.finalText ?? "";
  const system = buildSystem();
  const user = buildUser(c, diagnosis);
  let text, parsed;
  try {
    text = await callJudge(JUDGE_MODEL, system, user);
    parsed = extractJSON(text);
  } catch (err) {
    return { caseId: c.id, status: "judge-error", error: String(err).slice(0, 300), passed: false, totalScore: 0, dimensions: {}, judgeModel: JUDGE_MODEL };
  }
  if (!parsed || !Array.isArray(parsed.answers)) {
    return { caseId: c.id, status: "parse-error", raw: String(text).slice(0, 400), passed: false, totalScore: 0, dimensions: {}, judgeModel: JUDGE_MODEL };
  }
  const { dims, total } = scoreFromAnswers(parsed.answers);
  const dimensions = {};
  const checklist = [];
  for (const k of Object.keys(dims)) {
    dimensions[k] = { score: dims[k].score };
    checklist.push(...dims[k].checklist);
  }
  return {
    caseId: c.id, status: "completed", category: c.category, difficulty: c.difficulty,
    passed: total > PASS_THRESHOLD, totalScore: total, dimensions, checklist,
    durationMs: trace.durationMs ?? null, toolCallCount: (trace.toolCalls?.length ?? 0),
    judgeModel: JUDGE_MODEL,
  };
}

// ── concurrency pool ────────────────────────────────────────────────────────
async function pool(items, n, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  }));
  return out;
}

async function main() {
  let cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
  if (ONLY.size) cases = cases.filter((c) => ONLY.has(c.id));
  if (LIMIT != null) cases = cases.slice(0, LIMIT);
  console.error(`[judge] model=${JUDGE_MODEL} cases=${cases.length} concurrency=${CONCURRENCY}`);
  const startedAt = Date.now();
  let done = 0;
  const results = await pool(cases, CONCURRENCY, async (c) => {
    const r = await judgeCase(c);
    done++;
    if (done % 5 === 0 || done === cases.length) console.error(`[judge] ${done}/${cases.length} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    return r;
  });

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2) + "\n");

  // ── summary + comparison vs keyword scorer ──
  const ok = results.filter((r) => r.status === "completed");
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const passRate = ok.filter((r) => r.passed).length / (ok.length || 1);
  const dims = ["localization", "mechanism", "scope", "evidence", "remediation"];
  console.log(`\n=== LLM-judge (${JUDGE_MODEL}) over ${ok.length} graded / ${results.length} cases ===`);
  console.log(`pass(>%.2f) = ${(100 * passRate).toFixed(1)}%   mean total = ${mean(ok.map((r) => r.totalScore)).toFixed(3)}`.replace("%.2f", PASS_THRESHOLD));
  for (const d of dims) console.log(`  ${d.padEnd(13)} ${mean(ok.map((r) => r.dimensions?.[d]?.score ?? 0)).toFixed(3)}`);
  const bad = results.filter((r) => r.status !== "completed");
  if (bad.length) console.log(`  [!] ${bad.length} not graded: ${bad.map((b) => `${b.caseId}:${b.status}`).join(", ").slice(0, 300)}`);

  if (fs.existsSync(COMPARE_PATH)) {
    const kw = JSON.parse(fs.readFileSync(COMPARE_PATH, "utf8"));
    const kwById = {}; for (const j of (Array.isArray(kw) ? kw : [])) kwById[j.caseId] = j;
    const deltas = ok.map((r) => ({ id: r.caseId, llm: r.totalScore, kw: kwById[r.caseId]?.totalScore ?? null }))
      .filter((x) => x.kw != null);
    const meanKw = mean(deltas.map((d) => d.kw)), meanLlm = mean(deltas.map((d) => d.llm));
    console.log(`\n=== keyword scorer vs LLM judge (n=${deltas.length}) ===`);
    console.log(`  keyword mean total = ${meanKw.toFixed(3)}`);
    console.log(`  LLM     mean total = ${meanLlm.toFixed(3)}   (delta ${(meanLlm - meanKw).toFixed(3)})`);
    const biggest = deltas.map((d) => ({ ...d, diff: d.llm - d.kw })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 12);
    console.log("  largest disagreements (id  keyword -> llm):");
    for (const d of biggest) console.log(`    ${d.id}  ${d.kw.toFixed(2)} -> ${d.llm.toFixed(2)}  (${d.diff >= 0 ? "+" : ""}${d.diff.toFixed(2)})`);
  }
  console.log(`\nwrote ${OUT_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
