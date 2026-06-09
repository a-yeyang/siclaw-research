#!/usr/bin/env node
/**
 * Surgical re-run of the Kimi judge over ONLY the cases that previously failed
 * ("empty judge response" from the scitix gateway). Reuses the EXACT checklist,
 * system prompt, user prompt and scoring as judge-llm.mjs — only difference is
 * retries are capped at 2 (token discipline) and we merge results back into
 * kappa/judge-kimi.json in place, preserving the deepseek-shaped structure.
 *
 *   node retry-kimi-failed.mjs               # retry every status!=completed case
 *   node retry-kimi-failed.mjs --dry         # list which cases would be retried, make no calls
 *
 * Budget: <= (#failed) * 2 gateway calls.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = "experiments/aaai-paper";
const KIMI_OUT = `${ROOT}/kappa/judge-kimi.json`;
const CASES_PATH = "experiments/siclaw-agent-eval/cases/cases.json";
const TRACES_DIR = "experiments/siclaw-agent-eval/logs";
const JUDGE_MODEL = "moonshotai/Kimi-K2.5";
const PASS_THRESHOLD = 0.65;
const DRY = process.argv.includes("--dry");

// ── secrets (same loader shape as judge-llm.mjs; never logged) ──────────────
function loadSecrets() {
  const p = `${ROOT}/.secrets.env`;
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
if (!API_KEY) { console.error("Missing SCITIX_API_KEY"); process.exit(2); }

// ── checklist (verbatim from judge-llm.mjs) ─────────────────────────────────
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

let CALLS = 0;
async function callJudge(system, user, { retries = 2 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      CALLS++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90_000);
      const resp = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST", signal: ctrl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 2000, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
      clearTimeout(timer);
      const j = await resp.json();
      if (j.error) throw new Error(j.error.message || j.error.msg || JSON.stringify(j.error));
      const text = j.choices?.[0]?.message?.content ?? "";
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
    let yes = 0, n = 0; const checklist = [];
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
function readTrace(caseId) {
  const p = path.join(TRACES_DIR, caseId, "result.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

async function judgeCase(c) {
  const trace = readTrace(c.id);
  if (!trace) return { caseId: c.id, status: "no-trace", passed: false, totalScore: 0, dimensions: {}, judgeModel: JUDGE_MODEL };
  const diagnosis = trace.finalText ?? trace.result?.finalText ?? "";
  let text, parsed;
  try { text = await callJudge(buildSystem(), buildUser(c, diagnosis)); parsed = extractJSON(text); }
  catch (err) { return { caseId: c.id, status: "judge-error", error: String(err).slice(0, 300), passed: false, totalScore: 0, dimensions: {}, judgeModel: JUDGE_MODEL }; }
  if (!parsed || !Array.isArray(parsed.answers)) return { caseId: c.id, status: "parse-error", raw: String(text).slice(0, 400), passed: false, totalScore: 0, dimensions: {}, judgeModel: JUDGE_MODEL };
  const { dims, total } = scoreFromAnswers(parsed.answers);
  const dimensions = {}, checklist = [];
  for (const k of Object.keys(dims)) { dimensions[k] = { score: dims[k].score }; checklist.push(...dims[k].checklist); }
  return { caseId: c.id, status: "completed", category: c.category, difficulty: c.difficulty, passed: total > PASS_THRESHOLD, totalScore: total, dimensions, checklist, durationMs: trace.durationMs ?? null, toolCallCount: (trace.toolCalls?.length ?? 0), judgeModel: JUDGE_MODEL };
}

async function main() {
  const existing = JSON.parse(fs.readFileSync(KIMI_OUT, "utf8"));
  const cases = Object.fromEntries(JSON.parse(fs.readFileSync(CASES_PATH, "utf8")).map((c) => [c.id, c]));
  const failedIdx = existing.map((r, i) => ({ r, i })).filter(({ r }) => r.status !== "completed" || !(r.checklist?.length === 10));
  console.error(`[retry-kimi] ${failedIdx.length} cases need retry: ${failedIdx.map(({ r }) => r.caseId).join(",")}`);
  if (DRY) { console.error("[retry-kimi] --dry: no gateway calls made."); return; }
  if (!failedIdx.length) { console.error("[retry-kimi] nothing to do."); return; }

  let fixed = 0;
  for (const { r, i } of failedIdx) {
    const c = cases[r.caseId];
    if (!c) { console.error(`  ${r.caseId}: case not found in cases.json — skip`); continue; }
    const res = await judgeCase(c);
    if (res.status === "completed") { existing[i] = res; fixed++; console.error(`  ${r.caseId}: OK (total=${res.totalScore})`); }
    else { console.error(`  ${r.caseId}: STILL ${res.status} (${res.error || ""})`); }
  }
  fs.writeFileSync(KIMI_OUT, JSON.stringify(existing, null, 2) + "\n");
  const ok = existing.filter((r) => r.status === "completed" && r.checklist?.length === 10).length;
  console.error(`[retry-kimi] fixed ${fixed}; now ${ok}/${existing.length} completed; gateway calls this run = ${CALLS}; wrote ${KIMI_OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
