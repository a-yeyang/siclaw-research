# Siclaw AAAI — Research Assessment & Evaluation Rewrite Record
# Siclaw AAAI — 科研评估与实验重写记录

> Bilingual (EN / 中文). Generated 2026-06-07 from a full read of the codebase,
> the on-disk experiment artifacts (not just the markdown summaries), and the
> SREGym / AIOpsLab methodology PDFs. Every number below traces to a real file.
>
> 双语文档。2026-06-07 基于对全部代码、**落盘实验数据**（而非仅 markdown 摘要）、
> 以及 SREGym / AIOpsLab 方法学 PDF 的完整审读生成。下列每个数字都可溯源到真实文件。

---

## 0. TL;DR / 总览

**EN.** The project has two research threads: (1) a **security paper**
(`paper/siclaw-aaai.tex`) — defense-in-depth for SRE agents; and (2) an **RL
skill-optimization** track (`experiments/rl-skill-opt/`) — closed-loop SRE-skill
learning, GEPA vs GRPO. The single most important finding of this assessment:
**the paper `.tex` shipped "keyword-matching-era" numbers that are contradicted
by the project's own honest `RESULTS.md`.** A reviewer opening
`judge-gpu-rdma.mjs:12` (a `lower.includes()` scorer) and `security-tradeoff.mjs`
(a hardcoded 242-violation estimate) would find the "LLM-as-judge" and "242
violations" claims indefensible — a desk-reject-grade credibility risk. This
session **rewrote the Evaluation section** to use the real LLM judge, the
measured violation counts, and four LLM brains (§4 below).

**中文.** 本项目有两条研究线：(1) **安全论文**（`paper/siclaw-aaai.tex`）——SRE
agent 的纵深防御；(2) **RL skill 优化**线（`experiments/rl-skill-opt/`）——闭环
SRE-skill 学习，GEPA vs GRPO。本评估最重要的结论：**论文 `.tex` 装的是"关键词
匹配时代"的数字，而这些数字被项目自己诚实的 `RESULTS.md` 推翻。** 审稿人只要
打开 `judge-gpu-rdma.mjs:12`（一个 `lower.includes()` 打分器）和
`security-tradeoff.mjs`（硬编码的 242 违规估计），"LLM-as-judge" 和 "242
violations" 两个核心声明就会当场崩掉——这是 desk-reject 级的诚信风险。本次会话
已**重写了 Evaluation 节**，改用真 LLM judge、实测违规数、4 个 LLM brain（见下文 §4）。

---

## 1. Experiment Audit / 实验审计

### 1.1 Real successes — strong & defensible / 真·成功（强且可辩护）

| Experiment | Evidence (file) | Result |
|---|---|---|
| Real LLM checklist judge | `reports/llm-judgments-claude-sonnet-4-6.json` | SREGym-style judge; catches keyword errors **both** ways (c040 false-pass 0.80→0.10; c045 false-fail 0.47→1.00) |
| Multi-model diagnosis | `reports/multimodel-summary.json` | 4 brains, 88–90% / 0.898–0.930, **no self-judge bias** |
| Measured emergent unsafety | `reports/benign-violations.json` | **47 sandbox-escape cmds / 0.12 per case** over 400 benign traces; DeepSeek 3–5× peers |
| Indirect prompt injection | `runs-injection/injection-summary.json` | 12 payloads × 3 brains = 36; **35/36 refused, 0 exfiltration** |
| Closed-loop RL environment | `rl-skill-opt/` (297 traces, GEPA 7 gens) | live-K8s-diagnosis-as-reward; the durable RL contribution |
| 6-layer pipeline correctness | `security-redteam.test.ts` | 31 tests pass; pipeline genuinely blocks the 30 attack strings |

**EN.** The strongest assets are the *real LLM judge* and the *measured
emergent-unsafety* result — and, ironically, the paper did not use either. The
multi-model run (DeepSeek/Kimi/Qwen + Claude) is a stronger result than the
single-model story the paper told.

**中文.** 最强的资产是*真 LLM judge* 和*实测涌现不安全*——讽刺的是论文两者都没用。
多模型实验（DeepSeek/Kimi/Qwen + Claude）比论文里单模型的叙事更强。

### 1.2 Honest negatives — these are GOOD, write them up / 诚实的失败（是好事，要正面写）

