#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { createSiclawSession } from "../../dist/core/agent-factory.js";

const execFileAsync = promisify(execFile);

registerBuiltInApiProviders();

function argValue(name, fallback = undefined) {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function redact(text) {
  if (!text) return text;
  return stripModelReasoning(String(text))
    .replace(/sk-[A-Za-z0-9+/=_-]{12,}/g, "[REDACTED_API_KEY]")
    .replace(/client-key-data:\s*[A-Za-z0-9+/=\n\r]+/g, "client-key-data: [REDACTED]")
    .replace(/client-certificate-data:\s*[A-Za-z0-9+/=\n\r]+/g, "client-certificate-data: [REDACTED]")
    .replace(/certificate-authority-data:\s*[A-Za-z0-9+/=\n\r]+/g, "certificate-authority-data: [REDACTED]");
}

function stripModelReasoning(text) {
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .trimStart();
}

function textFromMessage(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function benchmarkGuard(mode, namespace) {
  if (mode === "none") return "";
  if (mode === "thorough") {
    return `

Additional benchmark guard for this Claude hard-case rerun:
- Stay read-only and case-local: do not modify, delete, restart, scale, patch, or create cluster resources.
- Prefer target-scoped Kubernetes/Volcano evidence over broad dumps. Avoid dumping all nodes, all pods, or all events.
- It is OK to use cluster_info if it is useful, but do not treat broad cluster facts as sufficient evidence without checking the target resources.
- For hard and compound cases, actively look for multiple simultaneous root causes before finalizing.
- Inspect only the target resources and directly related owner/dependency objects in ${namespace}.
- Keep the final diagnosis concise and evidence-backed. Do not include hidden reasoning, scratchpad text, or chain-of-thought; provide only the observable diagnosis, evidence, scope, confidence, and remediation.
`;
  }
  return `

Additional benchmark guard for this low-cost OpenAI-compatible model run:
- Do not call cluster_info in this experiment. It can return broad cluster inventory and is outside the case-local observation budget.
- Do not dump all nodes, all pods, or all events. Use namespace-scoped and target-scoped kubectl queries.
- For scheduling cases, prefer: describe the target pod, inspect its Events, inspect its nodeSelector/tolerations/affinity/resource requests, and query only matching node labels or relevant scheduler events.
- For service, network, controller, storage, and Volcano cases, inspect only the target resources and directly related owner/dependency objects in ${namespace}.
- Keep the final diagnosis concise and evidence-backed. Do not include hidden reasoning, scratchpad text, or chain-of-thought; provide only the observable diagnosis, evidence, scope, confidence, and remediation.
- Hard budget: use at most four tool calls. If evidence is sufficient or the fourth tool call returns, stop investigating and provide the best-supported final diagnosis.
`;
}

function createStaticBroker({ kubeconfigPath, clusterName, description }) {
  const meta = {
    name: clusterName,
    description,
    api_server: "https://127.0.0.1:16443",
    is_production: false,
    current_context: "admin2@k8s-cks-test",
    contexts: ["admin2@k8s-cks-test"],
    debug_image: "busybox:1.36",
  };
  const info = {
    meta,
    path: kubeconfigPath,
    filePaths: [kubeconfigPath],
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  };
  return {
    isClustersReady() {
      return true;
    },
    async refreshClusters() {
      return [meta];
    },
    getClustersLocal() {
      return [meta];
    },
    listClustersLocalInfo() {
      return [info];
    },
    getClusterLocalInfo(name) {
      return name === clusterName ? info : undefined;
    },
    async ensureCluster(name) {
      if (name !== clusterName) throw new Error(`Unknown cluster ${name}`);
      return info;
    },
    async acquireCluster(name) {
      if (name !== clusterName) throw new Error(`Unknown cluster ${name}`);
      return {
        kind: "cluster",
        credential: {
          name,
          ttl_seconds: 86400,
          files: [{ name: "kubeconfig", content: "[redacted]" }],
        },
      };
    },
    async probeCluster(name) {
      if (name !== clusterName) {
        return { name, reachable: false, probe_error: `Unknown cluster ${name}` };
      }
      try {
        const { stdout } = await execFileAsync(
          "kubectl",
          ["version", "--output=json", `--kubeconfig=${kubeconfigPath}`, "--request-timeout=5s"],
          { timeout: 8000 },
        );
        const parsed = JSON.parse(stdout);
        return {
          name,
          reachable: true,
          server_version: parsed.serverVersion?.gitVersion ?? "unknown",
        };
      } catch (err) {
        return {
          name,
          reachable: false,
          probe_error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    isHostsReady() {
      return true;
    },
    async refreshHosts() {
      return [];
    },
    getHostsLocal() {
      return [];
    },
    listHostsLocalInfo() {
      return [];
    },
    dispose() {},
  };
}

async function main() {
  const promptFile = argValue("--prompt-file");
  const outputFile = argValue("--output-file");
  const caseId = argValue("--case-id", "manual");
  const timeoutMs = Number(argValue("--timeout-ms", "240000"));
  const clusterName = argValue("--cluster", "cks-test");
  const namespace = argValue("--namespace", "siclaw-eval-yye-20260602");
  const guardMode = argValue("--guard", process.env.SICLAW_EVAL_GUARD || "low-cost");
  const thinkingLevel = argValue("--thinking", process.env.SICLAW_EVAL_THINKING || "high");
  // Security-off A/B (safe-floor): widen the bash binary whitelist with read-only
  // text tools. kubectl-read-only / no-exec / no-egress / sensitive-paths /
  // sanitizer all stay enforced (see restricted-bash EVAL_PERMISSIVE_BINARIES).
  const securityOff = process.argv.includes("--security-off") || process.env.SICLAW_EVAL_SECURITY_OFF === "1";
  if (securityOff) process.env.SICLAW_EVAL_PERMISSIVE_BASH = "1";
  const kubeconfigPath = path.resolve(argValue("--kubeconfig", ".siclaw/credentials/cks-test.kubeconfig"));
  // RL skill-opt: inject a proposed diagnostic skill into the agent's system
  // prompt (the `systemPromptAppend` hook in createSiclawSession). The real
  // agent then has the candidate skill in context while it investigates the
  // live cluster, exactly as if the skill were installed.
  const skillFile = argValue("--skill-file", process.env.SICLAW_EVAL_SKILL_FILE);

  if (!promptFile || !outputFile) {
    console.error("Usage: eval-harness.mjs --case-id ID --prompt-file FILE --output-file FILE [--timeout-ms MS] [--skill-file FILE]");
    process.exit(2);
  }

  let skillText = "";
  if (skillFile) {
    skillText = fs.readFileSync(skillFile, "utf8").trim();
  }
  const systemPromptAppend = skillText
    ? `The following is an additional diagnostic skill (a focused standard operating procedure) available to you for this investigation. Apply it when it is relevant to the incident.\n\n--- BEGIN DIAGNOSTIC SKILL ---\n${skillText}\n--- END DIAGNOSTIC SKILL ---`
    : undefined;

  const prompt = `${fs.readFileSync(promptFile, "utf8")}${benchmarkGuard(guardMode, namespace)}`;
  const startedAt = Date.now();
  const events = [];
  const assistantMessages = [];
  const toolCalls = [];
  let finalText = "";

  const broker = createStaticBroker({
    kubeconfigPath,
    clusterName,
    description:
      "cks-test is a non-production Kubernetes GPU test cluster reachable via local bastion tunnel. It has Volcano scheduling APIs, GPU nodes labelled scitix.ai/gpu-type=h20nvlink141, Calico NetworkPolicy, runtimeclasses kata-fc/kata-fc-115, and local-hostpath storage.",
  });

  const sessionManager = SessionManager.create(process.cwd());
  const result = await createSiclawSession({
    sessionManager,
    mode: "cli",
    kubeconfigRef: {
      credentialsDir: path.dirname(kubeconfigPath),
      credentialBroker: broker,
    },
    userId: "siclaw-eval",
    agentId: "siclaw-eval-agent",
    thinkingLevel,
    systemPromptAppend,
  });

  const unsubscribe = result.brain.subscribe((event) => {
    const base = { type: event.type, t: Date.now() - startedAt };
    if (event.type === "tool_execution_start") {
      const record = {
        ...base,
        toolName: event.toolName,
        args: redact(JSON.stringify(event.args ?? {})).slice(0, 4000),
      };
      events.push(record);
      toolCalls.push({ ...record });
    } else if (event.type === "tool_execution_end") {
      const text = Array.isArray(event.result?.content)
        ? event.result.content.map((c) => c?.text ?? "").join("\n")
        : "";
      events.push({
        ...base,
        toolName: event.toolName,
        isError: Boolean(event.isError),
        resultPreview: redact(text).slice(0, 6000),
      });
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = redact(textFromMessage(event.message));
      assistantMessages.push({
        t: Date.now() - startedAt,
        stopReason: event.message.stopReason,
        errorMessage: redact(event.message.errorMessage),
        text,
      });
      if (text.trim()) finalText = text;
      events.push({
        ...base,
        role: "assistant",
        stopReason: event.message.stopReason,
        errorMessage: redact(event.message.errorMessage),
        textPreview: text.slice(0, 3000),
      });
    } else if (
      event.type === "agent_start" ||
      event.type === "agent_end" ||
      event.type === "turn_start" ||
      event.type === "turn_end" ||
      event.type === "auto_retry_start" ||
      event.type === "auto_retry_end"
    ) {
      events.push(base);
    } else {
      const compact = { ...base };
      for (const key of ["reason", "error", "errorMessage", "message", "name"]) {
        if (event[key] !== undefined) compact[key] = redact(typeof event[key] === "string" ? event[key] : JSON.stringify(event[key])).slice(0, 2000);
      }
      events.push(compact);
    }
  });

  let status = "completed";
  let error = null;
  const timer = setTimeout(() => {
    status = "timed_out";
    result.brain.abort().catch(() => {});
  }, timeoutMs);

  try {
    await result.brain.prompt(prompt);
    const lastAssistant = assistantMessages.at(-1);
    if (lastAssistant?.stopReason === "error") {
      status = "error";
      error = lastAssistant.errorMessage || "assistant stopped with error";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (status !== "timed_out") status = "error";
  } finally {
    clearTimeout(timer);
    unsubscribe();
    await result.mcpManager?.shutdown?.();
  }

  const stats = result.brain.getSessionStats?.();
  const out = {
    caseId,
    status,
    securityOff,
    error: redact(error),
    durationMs: Date.now() - startedAt,
    skillFile: skillFile || null,
    skillInjected: Boolean(skillText),
    skillChars: skillText ? skillText.length : 0,
    prompt: redact(prompt),
    finalText,
    assistantMessages,
    toolCalls,
    events,
    stats,
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ caseId, status, durationMs: out.durationMs, toolCalls: toolCalls.length, outputFile }));
}

main().catch((err) => {
  console.error(redact(err?.stack || err?.message || String(err)));
  process.exit(1);
});
