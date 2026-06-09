/**
 * llm-client.mjs — thin scitix/MaaS chat client shared by the skill-optimizer
 * baselines (Flow-of-Action, best-of-N, GEPA). Routes Anthropic vs OpenAI-style
 * models by id, matches the judge-llm.mjs calling convention, and tracks token
 * usage so every baseline can report its MaaS spend (proof the loop ran).
 *
 * Usage:
 *   import { LLM } from "./llm-client.mjs";
 *   const llm = new LLM();                 // reads experiments/aaai-paper/.secrets.env
 *   const { text, usage } = await llm.chat({ model: "gpt-5.4", system, user, temperature: 0.9 });
 *   console.log(llm.totals);               // { calls, inputTokens, outputTokens, totalTokens }
 */
import fs from "node:fs";

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

const isAnthropic = (model) => /^claude/i.test(model);

export class LLM {
  constructor({ key, base } = {}) {
    const s = loadSecrets();
    this.key = key || s.key;
    this.base = base || s.base;
    if (!this.key) throw new Error("Missing SCITIX_API_KEY (experiments/aaai-paper/.secrets.env)");
    this.totals = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  async chat({ model, system, user, temperature = 0.7, maxTokens = 1600, retries = 4, timeoutMs = 120_000 }) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let resp, text, usage = {};
        if (isAnthropic(model)) {
          resp = await fetch(`${this.base}/v1/messages`, {
            method: "POST", signal: ctrl.signal,
            headers: { "content-type": "application/json", authorization: `Bearer ${this.key}`, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({ model, max_tokens: maxTokens, temperature, system, messages: [{ role: "user", content: user }] }),
          });
          clearTimeout(timer);
          const j = await resp.json();
          if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
          text = Array.isArray(j.content) ? j.content.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
          usage = { input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0 };
        } else {
          // gpt-5.x and some newer models require max_completion_tokens instead of
          // max_tokens, and fix temperature=1 (beta-limitations). Build adaptively
          // and retry dropping rejected fields.
          const body = {
            model, temperature,
            max_tokens: maxTokens, max_completion_tokens: maxTokens,
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
          };
          const post = async () => {
            const r = await fetch(`${this.base}/chat/completions`, {
              method: "POST", signal: ctrl.signal,
              headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
              body: JSON.stringify(body),
            });
            return r.json();
          };
          let j = await post();
          // up to 2 corrective retries for field rejections (max_tokens / temperature)
          for (let fix = 0; fix < 2 && j.error; fix++) {
            const msg = j.error.message || JSON.stringify(j.error);
            if (/max_?completion_?tokens|max_?tokens/i.test(msg) && body.max_tokens != null) {
              delete body.max_tokens; // keep only max_completion_tokens
            } else if (/temperature|top_p/i.test(msg) && body.temperature !== 1) {
              body.temperature = 1; // model fixes temperature at 1
            } else break;
            j = await post();
          }
          clearTimeout(timer);
          if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
          text = j.choices?.[0]?.message?.content ?? "";
          usage = { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 };
        }
        if (!text || !text.trim()) throw new Error("empty LLM response");
        this.totals.calls++;
        this.totals.inputTokens += usage.input || 0;
        this.totals.outputTokens += usage.output || 0;
        this.totals.totalTokens += (usage.input || 0) + (usage.output || 0);
        return { text, usage };
      } catch (err) {
        lastErr = err;
        if (attempt === retries) break;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw lastErr;
  }
}

// strip reasoning blocks + code fences + leading "skill:" preamble from a skill text
export function cleanSkill(text) {
  let t = String(text || "").trim();
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  t = t.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  return t.trim();
}
