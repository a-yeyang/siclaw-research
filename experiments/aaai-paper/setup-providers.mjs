#!/usr/bin/env node
/**
 * Generate per-model siclaw settings.json files (one config dir per model) so we
 * can run different models in parallel via SICLAW_CONFIG_DIR=providers/<name>.
 * Reads the API key from .secrets.env so the key is never hardcoded here.
 * Output dirs contain the key → they are gitignored.
 */
import fs from "node:fs";
import path from "node:path";

const SECRETS = "experiments/aaai-paper/.secrets.env";
const OUT_ROOT = "experiments/aaai-paper/providers";

function secrets() {
  const env = {};
  for (const line of fs.readFileSync(SECRETS, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const { SCITIX_API_KEY: KEY, SCITIX_BASE: BASE = "https://api.scitix.ai/model-api" } = secrets();
if (!KEY) { console.error("no SCITIX_API_KEY in .secrets.env"); process.exit(2); }

const oaiCompat = { supportsDeveloperRole: true, supportsUsageInStreaming: true, supportsToolUse: true, maxTokensField: "max_tokens" };
const anthropicCompat = { supportsDeveloperRole: false, supportsUsageInStreaming: true, supportsToolUse: true, maxTokensField: "max_tokens" };
// GPT-5 series (reasoning) reject `max_tokens` → require `max_completion_tokens` (scitix: "not supported MaxTokens, please use MaxCompletionTokens").
const gptCompat = { supportsDeveloperRole: true, supportsUsageInStreaming: true, supportsToolUse: true, maxTokensField: "max_completion_tokens" };

// tag → provider definition
const MODELS = {
  // Anthropic SDK appends "/v1/messages" to baseUrl itself, and scitix accepts x-api-key auth → baseUrl must NOT include /v1.
  // reasoning:false is REQUIRED — scitix's claude proxy rejects pi-ai's adaptive-thinking `effort` param (400 "Extra inputs not permitted").
  claude:   { provider: "scitix-anthropic", api: "anthropic",            baseUrl: BASE,         id: "claude-sonnet-4-6",            name: "Claude Sonnet 4.6", reasoning: false, ctx: 200000, max: 16000, compat: anthropicCompat },
  kimi:     { provider: "scitix-openai",    api: "openai-completions",   baseUrl: BASE,         id: "moonshotai/Kimi-K2.5",        name: "Kimi K2.5",         reasoning: false, ctx: 128000, max: 8192,  compat: oaiCompat },
  deepseek: { provider: "scitix-openai",    api: "openai-completions",   baseUrl: BASE,         id: "deepseek-ai/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash", reasoning: false, ctx: 128000, max: 8192,  compat: oaiCompat },
  qwen:     { provider: "scitix-openai",    api: "openai-completions",   baseUrl: BASE,         id: "Qwen/Qwen3.6-27B",            name: "Qwen3.6 27B",       reasoning: false, ctx: 128000, max: 8192,  compat: oaiCompat },
  gpt:      { provider: "scitix-openai",    api: "openai-completions",   baseUrl: BASE,         id: "gpt-5.4",                     name: "GPT-5.4",           reasoning: false, ctx: 128000, max: 16384, compat: gptCompat },
};

for (const [tag, m] of Object.entries(MODELS)) {
  const settings = {
    providers: {
      [m.provider]: {
        baseUrl: m.baseUrl,
        apiKey: KEY,
        api: m.api,
        authHeader: true,
        models: [{
          id: m.id, name: m.name, reasoning: m.reasoning, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.ctx, maxTokens: m.max, compat: m.compat,
        }],
      },
    },
    default: { provider: m.provider, modelId: m.id },
  };
  const dir = path.join(OUT_ROOT, tag, ".siclaw", "config");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "settings.json");
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  console.log(`wrote ${p}  (${m.id})`);
}
console.log(`\nUse: SICLAW_CONFIG_DIR=${OUT_ROOT}/<tag>/.siclaw/config`);
