# Pre-Submission Experiment Checklist / 投稿前必跑实验清单

> Bilingual (EN / 中文). The four experiments that move AAAI acceptance odds,
> ordered cheapest-first. Each gives the **exact script change** and the
> **measured token cost**. These are the items the rewritten paper now lists as
> Limitations — running them converts each limitation into a result.
>
> 双语。按"最便宜优先"排序的、能真正提升 AAAI 命中率的 4 个实验。每项给出**确切的
> 脚本改法**与**实测 token 成本**。这些正是重写后论文列在 Limitations 里的项——
> 跑完它们就把每条限制变成一个结果。

---

## Cost basis (measured from real traces) / 成本基准（实测）

| Unit | Tokens | Source |
|---|---|---|
| 1 K8s diagnosis case (agent run) | **~110K total** (~43K input, ~68K cacheRead, ~1K output) | `logs/c001/result.json` `stats.tokens` |
| 1 GPU/RDMA case (agent run) | ~56K total | `gpu-rdma-logs/g01/result.json` |
| 1 judge call (per case) | ~3–5K (input diagnosis+checklist, output ≤2K) | `judge-llm.mjs` (`max_tokens:2000, temp:0`) |
| 1 RL rollout (agent+judge) | ~96K | `rl-skill-opt` budget accounting |

**中文.** 一个 K8s 诊断 case 约 11 万 token（其中约 6.8 万是廉价的 cacheRead）；
100 case 一轮 ≈ **11M token（非缓存约 4.4M）**。judge 每 case 约 4K。下列成本据此估算。
$ 金额取决于 scitix 每-token 价（cacheRead 打折），故只给 token 数。

---

## Exp 1 — GPU/RDMA real LLM-judge re-judge  ⏱️ cheapest, do first
## 实验 1 — GPU/RDMA 用真 LLM judge 重判（最便宜，先做）

**Why / 为什么.** The paper currently scores the 10 GPU cases with a `lower.includes()`
keyword rubric (`judge-gpu-rdma.mjs:12`), honestly labeled as a rubric. The 10
cases already carry full `groundTruth{localization,mechanism,scope}` in the exact
schema `judge-llm.mjs` consumes — so the real judge runs with **zero code change**.
This removes the single weakest "feasibility-probe" caveat in §5.5.

**中文.** GPU 10 个 case 已带完整 `groundTruth`，schema 与 `judge-llm.mjs` 完全兼容，
**无需改代码**，直接重判即可把 §5.5 最弱的"启发式 rubric"洗掉。

