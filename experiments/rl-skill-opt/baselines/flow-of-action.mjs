#!/usr/bin/env node
/**
 * flow-of-action.mjs — Flow-of-Action-style one-shot SOP baseline (no reward).
 *
 * Flow-of-Action (WWW'25, 2502.08224) retrieves OR auto-generates an SOP with a
 * single LLM call and uses it to guide a ReAct agent — crucially with NO reward
 * optimization. This baseline isolates "having any SOP" from "optimizing one":
 * it asks the reflector LLM, given ONLY the category + example symptoms (the same
 * NO-ground-truth prompt the RL proposer gets), to write ONE diagnostic SOP. That
 * single SOP is the method's output; we then evaluate it with the real
 * environment exactly like every other method.
 *
 * Cost: 1 LLM call (the SOP author) + the evaluation rollouts. No iteration.
 *
 * Usage:
 *   node experiments/rl-skill-opt/baselines/flow-of-action.mjs \
 *     --category network-dns --examples-file <json> \
 *     --reflector gpt-5.4 --out experiments/rl-skill-opt/skills/foa-netdns.txt
 */
import fs from "node:fs";
import path from "node:path";
import { LLM, cleanSkill } from "../llm-client.mjs";

function arg(name, fb) { const i = process.argv.indexOf(name); return i < 0 ? fb : process.argv[i + 1] ?? fb; }
const CATEGORY = arg("--category", "network-dns");
const EXAMPLES_FILE = arg("--examples-file", "");
const REFLECTOR = arg("--reflector", "gpt-5.4");
const OUT = arg("--out", `experiments/rl-skill-opt/skills/foa-${CATEGORY}.txt`);
const TEMPERATURE = Number(arg("--temperature", "0.7"));

const SYSTEM = (
  "You are an expert Site Reliability Engineer who writes concise, reusable diagnostic " +
  "playbooks (SOPs) for an automated, READ-ONLY Kubernetes diagnosis agent. A good SOP " +
  "tells the agent which resources to inspect, in what order, how to distinguish the real " +
  "root cause from downstream symptoms, and what a correct diagnosis must name."
);

function userPrompt(category, examples) {
  const ex = examples.length
    ? examples.map((e, i) => `  Example incident ${i + 1}: ${e}`).join("\n")
    : "  (no examples provided)";
  return `Write ONE diagnostic Standard Operating Procedure (SOP) for the fault category: "${category}".

Representative incident symptoms in this category (these are only the user-facing symptom
reports — they do NOT reveal the answer; the agent must investigate the live cluster):
${ex}

Requirements:
- A GENERAL procedure for this category, not a fix for one specific incident. Do NOT invent
  specific resource names, namespaces, image tags, or IPs.
- Give the PRECISE ordered sequence of read-only checks (which kubectl get/describe on which
  kinds) that reveal the root cause for this category.
- Tell the agent how to separate the true root cause from misleading downstream symptoms.
- State what a correct final diagnosis must name: the faulting resource (kind/name), the
  concrete mechanism, the scope, supporting evidence, and a safe remediation.
- 150-400 words. No preamble, no markdown headers — just the SOP text.

Output ONLY the SOP text.`;
}

async function main() {
  const examples = EXAMPLES_FILE && fs.existsSync(EXAMPLES_FILE) ? JSON.parse(fs.readFileSync(EXAMPLES_FILE, "utf8")) : [];
  const llm = new LLM();
  console.error(`[foa] reflector=${REFLECTOR} category=${CATEGORY} examples=${examples.length}`);
  const { text } = await llm.chat({ model: REFLECTOR, system: SYSTEM, user: userPrompt(CATEGORY, examples), temperature: TEMPERATURE, maxTokens: 1200 });
  const skill = cleanSkill(text);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, skill);
  const meta = { method: "flow-of-action", category: CATEGORY, reflector: REFLECTOR, chars: skill.length, llmCalls: llm.totals.calls, llmTokens: llm.totals.totalTokens, out: OUT };
  fs.writeFileSync(OUT.replace(/\.txt$/, ".meta.json"), JSON.stringify(meta, null, 2));
  console.error(`[foa] wrote ${skill.length}-char SOP -> ${OUT} (${llm.totals.totalTokens} reflector tokens)`);
  console.log(JSON.stringify(meta));
}

main().catch((e) => { console.error("[foa] ERROR", e?.stack || e?.message || String(e)); process.exit(1); });
