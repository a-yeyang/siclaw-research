#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = "experiments/siclaw-agent-eval";
const CASES_PATH = path.join(ROOT, "cases", "cases.json");
const LOGS_DIR = path.join(ROOT, "logs");
const REPORTS_DIR = path.join(ROOT, "reports");
const PER_CASE_DIR = path.join(REPORTS_DIR, "per-case");

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[_/:-]+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fa5. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripModelReasoning(text) {
  return String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trimStart();
}

function words(text) {
  const stop = new Set([
    "and", "the", "for", "with", "that", "this", "also", "into", "from",
    "single", "multi", "resource", "failure", "scope", "pod", "service",
    "deployment", "configmap", "persistentvolumeclaim", "networkpolicy",
    "horizontalpodautoscaler", "volcano", "job", "namespace", "eval",
  ]);
  return normalize(text).split(" ").filter((w) => w.length >= 3 && !stop.has(w));
}

function hasAny(text, patterns) {
  const n = normalize(text);
  return patterns.some((p) => n.includes(normalize(p)));
}

function targetNames(localization) {
  return String(localization ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((target) => {
      const parts = target.split("/");
      return { full: target, name: parts[parts.length - 1] ?? target };
    });
}

function scoreLocalization(caseDef, output) {
  const targets = targetNames(caseDef.groundTruth?.localization);
  if (targets.length === 0) return { score: 0, matched: [] };
  const matched = targets.filter((t) => hasAny(output, [t.full, t.name]));
  return { score: matched.length / targets.length, matched: matched.map((t) => t.full) };
}

const categorySignals = {
  "image-pull": ["imagepullbackoff", "errimagepull", "image", "pull", "registry", "tag", "repository", "unauthorized", "no such host", "not found"],
  crashloop: ["crashloopbackoff", "crash", "back off", "exit", "logs", "env", "command", "probe", "failed"],
  config: ["configmap", "secret", "key", "env", "volume", "not found", "createcontainerconfigerror", "configuration"],
  "scheduling-gpu": ["pending", "scheduler", "node selector", "nodeselector", "gpu", "taint", "toleration", "affinity", "insufficient", "unschedulable"],
  storage: ["pvc", "persistentvolumeclaim", "storageclass", "unbound", "volume", "claim", "pending"],
  "service-readiness": ["service", "selector", "endpoint", "targetport", "readiness", "probe", "port"],
  "network-dns": ["networkpolicy", "egress", "ingress", "dns", "resolve", "coredns", "policy", "deny"],
  controller: ["deployment", "replicaset", "ingress", "hpa", "controller", "owner", "backend", "service"],
  "volcano-gpu": ["volcano", "podgroup", "queue", "minmember", "minresource", "gang", "scheduler", "gpu"],
  compound: ["compound", "multiple", "both", "also", "and", "two", "selector", "config", "pvc", "networkpolicy", "hpa", "volcano", "scheduler"],
};

function scoreMechanism(caseDef, output) {
  const text = normalize(output);
  const gtTerms = [...new Set([
    ...words(caseDef.title),
    ...words(caseDef.groundTruth?.mechanism),
  ])];
  const categoryTerms = categorySignals[caseDef.category] ?? [];
  const gtMatched = gtTerms.filter((term) => text.includes(normalize(term)));
  const categoryMatched = categoryTerms.filter((term) => text.includes(normalize(term)));
  const gtScore = gtTerms.length === 0 ? 0 : gtMatched.length / gtTerms.length;
  const categoryScore = categoryTerms.length === 0 ? 0 : Math.min(1, categoryMatched.length / Math.min(4, categoryTerms.length));
  const score = Math.min(1, Math.max(gtScore, 0.35 * gtScore + 0.65 * categoryScore));
  return { score, matched: [...new Set([...gtMatched, ...categoryMatched])] };
}

function scoreScope(caseDef, output) {
  const text = normalize(output);
  const scopeTerms = words(caseDef.groundTruth?.scope);
  const singleOrMulti =
    /single|one/.test(normalize(caseDef.groundTruth?.scope))
      ? ["single", "only", "one", "isolated"]
      : /multi|multiple/.test(normalize(caseDef.groundTruth?.scope))
        ? ["multi", "multiple", "compound", "both"]
        : [];
  const matched = [...new Set([...scopeTerms, ...singleOrMulti].filter((term) => text.includes(normalize(term))))];
  const denom = Math.max(2, Math.min(5, scopeTerms.length + singleOrMulti.length));
  return { score: Math.min(1, matched.length / denom), matched };
}

const signalKeywords = {
  "pod waiting reason": ["waiting", "reason", "imagepullbackoff", "crashloopbackoff", "createcontainerconfigerror", "pending"],
  "describe pod events": ["event", "events", "describe", "failed", "back off", "scheduled"],
  "image field": ["image", "registry", "tag"],
  "container logs": ["logs", "log", "stderr", "stdout", "exit"],
  "env": ["env", "environment", "variable"],
  "configmap": ["configmap", "key"],
  "node selector": ["node selector", "nodeselector", "label"],
  "scheduler events": ["scheduler", "unschedulable", "failedscheduling", "pending"],
  "pvc": ["pvc", "persistentvolumeclaim", "storageclass", "unbound"],
  "service endpoints": ["endpoint", "endpointslice", "selector", "targetport"],
  "network policy": ["networkpolicy", "egress", "ingress", "deny", "allow"],
  "dns": ["dns", "resolve", "nameserver", "coredns"],
  "controller": ["deployment", "replicaset", "owner", "controller"],
  "volcano": ["volcano", "podgroup", "queue", "gang"],
};

function scoreEvidence(caseDef, output, toolCalls) {
  const text = normalize(output);
  const expected = caseDef.expectedSignals ?? [];
  const matchedSignals = [];
  for (const signal of expected) {
    const keys = signalKeywords[normalize(signal)] ?? words(signal);
    if (keys.some((k) => text.includes(normalize(k)))) matchedSignals.push(signal);
  }
  const toolBonus = Array.isArray(toolCalls) && toolCalls.length > 0 ? 0.15 : 0;
  const signalScore = expected.length === 0 ? 0 : matchedSignals.length / expected.length;
  return { score: Math.min(1, signalScore + toolBonus), matched: matchedSignals, toolCallCount: toolCalls?.length ?? 0 };
}

function scoreRemediation(output) {
  const patterns = [
    "remediation", "fix", "replace", "correct", "update", "patch", "create",
    "configure", "add", "remove", "set", "increase", "align", "safe",
  ];
  const matched = patterns.filter((p) => hasAny(output, [p]));
  return { score: matched.length > 0 ? 1 : 0, matched };
}

function judgeCase(caseDef, result) {
  const finalText = stripModelReasoning(result?.finalText ?? "");
  const toolCalls = result?.toolCalls ?? [];
  if (!result || result.status !== "completed" || !finalText.trim()) {
    return {
      caseId: caseDef.id,
      status: result?.status ?? "missing",
      passed: false,
      totalScore: 0,
      dimensions: {
        localization: { score: 0, matched: [] },
        mechanism: { score: 0, matched: [] },
        scope: { score: 0, matched: [] },
        evidence: { score: 0, matched: [], toolCallCount: toolCalls.length },
        remediation: { score: 0, matched: [] },
      },
    };
  }
  const dimensions = {
    localization: scoreLocalization(caseDef, finalText),
    mechanism: scoreMechanism(caseDef, finalText),
    scope: scoreScope(caseDef, finalText),
    evidence: scoreEvidence(caseDef, finalText, toolCalls),
    remediation: scoreRemediation(finalText),
  };
  const totalScore =
    0.30 * dimensions.localization.score +
    0.30 * dimensions.mechanism.score +
    0.15 * dimensions.scope.score +
    0.15 * dimensions.evidence.score +
    0.10 * dimensions.remediation.score;
  const passed =
    dimensions.localization.score >= 0.5 &&
    dimensions.mechanism.score >= 0.45 &&
    totalScore >= 0.62;
  return {
    caseId: caseDef.id,
    status: result.status,
    passed,
    totalScore: Number(totalScore.toFixed(3)),
    dimensions,
    durationMs: result.durationMs ?? null,
    toolCallCount: toolCalls.length,
  };
}

function readResult(caseId) {
  const p = path.join(LOGS_DIR, caseId, "result.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function escapeMd(text) {
  return String(text ?? "").replace(/\|/g, "\\|");
}

function relLink(from, to) {
  return path.relative(path.dirname(from), to).replaceAll(path.sep, "/");
}

function formatToolTimeline(result) {
  const starts = result?.toolCalls ?? [];
  const ends = (result?.events ?? []).filter((e) => e.type === "tool_execution_end");
  return starts.map((start, idx) => {
    const end = ends.find((e) => e.toolName === start.toolName && e.t >= start.t) ?? ends[idx];
    const args = start.args ? `\nArgs:\n\`\`\`json\n${start.args}\n\`\`\`` : "";
    const preview = end?.resultPreview ? `\nResult preview:\n\`\`\`text\n${end.resultPreview.slice(0, 2500)}\n\`\`\`` : "";
    return `### ${idx + 1}. ${start.toolName} (${start.t} ms)${args}${preview}`;
  }).join("\n\n");
}

function writePerCaseReport(caseDef, result, judgment) {
  const out = path.join(PER_CASE_DIR, `${caseDef.id}.md`);
  const lines = [];
  lines.push(`# ${caseDef.id} ${caseDef.title}`);
  lines.push("");
  lines.push("## Case");
  lines.push("");
  lines.push(`- Category: ${caseDef.category}`);
  lines.push(`- Difficulty: ${caseDef.difficulty}`);
  lines.push(`- Noise: ${caseDef.noise ? "yes" : "no"}`);
  lines.push(`- Namespace: ${caseDef.namespace}`);
  lines.push(`- Targets: ${caseDef.targets.join(", ")}`);
  lines.push(`- Symptom: ${caseDef.symptom}`);
  lines.push(`- Ground truth localization: ${caseDef.groundTruth.localization}`);
  lines.push(`- Ground truth mechanism: ${caseDef.groundTruth.mechanism}`);
  lines.push(`- Ground truth scope: ${caseDef.groundTruth.scope}`);
  lines.push("");
  lines.push("## Judgment");
  lines.push("");
  lines.push(`- Status: ${judgment.status}`);
  lines.push(`- Passed: ${judgment.passed ? "yes" : "no"}`);
  lines.push(`- Total score: ${judgment.totalScore}`);
  for (const [name, dim] of Object.entries(judgment.dimensions)) {
    lines.push(`- ${name}: ${Number(dim.score).toFixed(3)} (${(dim.matched ?? []).join(", ") || "no direct match"})`);
  }
  lines.push("");
  lines.push("## Agent Input");
  lines.push("");
  lines.push("```text");
  lines.push(result?.prompt ?? fs.readFileSync(path.join(LOGS_DIR, caseDef.id, "prompt.txt"), "utf8"));
  lines.push("```");
  lines.push("");
  lines.push("## Tool Trace");
  lines.push("");
  lines.push(formatToolTimeline(result) || "No tool calls captured.");
  lines.push("");
  lines.push("## Agent Output");
  lines.push("");
  lines.push("```markdown");
  lines.push(stripModelReasoning(result?.finalText ?? ""));
  lines.push("```");
  fs.writeFileSync(out, lines.join("\n") + "\n");
  return out;
}

function summarize(judgments, cases) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const groups = new Map();
  for (const j of judgments) {
    const c = byId.get(j.caseId);
    const key = c?.category ?? "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }
  return [...groups.entries()].map(([category, rows]) => {
    const completed = rows.filter((r) => r.status === "completed").length;
    const passed = rows.filter((r) => r.passed).length;
    const avgScore = rows.reduce((sum, r) => sum + r.totalScore, 0) / rows.length;
    const avgTools = rows.reduce((sum, r) => sum + (r.toolCallCount ?? 0), 0) / rows.length;
    const avgDuration = rows.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) / Math.max(1, completed);
    return { category, total: rows.length, completed, passed, passRate: passed / rows.length, avgScore, avgTools, avgDuration };
  });
}

function writeMainReport(cases, judgments, perCasePaths) {
  const out = path.join(REPORTS_DIR, "final-report-20260603.md");
  const rowsById = new Map(judgments.map((j) => [j.caseId, j]));
  const categorySummary = summarize(judgments, cases);
  const totalCompleted = judgments.filter((j) => j.status === "completed").length;
  const totalPassed = judgments.filter((j) => j.passed).length;
  const avgScore = judgments.reduce((sum, j) => sum + j.totalScore, 0) / judgments.length;
  const lines = [];
  lines.push("# Siclaw Kubernetes/GPU Agent Evaluation Report");
  lines.push("");
  lines.push("Date: 2026-06-03");
  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push("本实验参考 SREGym 和 AIOpsLAB 的评测思想：在真实可观测的 Kubernetes 环境中注入故障，给 agent 一个症状级 incident prompt，让 agent 通过集群工具自主收集证据，并按定位、根因机理、影响范围、证据质量、修复建议进行判分。故障以原因而不是症状为 oracle，包含单点故障、噪声资源和多层复合故障。");
  lines.push("");
  lines.push("## Environment");
  lines.push("");
  lines.push("- Target cluster: cks-test");
  lines.push("- Namespace: siclaw-eval-yye-20260602");
  lines.push("- Model provider: Scitix OpenAI-compatible chat completions");
  lines.push("- Model run note: the run started on `deepseek-ai/DeepSeek-V4-Flash`; after repeated US East 503s, the continuation and residual retries were switched to `Qwen/Qwen3-32B` via `https://api-ap.scitix.ai/model-api`. The six hard cases that failed the original checklist were then rerun with `claude-sonnet-4-6` via Scitix Anthropic Messages.");
  lines.push("- Guard note: low-cost runs used case-local observation, no `cluster_info`, concise diagnosis, and a four-tool-call budget for residual retries. The Claude hard-case rerun used a more thorough read-only case-local guard without the four-tool-call limit.");
  lines.push("- Case count: 100");
  lines.push("- Harness: experiments/siclaw-agent-eval/eval-harness.mjs");
  lines.push("- Logs: experiments/siclaw-agent-eval/logs");
  lines.push("");
  lines.push("## Overall Result");
  lines.push("");
  lines.push(`- Completed cases: ${totalCompleted}/100`);
  lines.push(`- Passed cases by checklist: ${totalPassed}/100`);
  lines.push(`- Pass rate: ${(100 * totalPassed / 100).toFixed(1)}%`);
  lines.push(`- Average checklist score: ${avgScore.toFixed(3)}`);
  lines.push("");
  lines.push("## Category Summary");
  lines.push("");
  lines.push("| Category | Cases | Completed | Passed | Pass Rate | Avg Score | Avg Tool Calls | Avg Duration |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of categorySummary) {
    lines.push(`| ${row.category} | ${row.total} | ${row.completed} | ${row.passed} | ${(100 * row.passRate).toFixed(1)}% | ${row.avgScore.toFixed(3)} | ${row.avgTools.toFixed(1)} | ${(row.avgDuration / 1000).toFixed(1)}s |`);
  }
  lines.push("");
  lines.push("## Per-Case Results");
  lines.push("");
  lines.push("| Case | Category | Difficulty | Status | Passed | Score | Tool Calls | Duration | Report |");
  lines.push("|---|---|---|---|---:|---:|---:|---:|---|");
  for (const c of cases) {
    const j = rowsById.get(c.id);
    const reportPath = perCasePaths.get(c.id);
    const link = reportPath ? `[detail](${relLink(out, reportPath)})` : "";
    lines.push(`| ${c.id} | ${c.category} | ${c.difficulty} | ${j?.status ?? "missing"} | ${j?.passed ? "yes" : "no"} | ${(j?.totalScore ?? 0).toFixed(3)} | ${j?.toolCallCount ?? 0} | ${(((j?.durationMs ?? 0) / 1000).toFixed(1))}s | ${link} |`);
  }
  lines.push("");
  lines.push("## Scoring Checklist");
  lines.push("");
  lines.push("- Localization: 是否定位到 oracle 中的 pod/service/deployment/pvc/podgroup 等目标资源。");
  lines.push("- Mechanism: 是否解释了故障机理，而不是只复述症状。");
  lines.push("- Scope: 是否说明单资源、服务路径、调度链路或复合故障影响范围。");
  lines.push("- Evidence: 是否引用事件、yaml、日志、endpoint、scheduler/Volcano 状态等证据。");
  lines.push("- Remediation: 是否给出低风险、与根因匹配的修复建议。");
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- 自动判分是关键词和 oracle 匹配的保守近似；最终科研结论建议对低分和复合故障样本做人工复核。");
  lines.push("- 本轮遵守只读诊断规则；prompt 明确禁止修改、删除、重启、扩缩容或创建集群资源。");
  lines.push("- 评测资源均限定在 siclaw-eval-yye-20260602 命名空间内。");
  fs.writeFileSync(out, lines.join("\n") + "\n");
  return out;
}

fs.mkdirSync(PER_CASE_DIR, { recursive: true });
const cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8"));
const judgments = [];
const perCasePaths = new Map();

for (const c of cases) {
  const result = readResult(c.id);
  const judgment = judgeCase(c, result);
  judgments.push(judgment);
  perCasePaths.set(c.id, writePerCaseReport(c, result, judgment));
}

const judgmentPath = path.join(REPORTS_DIR, "judgments-20260603.json");
fs.writeFileSync(judgmentPath, JSON.stringify(judgments, null, 2) + "\n");
const mainReport = writeMainReport(cases, judgments, perCasePaths);
console.log(JSON.stringify({
  judgments: judgmentPath,
  report: mainReport,
  completed: judgments.filter((j) => j.status === "completed").length,
  passed: judgments.filter((j) => j.passed).length,
}, null, 2));