**Script change / 脚本改法: NONE.** Just re-point the existing judge:
```bash
# (needs SCITIX_API_KEY in experiments/aaai-paper/.secrets.env)
node experiments/aaai-paper/judge-llm.mjs \
  --judge-model claude-sonnet-4-6 \
  --traces-dir experiments/aaai-paper/gpu-rdma-logs \
  --cases     experiments/aaai-paper/gpu-rdma-cases.json \
  --out       experiments/aaai-paper/reports/llm-judgments-gpu.json
```
*Optional polish:* add a GPU-specific checklist branch in `judge-llm.mjs`
(`CHECKLIST` → category map: "names the Xid code? the GPU index? the link-layer
counter?") for a sharper oracle. ~15 lines; not required.

**Token cost / 成本:** 10 cases × ~5K = **~50K tokens** (~<$0.30, <2 min).

**Acceptance / 验收:** replace `tab:gpurdma` "Rubric" column with real judge scores;
drop the "heuristic rubric / not the LLM judge" caveat. **Risk if skipped:** a
reviewer reading `judge-gpu-rdma.mjs:12` dismisses the GPU section.

---

## Exp 2 — Judge κ validation  💰 cheap, highest reviewer-value
## 实验 2 — judge 的 κ 验证（便宜，审稿人最看重）

**Why / 为什么.** SREGym's headline credibility move is a validated judge:
Cohen's **κ=0.90** vs a human expert (N=100) plus cross-LLM convergence (→0.94).
Our judge demonstrably discriminates (c040 0.80→0.10, c045 0.47→1.00) but has
**no κ**. This is the #1 methodological gap the paper now flags.

**中文.** SREGym 的可信度王牌就是验证过的 judge（κ=0.90 vs 人类，N=100，跨模型收敛
到 0.94）。我们的 judge 能区分但**没有 κ**——这是论文现在标的 #1 方法学缺口。

**Step A — cross-LLM κ (no code change, `--judge-model` already routes by id):**
```bash
node experiments/aaai-paper/judge-llm.mjs --judge-model gpt-5.1 \
  --out experiments/aaai-paper/reports/llm-judgments-gpt.json
node experiments/aaai-paper/judge-llm.mjs --judge-model moonshotai/Kimi-K2.5 \
  --out experiments/aaai-paper/reports/llm-judgments-kimi-judge.json
```

**Step B — human κ (the one that matters):**
1. **New script** `experiments/aaai-paper/export-for-labeling.mjs` (~40 lines, no
   API): stratified-sample N=50 cases by category; for each emit
   `{caseId, category, symptom, groundTruth, agentDiagnosis(finalText)}` to
   `human-labels.jsonl` with empty `{localization,mechanism,scope,evidence,remediation,pass}`
   fields. One SRE labels pass/fail per dimension (binary), blind to the judge.
2. **New script** `experiments/aaai-paper/kappa.mjs` (~70 lines, no API, pure
   stats): load any ≥2 of `{llm-judgments-claude, -gpt, -kimi-judge, human-labels}`,
   align by `caseId`, compute **Cohen's κ** pairwise on the binary pass label (and
   per-dimension Yes/No), emit a SREGym-style inter-rater table.

`kappa.mjs` skeleton / 骨架:
```js
// cohenKappa(a[], b[]) over aligned binary labels
function cohenKappa(a, b) {
  const n = a.length; let agree = 0, pa1 = 0, pb1 = 0;
  for (let i = 0; i < n; i++) { if (a[i] === b[i]) agree++; pa1 += a[i]; pb1 += b[i]; }
  const po = agree / n;
  const pe = (pa1/n)*(pb1/n) + (1 - pa1/n)*(1 - pb1/n);
  return (po - pe) / (1 - pe);
}
// load judgment files -> map caseId -> passed(0/1); intersect ids; print κ per pair.
```

**Token cost / 成本:** Step A = 2 judges × 100 × ~4K = **~0.8M tokens** (~$3–6).
Step B = **0 tokens** (human ~2–3 h for 50 cases) + 0 for `kappa.mjs`.

**Acceptance / 验收:** a table reporting κ(Claude-judge, human) on N=50 and the
cross-LLM κ; target ≥0.6 (substantial), ideally near SREGym's 0.90. **Risk if
skipped:** "LLM-judge" stays an unbacked claim; reviewers anchor to the keyword
history.

---

## Exp 3 — Security-OFF A/B  🔬 medium effort, closes "zero accuracy cost"
## 实验 3 — Security-OFF A/B（中等工作量，补上"零准确率损失"）

**Why / 为什么.** The paper's "no accuracy cost" is currently **observational** (we
inspected failed cases). The clean proof is an A/B: run the same cases with the
validation+sanitization layers ON vs OFF and show the pass rate is unchanged —
while counting which of the 47 blocked commands actually execute (and which are
harmful). No security-off code path exists today (`--guard` only appends a prompt
paragraph; it does **not** toggle the pipeline).

**中文.** "零准确率损失"现在是*观察性*结论。干净的证明是 A/B：同样的 case，安全层
ON vs OFF，比 pass 率是否不变；并统计 47 条被拦命令里有多少真会执行、多少有害。
当前没有关安全的代码路径（`--guard` 只追加一段 prompt，不动管线）。