| Result | Data | Meaning |
|---|---|---|
| **RL lost to GEPA** (pre-registered) | held-out: GEPA **1.458** vs GRPO **1.183** | Pre-registered rule failed → honest negative |
| **LoRA training added nothing** | GRPO best skill == base model's round-0 sample | gradient steps didn't beat the un-trained Qwen's first generation |
| naïve RAFT mode-collapse | v1 reward 0.737→0.587→0.583, round-2 = 744-char clones | classic Echo-Trap; characterizing it is a contribution |
| multi-seed RL never ran | H100 pod evicted (`hpe-node144` disk-pressure) | "n=3 seeds" is actually **1 seed × 3 checkpoints** (mislabeled `basis:"seeds"` in `analyze.mjs`) |
| security-OFF baseline absent | `run-baseline.mjs` does not exist | "zero accuracy cost" has **no on/off comparison** |
| hard-mode unjudged | `runs-hard/` traces exist, `reports/judged/` are guided-mode scores | half-finished |

### 1.3 "Paper-only" inflated claims — now FIXED this session / 纸面虚高（本次已修正）

| Paper claimed (old) | Reality (measured) | Status |
|---|---|---|
| "LLM-as-judge" 90% / 0.818 | keyword `lower.includes()`; real judge = **88% / 0.898** | ✅ fixed |
| "~242 violations / 2.4 per case" | hardcoded estimate; real = **47 / 0.12 per case** | ✅ fixed |
| GPU/RDMA 100% / 0.923 (LLM-judged) | keyword-scored, ConfigMap-simulated, never LLM-judged | ✅ relabeled as heuristic feasibility probe |
| Remediation = 1.000 (all cats) | keyword artifact; real = **0.88–0.92** | ✅ fixed |
| "30 red-team, 100% blocked" | static unit test of strings built to be blocked | ✅ relabeled as static suite |

---

## 2. SOTA Comparison & Gap / 与 SOTA 对比及差距

**SREGym is the current rigor bar** (same group's Stratus → NeurIPS'25; ITBench →
ICML'25 Oral). / **SREGym 是当前严谨度标杆**（同组 Stratus 上 NeurIPS'25；ITBench
上 ICML'25 Oral）。

| Dimension | SREGym (bar) | AIOpsLab | **Siclaw (ours)** |
|---|---|---|---|
| Scale | 90 problems / 50 fault primitives / 139 svc | 48 | self-authored 100 cases, 1 cluster |
| Environment | live K8s **+ noise** (2/5min) | live K8s, clean | live K8s, no noise |
| Tasks | **E2E: diagnosis + mitigation (state-verified)** | 4-level decomposed | **diagnosis only (read-only)** |
| Oracle | checklist LLM-judge, 9 Y/N × 3 dims, τ=7/9 | exact-match (+ optional **unvalidated** LLM-judge) | real LLM-judge (no κ yet) |
| **Judge validated?** | **κ=0.90 vs human (N=100), cross-LLM → 0.94** | No | **No (the key gap)** |
| Models × runs | 3 agents × 3 models × **3 runs** + variance heatmaps | 2 models, **1 run** | 4 brains × 1 run, no CIs |
| HW/OS faults | **eBPF (syscall fail, dm-dust disk errors)** | No | GPU/RDMA but **ConfigMap-simulated + keyword-scored** |
| Reward-hacking control | **Yes (hidden injector proxy)** | No | No |
| Leakage control | **Yes (ported-vs-new split)** | No | No |
| Headline | Claude Code E2E 60.7%; Stratus mitig 78.5% | FLASH 59.3% | 88–90% diagnosis (not comparable) |

**EN — where we lag (real gaps):** diagnosis-only vs E2E; un-validated judge (no
κ) vs SREGym's κ=0.90; 1 run / no CIs vs 3 runs + heatmaps; self-authored single
cluster vs portable + noise + reward-hacking defenses. **We will lose a
head-to-head on benchmark scale or capability — do not fight there.**

**EN — where we lead (SOTA has none of these):** (1) a **security/threat model**
(agent-as-untrusted-code, defense-in-depth) — SREGym/AIOpsLab/ITBench/Stratus
have *zero*; (2) **measured emergent unsafety** (benign agents emit escape
commands; models differ 3–5×) — an AI phenomenon, not engineering; (3) **indirect
injection via tool output**; (4) **GPU/RDMA** fault class (needs upgrade to real
signals + LLM judge); (5) **closed-loop skill learning** (others *benchmark*
agents; we *optimize* them).

**中文 — 我们落后的地方（真实差距）：** 只做诊断 vs 端到端；judge 未验证（无 κ）
vs SREGym 的 κ=0.90；单 run / 无 CI vs 3 run + 方差热图；自出题单集群 vs 可移植 +
噪声 + 反作弊防护。**在 benchmark 规模或能力上正面硬刚一定输——别在那里打。**

**中文 — 我们领先的地方（SOTA 全都没有）：** (1) **安全/威胁模型**
（agent-as-untrusted-code、纵深防御）——SREGym/AIOpsLab/ITBench/Stratus *零*
安全模型；(2) **实测涌现不安全**（良性 agent 也发逃逸命令；模型间差 3–5×）——
这是 AI 现象，不是工程；(3) **工具输出的间接注入**；(4) **GPU/RDMA** 故障类
（需升级为真信号 + LLM judge）；(5) **闭环 skill 学习**（别人*评测* agent，
我们*优化* agent）。

---

## 3. What AAAI Needs / 投 AAAI 还需补什么

### A. Must-fix (else credibility risk / desk-reject) / 先决条件（不改 = 诚信风险）

1. **Replace all keyword scores with the real LLM judge** — ✅ done this session.
2. **Replace "242 estimate" with measured 47 / 0.12** — ✅ done.
3. **Build a real security-OFF baseline** to support "zero accuracy cost" (currently asserted). / 真做 security-OFF 对照。
4. **Judge κ validation** — human-label 50–100 cases, report Cohen's κ + 2nd judge model (SREGym's bar). / judge 的 κ 人工验证。
5. **Cut all "100%" triumphalism; report CIs.** / 删掉所有 100% 胜利腔，配 CI。