**Script change / 脚本改法 — `src/tools/infra/security-pipeline.ts`** (env-gated,
experiment-only, with an irreversible-op safety net so the live non-prod cluster
is safe). ⚠️ touches the security pipeline → read `docs/design/security.md` and run
`npm test` after (per `CLAUDE.md` change-impact matrix).

```ts
// in preExecSecurity(), BEFORE `const error = validateCommand(...)`:
if (process.env.SICLAW_INSECURE_EVAL === "1") {
  // ablate the whitelist+sanitizer; keep only an irreversible-op safety net
  return { error: irreversibleOpGuard(command), action: null, hasSensitiveKubectl: false };
}

// in postExecSecurity(), as the FIRST statement:
if (process.env.SICLAW_INSECURE_EVAL === "1") {
  const combined = opts?.stderr ? stdout + `\n\nSTDERR:\n${opts.stderr}` : stdout;
  return processToolOutput(combined);   // truncate only; no redaction
}

// new helper (same file): blocks ONLY truly irreversible / host-level ops, so the
// non-destructive escapes (wget, nc, python3, awk, xargs, crictl ps/inspect) DO run
// -> unbiased accuracy comparison; 0 read commands blocked.
function irreversibleOpGuard(command: string): string | null {
  const c = command.toLowerCase();
  if (/\bkubectl\b[^|]*\b(delete|drain|cordon|uncordon|taint|apply|replace|patch|scale|rollout|set|annotate|label|edit|create|exec|cp|port-forward)\b/.test(c))
    return "[insecure-eval] irreversible kubectl verb blocked by safety net";
  if (/\bnsenter\b.*(-t\s*1\b|--target\s*1\b)/.test(c)) return "[insecure-eval] host-ns entry blocked";
  if (/\b(reboot|shutdown|mkfs|dd\s+if=)/.test(c) || /\brm\s+-rf?\s+\//.test(c)) return "[insecure-eval] destructive op blocked";
  if (/\/dev\/tcp\/|bash\s+-i|nc\s+\S+\s+-e/.test(c)) return "[insecure-eval] reverse shell blocked";
  return null;
}
```

**Run / 运行** (recommend a **fresh disposable namespace** + non-prod `cks-test`;
the safety net is the second line of defense):
```bash
# secure arm (baseline)
SICLAW_INSECURE_EVAL=0 node experiments/siclaw-agent-eval/run-batch.mjs \
  --provider claude --out-dir experiments/aaai-paper/runs-secure
# insecure arm (validator+sanitizer ablated)
SICLAW_INSECURE_EVAL=1 node experiments/siclaw-agent-eval/run-batch.mjs \
  --provider claude --out-dir experiments/aaai-paper/runs-insecure
# judge both, then diff
node experiments/aaai-paper/judge-llm.mjs --traces-dir runs-secure   --out reports/judged-secure.json
node experiments/aaai-paper/judge-llm.mjs --traces-dir runs-insecure --out reports/judged-insecure.json
```
**New script** `analyze-ab.mjs` (~80 lines): (a) pass%(secure) vs pass%(insecure)
with bootstrap CI; (b) count commands that executed in the insecure arm but were
blocked in secure, classified read/write/escape; (c) the decisive check — did any
case that FAILED secure PASS insecure? (the only way security could have a real
accuracy cost).

**Token cost / 成本:** 1 extra 100-case run per brain ≈ **~11M tokens** + re-judge
~0.4M. Recommend 1–2 brains (Claude + DeepSeek, the most escape-prone) ⇒ **~12–23M**.

**Acceptance / 验收:** pass%(secure) within CI of pass%(insecure) ⇒ "no accuracy
cost" proven by A/B, not inspection; plus "N commands executed unconstrained, K
genuinely dangerous." **Risk if skipped:** the headline "zero accuracy cost" stays
an assertion.

---

## Exp 4 — Multi-seed RL + CIs  🖥️ most expensive, GPU-gated
## 实验 4 — 多 seed RL + 置信区间（最贵，受 GPU 限制）

**Why / 为什么.** The RL track's GRPO row is **1 training seed relabeled as a
3-checkpoint "ensemble"** (`analyze.mjs` writes `basis:"seeds"` — overstated). Real
≥3-seed CIs are needed before the cross-brain/audit "RL wins" claims are defensible.
(Held-out GEPA 1.458 > GRPO 1.183 likely holds — direction is robust.)

**中文.** GRPO 那一行是**单 seed 伪装成 3-checkpoint "ensemble"**（`analyze.mjs`
标了 `basis:"seeds"`，夸大）。要让 cross-brain/audit 的"RL 赢"站得住，需要真 ≥3 seed
的 CI。（held-out 上 GEPA 1.458 > GRPO 1.183 大概率不变。）

**Script change / 脚本改法: NONE — the flag exists** (`orchestrate_v2.mjs --seed-tag`):
```bash
# needs the H100 pod back (the prior one was evicted by node disk-pressure)
node experiments/rl-skill-opt/orchestrate_v2.mjs --category network-dns \
  --train-cases c068,c069,c070,c071,c072,c073 --rounds 3 --k 4 \
  --provider gpt --seed-tag s2 --cuda-device 0      # repeat: --seed-tag s3 --cuda-device 1
node experiments/rl-skill-opt/eval-matrix.mjs --methods grpo --seeds s1,s2,s3
node experiments/rl-skill-opt/analyze.mjs          # then FIX basis:"seeds" only once ≥3 real seeds exist
```
Also: either run these or **stop labeling the checkpoint ensemble "seeds"** in
`analyze.mjs` and the paper (relabel "single-run checkpoint spread").

**Token cost / 成本:** per seed ≈ 72 train + ~11 eval = ~83 rollouts × ~96K =
**~8M tokens/seed**; 2 more seeds ≈ **~16M tokens** + GPU pod time.
**Blocker / 阻塞:** an 8×H100 pod (the real gate, not tokens).

**Acceptance / 验收:** real ≥3-seed bootstrap CI on the GRPO row; `basis:"seeds"`
becomes true. **Risk if skipped:** keep the RL track out of the main paper, or
present it strictly as an environment/testbed contribution with the single-seed
caveat (current honest framing).

---

## Suggested order & total budget / 建议顺序与总预算

| # | Experiment | Tokens | Wall-clock | Gate |
|---|---|---|---|---|
| 1 | GPU real-judge re-judge | ~50K | <2 min | API key |
| 2 | Judge κ (2 LLM + human N=50) | ~0.8M | ~3 h (human) | API key + 1 labeler |
| 3 | Security-OFF A/B (1–2 brains) | ~12–23M | ~1–2 h/brain | code change + `npm test` + disposable ns |
| 4 | Multi-seed RL (2 seeds) | ~16M | hours | **8×H100 pod** |

- **Minimum viable for credibility (do 1+2+3, 1 brain): ≈ 12–13M MaaS tokens.**
  These four numbers turn the three weakest Limitations (judge unvalidated, GPU
  rubric, observational accuracy-cost) into results.
- **Full (1+2+3×2-brain+4×2-seed): ≈ ~40M tokens** + an H100 pod.
- **中文.** 性价比最高是 1+2+3（单 brain）≈ 12–13M token，把三条最弱的 Limitation
  变成结果；要彻底就再加 3 的第二个 brain + 4 的多 seed ≈ ~40M token + 一个 H100 pod。

**Secrets / 密钥:** all API steps read `SCITIX_API_KEY` from the gitignored
`experiments/aaai-paper/.secrets.env`. **Rotate the key after the runs** (it was
pasted in chat history previously).

**Order rationale / 顺序理由:** 1 is free and removes the worst caveat; 2 is cheap
and is exactly where SREGym differentiates; 3 is the highest reviewer-value
single experiment; 4 only if you pursue the RL claim in the main paper.