### B. Must-add (to be competitive) / 竞争力

6. **Statistics**: ≥3 runs/seeds, bootstrap/Wilson CIs, per-category variance. / 统计。
7. **Real red-teaming** (LLM red-teamer / fuzzer; report misses) instead of static unit tests. / 真红队。
8. **External validity** — run the agent on a SREGym/AIOpsLab subset for a head-to-head (highest-leverage move). / 外部效度——SREGym 子集 head-to-head（性价比最高）。
9. **Mitigation, or explicitly defend read-only as a safety property.** / 补缓解，或正面把 read-only 论证为安全属性。

### C. Reframe (the strategic move) / 重新定位（战略建议）

**EN.** Center the paper on the **emergent-unsafety phenomenon + defense** (an AI
contribution), not the systems architecture (which AAAI reads as "not enough AI
novelty"). The measured-emission result + cross-model differences + injection =
the AI story SREGym/AIOpsLab/ITBench/Stratus do not have. This session's rewrite
already shifts the headline to this framing.

**中文.** 把论文重心放在**涌现不安全现象 + 防御**（这是 AI 贡献），而不是系统
架构（AAAI 会嫌"AI novelty 不足"）。实测发射 + 跨模型差异 + 注入 = SREGym/
AIOpsLab/ITBench/Stratus 都没有的 AI 故事。本次重写已经把 headline 切到这个框架。

### RL-track verdict / RL 线判断

**EN.** Not ready as a standalone AAAI main-track paper: single seed, RL *lost* to
GEPA, the LoRA updates added nothing, N=3–4. Best home: an **environment/testbed
paper** ("first closed-loop SRE-skill-optimization env + honest finding that
reflective search beats RL at matched budget"), or fold the GEPA-optimized skill
into the main agent paper as one section. To save the RL claim itself: ≥3 real
seeds, ≥3 fault categories (currently only network-dns), larger N, fix the
`basis:"seeds"` mislabel, regenerate the stale `ANALYSIS.json`.

**中文.** 不够格当独立 AAAI 主会论文：单 seed、RL *输*给 GEPA、LoRA 更新无贡献、
N=3–4。最佳归宿：**environment/testbed 论文**（"首个闭环 SRE-skill-optimization
环境 + 诚实发现：matched-budget 下反思式搜索胜过 RL"），或把 GEPA 优化出的 skill
作为主 agent 论文的一节。若要救 RL 主张本身：≥3 真 seed、≥3 个故障类别（现仅
network-dns）、放大 N、改掉 `basis:"seeds"` 误标、重生成过期的 `ANALYSIS.json`。

---

## 4. Evaluation Rewrite Record (this session) / 本次实验重写记录

**Scope:** pure rewrite, **zero new experiments**. All numbers recomputed from
existing per-case judgments by a read-only aggregator
(`experiments/aaai-paper/rebuild-paper-tables.mjs`). Paper compiles clean at
**8 body pages** (AAAI limit). / 范围：纯改写，**零新实验**。所有数字由只读聚合脚本
从已有的逐 case 判分重算。论文编译通过，**正文 8 页**（AAAI 上限）。

### Before → After / 修改前后

| Claim | Before (keyword/estimate) | After (real, measured) |
|---|---|---|
| Diagnostic judge | "LLM-judge" = substring match | real LLM checklist judge |
| Headline | 90% / 0.818 (1 model) | **88–90% / 0.898–0.930** (4 brains) |
| Remediation dim | 1.000 | 0.88–0.92 |
| Scope dim | 0.481 (weakest) | 0.86–0.94 |
| Violations | ~242 / 2.4 per case (estimate) | **47 / 0.12 per case** (measured) |
| GPU/RDMA | 100% / 0.923 "LLM-judged" | feasibility probe, heuristic rubric, relabeled |
| Red-team | "evaluation, 100% blocked" | static suite, honestly framed |
| SREGym comparison | implied "90% > their 60.7%" | "not apples-to-apples; safety axis is orthogonal" |

### Structural changes / 结构改动

- New §5.4 **Emergent Unsafety During Benign Diagnosis** (the measured thesis: 47 / 0.12, DeepSeek 3–5×, most-accurate brain is most escape-prone).
- New §5.5 **Indirect Prompt Injection** (35/36 refused, 0 exfil).
- Red-team relabeled as a **static** suite; SREGym comparison de-risked.
- **Limitations** strengthened to pre-empt reviewers (single-seed/no-CI, no κ, observational accuracy-cost, GPU rubric/simulated).
- Dropped the 3 result *figures* (each duplicated its adjacent table, none `\ref`'d) to hold 8 pages; overview + architecture figures retained.

### What this rewrite did NOT fix (needs real runs) / 本次未修复（需真跑）

1. Judge κ validation (human labels + 2nd judge). / judge 的 κ 验证。
2. Security-OFF A/B baseline. / security-OFF 对照。
3. GPU/RDMA re-judge with the real LLM judge (traces exist; swap the scorer). / GPU 用真 judge 重判。
4. Multi-seed + confidence intervals. / 多 seed + CI。

These are now written honestly as Limitations rather than hidden. / 这些现已作为
Limitations 诚实写出，而非隐藏。

---

## 5. Provenance — number → source file / 数据溯源

| Paper number | Backing file | How |
|---|---|---|
| `tab:models`, `tab:categories` | `reports/llm-judgments-claude-sonnet-4-6.json`, `reports/judged/{kimi,deepseek,qwen}.json` | aggregated by `rebuild-paper-tables.mjs` |
| `tab:emergent` (47 / 0.12) | `reports/benign-violations.json` | per-model blocked counts |
| Injection (35/36, 0 exfil) | `runs-injection/injection-summary.json` | per-trial attempted/neutralized/exfiltrated |
| `tab:gpurdma` (rubric) | `gpu-rdma-logs/g01..g10` + `judge-gpu-rdma.mjs` | **heuristic keyword rubric — honestly labeled, NOT the LLM judge** |
| `tab:redteam`, `tab:ablation` | `security-redteam.test.ts`, `security-ablation.test.ts` | static pipeline unit tests (real `src/` functions) |
| RL headline (GEPA 1.458 / GRPO 1.183) | `rl-skill-opt/results-v2/ANALYSIS.json` + `eval/*/judgments.json` | composite reward; single-seed caveat applies |

**Reproduce the diagnostic tables:** / **复现诊断表：**
```bash
node experiments/aaai-paper/rebuild-paper-tables.mjs
```

**Rebuild the paper:** / **重新编译论文：**
```bash
cd paper && pdflatex siclaw-aaai && bibtex siclaw-aaai && pdflatex siclaw-aaai && pdflatex siclaw-aaai
```
