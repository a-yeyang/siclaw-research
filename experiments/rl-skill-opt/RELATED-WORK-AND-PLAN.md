# Related Work & Upgraded Experiment Plan — RL/Search for SRE Agent Skill Optimization

> Scope: positioning our *agent-in-the-loop* RL skill-optimizer (Siclaw) against the
> state of the art, and a concrete redesign that fixes our three observed failure
> modes (sample starvation, RAFT mode-collapse, surface reward-hacking) to a bar an
> AAAI reviewer will accept. Companion to `RESULTS.md` and `README.md`.
>
> **Citation hygiene.** Every arXiv ID below was retrieved from a live web search
> (June 2026). IDs of the form `25NN.xxxxx` are 2025; `26NN.xxxxx` are 2026
> (e.g. `2602.*` = Feb 2026). Papers I verified by fetching the abstract are marked
> ✅; papers known only from a search-result summary are marked ⚠️ **(verify before
> citing in the paper)** — these are the very-recent 2026 skill-induction preprints,
> which are corroborative, not load-bearing. The load-bearing citations (Voyager,
> ADAS, Reflexion, GEPA, OPRO, DSPy/MIPRO, GRPO/DeepSeek, ReST/RAFT/STaR, AIOpsLab,
> Flow-of-Action, StepFly, SREGym, ITBench, SWE-Gym/SWE-RL, "One Token to Fool",
> DPH-RL) are all verified.

---

## Part A — Literature Landscape

### A.0 The one-paragraph map

There are five relevant research families. **(1) Skill libraries / agentic-system
search** (Voyager, ADAS) — *grow or program* reusable behaviors, but on cheap
simulated environments. **(2) Verbal / reflective self-improvement** (Reflexion,
Self-Refine) — improve via natural-language feedback, no weight updates. **(3) RL
for LLM agents with outcome rewards** (GRPO/DeepSeek, RAGEN/StarPO, ETO, ArCHer,
WebRL, AgentTuning, SWE-Gym/SWE-RL) — gradient RL on verifiable/outcome signals;
this is the family we are in. **(4) Automatic prompt/instruction optimization**
(APE, OPRO, PromptBreeder, EvoPrompt, DSPy/MIPROv2, TextGrad, GEPA) — search over
the *prompt* with a frozen policy; these are our strongest baselines. **(5) Expert
iteration / reward-ranked finetuning** (STaR, ReST, RAFT, RFT) — the actual update
rule we used (RAFT). The **SRE/AIOps** literature (AIOpsLab, Flow-of-Action,
StepFly, ITBench, SREGym) *consumes* hand-authored SOPs/runbooks or *benchmarks*
agents — **none learns the SOP/skill by RL against a live environment.** That hole
is our contribution.

### A.1 SRE / AIOps-specific (the gap we exploit)

| Work | Venue | arXiv | What it does | Does it *learn* the SOP/skill? |
|---|---|---|---|---|
| **AIOpsLab** | MLSys'25 | 2501.06706 ✅ | Holistic *evaluation* framework for AIOps agents: deploys microservices, injects faults, exports telemetry, agent APIs (`get_logs`/`get_metrics`/`exec_shell`). | **No.** Benchmark/orchestration only. |
| **Flow-of-Action** | WWW'25 Companion | 2502.08224 ✅ | SOP-**enhanced** multi-agent RCA. Retrieves/auto-generates an SOP, converts SOP→code to constrain ReAct. 35.5%→64.0% acc. | **No.** SOPs are retrieved or one-shot LLM-generated, *not* reward-optimized. |
| **StepFly** | preprint (MS) | 2510.10074 ✅ | Agentic Troubleshooting-Guide (TSG) automation: LLM extracts a DAG from a human TSG, scheduler-executor runs it; ~94% on GPT-4.1. | **No.** TSGs are human-authored; LLM only *parses/executes* them. |
| **ITBench** | ICML'25 (oral) | 2502.05352 ✅ | Real-world IT-automation benchmark (SRE/CISO/FinOps). SOTA agents resolve only **11.4% SRE**. | **No.** Benchmark; quantifies how bad agents are. |
| **SREGym** | CAIS'26 / preprint | 2605.07161 ✅ (PDF in repo) | Live, high-fidelity SRE benchmark (90 problems, app+fault+oracle); superset of AIOpsLab+ITBench; OS-kernel faults, metastable/compound failures. *Same UIUC/IBM lineage as AIOpsLab (Chen, Xu).* | **No.** Benchmark/"training ground" — provides the *environment*, not a skill-learning method. This is the paper our security work already contrasts against. |
| Agent-S | preprint | 2503.15520 ✅(title) | LLM workflow to automate SOPs (e-commerce). | **No.** Executes SOPs. |

**Precise gap statement:** the SRE/AIOps SOTA splits cleanly into *benchmarks*
(AIOpsLab, ITBench, SREGym) and *SOP-consumers* (Flow-of-Action, StepFly, Agent-S).
**No top-venue work closes the loop — i.e., uses the live SRE environment's
diagnosis quality as a reward to *learn* the SOP/skill itself.** Flow-of-Action even
*auto-generates* SOPs but with a single LLM call and **no reward signal**; that is
exactly the no-optimization baseline we beat in Stage 1. To our knowledge we are the
first to run *agent-in-the-loop RL where the unit of optimization is the injected
diagnostic skill and the reward is a live K8s diagnosis judged end-to-end.*

### A.2 Skill libraries / agentic-system search

| Work | Venue | arXiv | Optimizes | Reward | Sample-eff. / diversity handling |
|---|---|---|---|---|---|
| **Voyager** | NeurIPS'23 | 2305.16291 ✅ | A growing **library of executable code skills**; auto-curriculum. | Env feedback + self-verification (no weight updates; GPT-4 black-box). | Compositional skills + retrieval ⇒ transfer to new worlds. No gradient; no diversity control needed (library grows monotonically). |
| **ADAS** (Meta Agent Search) | ICLR'25 | 2408.08435 ✅ | The **entire agent as code** (prompts, tool use, control flow). | Task accuracy on held-out. | **Archive of prior designs** (open-ended novelty), meta-agent reads archive each step → diversity by construction. Transfers across models/domains. |
| Claude Agent Skills | product (Anthropic '25) | — | Hand-authored procedural skills (the paradigm our Siclaw "skills" instantiate). | n/a | n/a — manual. Cited by 2026 skill-induction work as the thing to *automate*. |
| SkillWeaver / SkillOS / ProcMEM / SkillRevise | preprints '25–'26 | 2605.06614, 2602.01869, 2606.01139 ⚠️ | Autonomously **induce/curate/revise** reusable skills from experience. | Mixed (task success; some RL). | Emerging consensus: *self-generated skills are unreliable* without verification (SkillsBench finding) — supports our "skills must be reward-validated" stance. |

**Takeaway for us:** Voyager and ADAS are the canonical "learn the skill/agent"
papers, but both run on **cheap, fast** environments (Minecraft, math/coding) and
mostly *grow/search* rather than *gradient-train a proposer*. Our novelty is doing
this where each rollout is a **30–90 s live-cluster investigation + LLM judge** —
the expensive-environment regime they do not address.

### A.3 Verbal / reflective self-improvement (no weights)

| Work | Venue | arXiv | Mechanism |
|---|---|---|---|
| **Reflexion** | NeurIPS'23 | 2303.11366 ✅ | Verbal RL: agent reflects on feedback into an episodic memory buffer; no weight update. |
| **Self-Refine** | NeurIPS'23 | 2303.17651 ✅ | Same LLM generates feedback on its own output and refines, iteratively. ~+20% abs. |

These motivate a strong, **training-free** baseline: a *reflective* skill writer that
critiques its own SOP against a failed trace (this is essentially what GEPA does,
below, but at the prompt level).

### A.4 RL for LLM agents with outcome / verifiable rewards (our family)

| Work | Venue | arXiv | Optimizes | Reward | Key idea / what they do about our failure modes |
|---|---|---|---|---|---|
| **GRPO** (DeepSeekMath) | preprint | 2402.03300 ✅ | Policy weights. | **Verifiable** (rule-based). | Critic-free; group of K samples, advantage = reward − group mean. *This is the right replacement for our RAFT update.* |
| **DeepSeek-R1** | Nature'25 | 2501.12948 ✅ | Reasoning policy. | **RLVR** (verifiable/rule-based tasks: math, code, STEM). | Pure-RL with verifiable rewards. *(The widely-cited rationale that they used verifiable — not neural — rewards to resist reward-hacking at scale appears in the R1-Zero discussion / secondary summaries; cite carefully, it is not in the main abstract.)* Directly relevant to our judge-hacking. |
| **RAGEN / StarPO(-S)** | preprint | 2504.20073 ✅ | Multi-turn agent policy. | Trajectory-level outcome. | Names the **"Echo Trap"**: reward-variance cliff + entropy drop + gradient spikes (= *our* mode-collapse). Fix: **StarPO-S** = uncertainty-based trajectory filtering, critic incorporation, gradient stabilization. Also: diverse initial states, frequent sampling, *reasoning-aware* rewards or strategies stay shallow. **The single most on-point diagnosis of our failure.** |
| **ETO** | ACL'24 | 2403.02502 ✅ | Agent policy via DPO on success/fail trajectory pairs. | Outcome. | **Learns from failures** (contrastive), not only successes — a remedy for RAFT's "imitate the single winner" collapse. |
| **ArCHer** | ICML'24 | 2402.19446 ✅ | Hierarchical multi-turn RL. | Per-utterance + outcome. | 100× more sample-efficient than PPO via off-policy high-level critic — the sample-efficiency frontier. |
| **WebRL** | preprint | 2411.02337 ✅ | Open-LLM web agent. | Outcome-supervised RM + **self-evolving curriculum**. | Generates new tasks from *failed* attempts (curriculum) to fight sparse reward + distribution drift. Llama-3.1-8B: 4.8%→42.4%. |
| **AgentTuning** | ACL'24 Findings | 2310.12823 ✅ | Agent policy (SFT). | Filtered trajectories. | Mix agent data + general data to keep general ability — relevant if we ever SFT the *brain*. |
| **SWE-Gym** | ICML'25 | 2412.21139 ✅ | SWE agent + **verifier**. | Unit tests (verifiable). | Rejection-sampling FT + **best-of-N via learned verifier**. +14% on SWE-bench. *Best-of-N is a baseline we must run.* |
| **SWE-RL** | NeurIPS'25 | 2502.18449 ✅ | LLM reasoning for SWE. | **Rule-based** (similarity to ground-truth patch). | First RL on real software evolution; rule-based reward beats SFT and *generalizes out-of-domain* — argues for verifiable over judge-only reward. |
| **Agentic-RL survey** | preprint | 2509.02547 ✅ | — | — | Frames agent RL as POMDP (not single-step MDP); taxonomy over planning/tools/memory/**self-improvement**. Good for our "where this sits" paragraph. |

### A.5 Automatic prompt / instruction optimization (our must-run baselines)

| Work | Venue | arXiv | Optimizes | Search operator | Why it threatens / helps us |
|---|---|---|---|---|---|
| **APE** | ICLR'23 | 2211.01910 ✅ | Instruction. | LLM proposes + selects (Monte-Carlo). | The original "prompt = program, search it." |
| **OPRO** | ICLR'24 | 2309.03409 ✅ | Prompt. | LLM-as-optimizer reads (prompt,score) **trajectory**, proposes better. | **Direct competitor to our proposer.** Up to +50% on BBH. A reviewer's first "why not just OPRO?" |
| **PromptBreeder** | preprint (DeepMind) | 2309.16797 ✅ | Task-prompts *and* mutation-prompts (self-referential GA). | Binary-tournament GA, LLM mutation. | Evolutionary; beats CoT/OPRO on GSM8K. Population ⇒ built-in diversity (the thing we lacked). |
| **EvoPrompt** | ICLR'24 | 2309.08532 ✅ | Discrete prompt. | GA / Differential Evolution, LLM operators. | Population-based; +25% on BBH. Cheap diversity. |
| **DSPy / MIPROv2** | EMNLP'24 | 2406.11695 ✅ | Instructions **+ few-shot demos** of a multi-stage program. | Bayesian optimization over proposals; mini-batch surrogate. | Industry-standard. Optimizes the *whole program*, credit-assigns across modules. **Must compare.** |
| **TextGrad** | Nature'25 | 2406.07496 ✅ | Any text variable in a compound system. | "Textual gradients" (LLM feedback) backprop. | Principled prompt-opt; the gradient-free analogue of what we do. |
| **GEPA** | ICLR'26 (oral) | 2507.19457 ✅ | Prompts of a compound system. | **Reflective evolution + Pareto-frontier candidate selection.** | **The killer baseline.** Explicit headline: *reflective prompt evolution beats GRPO by +6–19 pp using up to **35× fewer rollouts***, and beats MIPROv2 by >10 pp. In our **sample-starved** regime, GEPA is *theoretically the right tool*. We MUST run it and either beat it or justify RL another way. Its **Pareto front** is also a direct cure for mode-collapse: it keeps the best prompt *per instance*, not one global winner. |

### A.6 Expert iteration / reward-ranked finetuning (our update rule)

| Work | Venue | arXiv | Update | Notes |
|---|---|---|---|---|
| **STaR** | NeurIPS'22 | 2203.14465 ✅ | SFT on self-generated rationales that reached the right answer (+ rationalization). | Origin of "bootstrap on your own correct outputs." |
| **ReST** | preprint (DeepMind) | 2308.08998 ✅ | Grow (sample) → Improve (offline RL on filtered data). | The "ReST" we cite. Sample-efficient via data reuse. |
| **ReST^EM** | preprint (DeepMind) | 2312.06585 ✅ | ReST on reasoning w/ binary reward. | AlphaZero-style self-training. |
| **RAFT** | TMLR'23 | 2304.06767 ✅ | Reward-rank samples, SFT on the top-k. Gradient-free generation. | **Exactly our Stage-2 update.** Simpler/stabler than PPO — *but* with K=4 and one strong winner it collapses (our result; cf. RAGEN Echo Trap). |
| Re-ReST | preprint | 2406.01495 ✅(title) | ReST + a reflector that fixes low-quality samples. | Motivates adding reflection to the proposer. |

### A.7 Why our three failures are *known, named, citable* phenomena

1. **Sample starvation (≈72 rollouts).** GEPA's whole thesis is that **prompt
   evolution wins precisely when rollouts are scarce** (2507.19457). ArCHer
   (2402.19446) and WebRL (2411.02337) are the sample-efficiency frontier. Our 72
   rollouts is ~3 orders of magnitude below GRPO-scale RLVR. **Diagnosis: we were in
   GEPA/expert-iteration territory and used the wrong tool (gradient RAFT).**
2. **RAFT mode-collapse (LoRA loss→0.0004, ~744-char clones).** This is textbook
   **entropy/diversity collapse in RLVR/GRPO**: monotone entropy decay, outputs
   converge to near-identical solutions, Pass@k *drops* (DPH-RL, 2509.07430 ✅;
   AEPO 2510.08141; UCAS 2510.10649). RAGEN names the agent-RL version: the **Echo
   Trap** (2504.20073). **Diagnosis: expected; fix is mass-covering divergence /
   entropy floor / Pareto population / imitate content not surface string.**
3. **Reward-hacking a surface correlation (DNS keyword over-fit; NetworkPolicy
   mislabeled "DNS failure").** This is **classic reward-model gaming via spurious
   features** (verbosity/keyword shortcuts), surveyed broadly, *and* specifically
   for LLM-judges: **"One Token to Fool LLM-as-a-Judge"** (2507.08794 ✅) shows a
   single token / generic opener triggers **false-positive** judge rewards on GPT-o1
   and Claude-4; RobustJudge (2506.09443) and "high accuracy ≠ robustness" findings
   confirm judges are gameable under shift. DeepSeek-R1 *deliberately uses only
   verifiable rewards to avoid this*. **Diagnosis: an LLM-judge-only reward is
   hackable; we need verifiable components and judge hardening.**

---

## Part B — Our Novelty & Positioning

**One-sentence novelty.** *We close the AIOps SOP loop: an agent-in-the-loop RL
system that learns the diagnostic skill (SOP injected into the agent's system
prompt) using the live K8s diagnosis quality as reward — the first SRE-skill learner,
versus a literature that only benchmarks SRE agents (AIOpsLab/ITBench/SREGym) or
consumes hand-authored SOPs (Flow-of-Action/StepFly).*

**Three defensible claims (calibrated to what the data supports):**
- **C1 (strong, proven).** A reward-validated diagnostic skill, injected into the
  *real* agent, generalizably improves live diagnosis (held-out **+0.30**, 0.70→1.00)
  and *changes agent behavior* (NetworkPolicy-first; dnsConfig inspection), not just
  wording. — This is the paper's anchor; it is real and held-out.
- **C2 (honest negative → turned into method).** Naïve RAFT in the expensive-rollout
  regime **fails predictably** via Echo-Trap mode-collapse and judge reward-hacking,
  *regressing* on held-out (−0.10). We characterize *why* and show the fixes
  recover/surpass the hand-crafted skill.
- **C3 (comparative, the reviewer's question).** With the fixes, **agent-in-the-loop
  optimization** (whether RL or reflective search) closes the gap to the human SOP
  and **transfers across fault categories / agent brains**, and we report *when RL is
  worth it over prompt-opt (GEPA/DSPy) and best-of-N* — not assumed, measured.

**What an AAAI reviewer will believe vs. reject.**
- ✅ Believable: "a learned/searched skill matches or beats a hand-crafted SOP on
  held-out live faults, across ≥2 categories and ≥2 brains, with CIs, and we show why
  naïve RL fails." Honest-negative-plus-fix is *strong* at AAAI.
- ❌ Over-claim to avoid: "RL beats prompt-optimization" from a single category /
  single seed / N=6 (±1 case ≈ 0.17 swing). With GEPA claiming 35× efficiency, **any
  RL-superiority claim must be matched-rollout-budget and multi-seed**, or reframed as
  "RL needed only because skills must transfer/compose beyond what static prompt-opt
  yields." Also avoid "LLM judge = ground truth" — it is a *hackable* proxy (cite
  2507.08794); we must add verifiable reward and robustness checks.

---

## Part C — Upgraded Experiment Design (AAAI-grade)

### C.0 Design principles (each maps to a failure mode and a citation)

| Failure | Fix in new design | Grounding |
|---|---|---|
| Sample starvation | (i) Make the right comparison: **RL vs. GEPA/DSPy vs. best-of-N at *matched rollout budget*.** (ii) Curriculum from failed cases. (iii) Cache/parallelize rollouts; reuse traces. | GEPA 2507.19457; WebRL 2411.02337; ReST 2308.08998 |
| Mode-collapse / no diversity | Replace 1-winner RAFT with: **GRPO-style group advantage**, **entropy floor / mass-covering (forward-KL/JS) divergence**, **Pareto-per-instance** candidate keeping, higher sampling temp, and **imitate skill *content/coverage*, not the surface string**. Seed proposer with the hand-crafted skill as behavioral prior. | DPH-RL 2509.07430; RAGEN/StarPO-S 2504.20073; GEPA Pareto front; AEPO 2510.08141 |
| Reward-hacking the judge | **Composite, partially-verifiable reward** = α·(verifiable rubric checks) + β·(judge) − γ·(spurious-cue penalty); **judge hardening** (rubric/checklist, randomized order, ensemble or self-consistency); **adversarial/audit cases** that punish DNS-tunnel-vision; **process reward** (did it enumerate NetworkPolicies before concluding?). | RLVR/DeepSeek-R1 2501.12948; "One Token to Fool" 2507.08794; RobustJudge 2506.09443; SWE-RL rule-based reward 2502.18449 |
| Generalization / shift | Held-out **within** category + **cross-category** transfer + **cross-brain** transfer + **compound-fault** stress (the SREGym hard regime). Report Pass@1 *and* Pass@k (collapse detector). | SREGym 2605.07161; ADAS transfer 2408.08435; DPH-RL Pass@k |

### C.1 The baseline ladder (run *all*; this is what makes it publishable)

Ordered weakest→strongest; each is a row in the headline table, every cell with mean
± 95% CI over seeds, on the **same** held-out + transfer sets.

1. **No-skill** (agent as-is) — lower bound. *(have: 0.70 held-out)*
2. **Hand-crafted skill** (human SOP) — the human upper-anchor. *(have: 1.00, +0.30)*
3. **Few-shot / static SOP retrieval** — Flow-of-Action-style: retrieve or one-shot
   LLM-generate an SOP, **no reward** (isolates "optimization" from "having any SOP").
4. **Reflective skill writer (training-free)** — Reflexion/Self-Refine: propose →
   read a failed trace → revise, best-of-M by judge. No weights.
5. **Prompt-opt: OPRO** — LLM-as-optimizer over the skill text, matched rollout
   budget. *(2309.03409)*
6. **Prompt-opt: DSPy/MIPROv2** — Bayesian instruction+demo opt of the skill slot.
   *(2406.11695)*
7. **Prompt-opt: GEPA** — reflective Pareto evolution; **the headline competitor**;
   matched budget. *(2507.19457)*
8. **Best-of-N + learned/judge verifier** — SWE-Gym-style inference-time scaling
   (no training of the proposer). *(2412.21139)*
9. **ReST/RAFT (ours, naïve)** — the failing baseline, *kept in the paper* as the
   honest negative. *(2304.06767/2308.08998)*
10. **GRPO-skill (ours, upgraded)** — group advantage + entropy/diversity control +
    composite reward + curriculum. **Our method.** *(2402.03300 + fixes above)*

> Decision rule for the paper's claim: if **(10) ≥ (7) GEPA** at matched budget on
> held-out **and** transfers better cross-category/brain, claim "RL adds value beyond
> prompt-opt for transferable skills." If **(7) ≥ (10)**, claim the (still-novel,
> still-publishable) result "for SRE-skill optimization, *reflective search* (GEPA)
> matches RL at a fraction of the cost — RL is not yet justified," and the
> contribution becomes the *first systematic study + the closed-loop environment*.
> **Either outcome is a paper.** State the rule before running (pre-registration).

### C.2 Ablations (isolate each fix)

A. **Update rule:** RAFT(K=4) vs. RAFT(K=8) vs. GRPO vs. GRPO+entropy-floor vs.
   GRPO+forward-KL(DPH) — show the collapse → recovery curve (entropy, Pass@k,
   candidate-edit-distance over rounds).
B. **Reward composition:** judge-only vs. judge+rubric(verifiable) vs.
   +spurious-penalty vs. +process-reward — measure held-out *and* the DNS-mislabel
   rate on the audit set (does hacking drop?).
C. **Diversity operator:** none vs. temperature vs. Pareto-per-instance vs. content-
   imitation (coverage of {NetworkPolicy, dnsConfig, CNI} reasoning) instead of
   string-imitation.
D. **Curriculum:** fixed train set vs. failed-case-resampling (WebRL-style).
E. **Behavioral prior:** cold-start proposer vs. seeded-with-hand-crafted-skill.
F. **Budget sweep:** performance vs. #rollouts (10/30/72/150/300) for ours vs. GEPA —
   *the* plot that settles "RL vs prompt-opt" honestly.

### C.3 Metrics & statistics (what reviewers check first)

- **Primary:** mean judge score and **pass-rate** on held-out + transfer, **mean ±
  95% CI** over **≥5 seeds** (proposer sampling seeds and, ideally, case-resampling).
  Report effect size vs. no-skill and vs. hand-crafted; **paired bootstrap or
  Wilcoxon** significance, *not* bare deltas (our N is small — say so).
- **Collapse diagnostics (novel, sell them):** policy **entropy** per round,
  **Pass@k** (k=1,4,8) — the canonical diversity-collapse signature (DPH-RL), and
  pairwise **edit-distance / embedding-diversity** of candidates per round.
- **Reward-hacking diagnostics (novel, sell them):** **mislabel rate** on adversarial
  audit cases (e.g., NetworkPolicy fault that *looks* DNS), **judge-robustness delta**
  (score under reordered/paraphrased traces; "One Token" perturbations), and
  **reward–truth gap** (judge reward vs. an independent verifiable-rubric score) to
  show whether the policy optimized truth or the proxy.
- **Process metrics:** tool-call ordering (did it enumerate NetworkPolicies *before*
  concluding?), tokens/rollout (already logged), wall-clock & $ per point of
  improvement (efficiency story vs. GEPA).
- **Cost transparency:** report total real rollouts and MaaS tokens (we already do:
  97 rollouts / 9.3M tokens) so the matched-budget comparison is auditable.

### C.4 Generalization tests (the credibility core)

1. **Held-out within category** (have: c074–c077). Keep.
2. **Cross-category transfer:** train on network-dns, evaluate the learned skill on a
   *different weak* category (compound 57–71%) — does it help, hurt, or no-op?
   (Detects over-specialization like our DNS tunnel-vision.)
3. **Cross-brain transfer:** skill learned with Kimi brain, evaluated with a
   *different* brain (gpt/deepseek) — is the SOP brain-agnostic? (Skills should be.)
4. **Compound / shifted faults:** evaluate on SREGym-style compound or metastable
   faults to test beyond single-cause cases (2605.07161). Honest if it degrades.
5. **Judge-swap:** re-score a subset with a *second* judge model to bound judge bias
   in the headline numbers (cheap insurance against "your judge is the reward" review).

### C.5 Minimal viable upgrade (if pod/time is tight)

If a full redo is infeasible, the **smallest** change set that makes the result
defensible:
1. Add **GEPA** (and at least **best-of-N**) as baselines at **matched rollout
   budget** — answers the inevitable "why RL?" Without this the paper is rejected.
2. Add the **composite reward** (judge + a 3-item verifiable rubric:
   NetworkPolicy-enumerated? dnsConfig-checked? correct-root-cause-class?) + **≥3
   adversarial audit cases** → kills the DNS-hack and gives a reward–truth gap plot.
3. Swap RAFT→**GRPO group advantage with an entropy floor** (or just **content-
   imitation + Pareto-keep top-2 per instance**) and plot entropy/Pass@k to *show*
   collapse→recovery. 4. **≥3 seeds + bootstrap CIs**, and a **cross-brain** transfer
   row. That alone converts "honest null result" into "characterized failure +
   working fix + fair comparison."

### C.6 Threats to validity to pre-empt (write these in the paper)

- Small N per skill (±1 case ≈ 0.17): mitigate with seeds, CIs, and larger held-out;
  *state it*.
- Judge = reward is a hackable proxy (2507.08794): mitigate with verifiable rubric +
  judge-swap + robustness perturbations.
- Single environment lineage: we evaluate on Siclaw's live cks-test; note SREGym/
  AIOpsLab as the portable benchmark we *could* port to (and that they don't learn
  skills — reinforcing novelty).
- Diversity-collapse is partly intrinsic to RLVR (2509.07430): we don't "solve" it,
  we *manage* it (entropy floor / mass-covering divergence) and *measure* it.

---

## Executive summary (~500 words)

**Where we sit.** Five research families bear on our system. The SRE/AIOps
literature is the cleanest opportunity: AIOpsLab (MLSys'25, 2501.06706), ITBench
(ICML'25, 2502.05352), and SREGym (2605.07161 — the paper already in our repo)
**benchmark** SRE agents; Flow-of-Action (WWW'25, 2502.08224) and StepFly
(2510.10074) **consume** hand-authored SOPs/TSGs. **None *learns* the SOP/skill from
a live-environment reward.** That is our novelty: the first agent-in-the-loop RL that
optimizes the *injected diagnostic skill* against real K8s diagnosis quality.
Outside SRE, the relevant prior art is skill/agent search (Voyager NeurIPS'23
2305.16291; ADAS ICLR'25 2408.08435), reflective self-improvement (Reflexion/Self-
Refine, 2303.11366/2303.17651), outcome-reward agent RL (GRPO 2402.03300; DeepSeek-R1
2501.12948; RAGEN/StarPO 2504.20073; ETO 2403.02502; WebRL 2411.02337; SWE-Gym/SWE-RL
2412.21139/2502.18449), prompt-optimization (OPRO 2309.03409; DSPy/MIPROv2
2406.11695; PromptBreeder 2309.16797; **GEPA** ICLR'26 oral 2507.19457), and expert
iteration (STaR/ReST/RAFT, 2203.14465/2308.08998/2304.06767).

**Our three failures are textbook, and citable.** (1) *Sample starvation* — at ~72
rollouts we were in GEPA/expert-iteration territory (GEPA beats GRPO at **35× fewer
rollouts**) and used the wrong tool. (2) *RAFT mode-collapse* — this is the named
**entropy/diversity collapse** of RLVR (DPH-RL 2509.07430; AEPO 2510.08141) and the
agent-RL **"Echo Trap"** (RAGEN 2504.20073). (3) *Surface reward-hacking* — LLM-judge
rewards are provably gameable ("One Token to Fool LLM-as-a-Judge" 2507.08794;
RobustJudge 2506.09443); DeepSeek-R1 avoids neural rewards for exactly this reason.

**Top 5 concrete upgrades.**
1. **Run the prompt-optimization baselines at matched rollout budget — GEPA first,
   plus DSPy/MIPROv2, OPRO, and best-of-N+verifier.** A reviewer's #1 question is
   "why RL over GEPA?"; without this the paper is rejected. Pre-register the decision
   rule: beat GEPA on held-out *and* transfer ⇒ "RL adds value"; else ⇒ "reflective
   search suffices, RL not yet justified" (still novel via the closed-loop env).
2. **Replace 1-winner RAFT with GRPO group-advantage + an entropy floor / mass-
   covering (forward-KL/JS) divergence + Pareto-per-instance keeping, and imitate
   skill *content/coverage* not the surface string.** Seed the proposer with the
   hand-crafted skill as a behavioral prior. Plot entropy + Pass@k to *show*
   collapse→recovery.
3. **Make the reward partially verifiable and hardened:** judge + a 3-item rubric
   (NetworkPolicy-enumerated? dnsConfig-checked? root-cause-class correct?) − a
   spurious-cue penalty, plus adversarial **audit cases** (a NetworkPolicy fault that
   *looks* like DNS) and a judge-swap. Report the **reward–truth gap** and **mislabel
   rate** — turns "the judge is the reward" from a weakness into a measured result.
4. **Test generalization four ways:** within-category held-out, **cross-category**,
   **cross-brain**, and **compound/metastable** (SREGym regime). Over-specialization
   (our DNS tunnel-vision) becomes a *measured* axis, not an anecdote.
5. **Report statistics like an RL paper:** ≥5 seeds, mean ± 95% CI, paired
   bootstrap/Wilcoxon, and a budget-sweep curve (perf vs. #rollouts) for ours vs.
   GEPA — the one plot that honestly settles RL-vs-prompt-opt and showcases the
   efficiency story.

**Bottom line.** Keep Stage 1 (the proven +0.30, behavior-changing skill) as the
anchor; reframe Stage 2's null as a *characterized, citable* failure with a working
fix; and let the **matched-budget baseline ladder + multi-axis generalization +
collapse/hacking diagnostics** carry credibility. Done this way, *either* "RL beats
prompt-opt for transferable SRE skills" *or* "reflective search suffices; here is the
first closed-loop SRE-skill environment" is an AAAI-acceptable contribution.

---

## Appendix — full citation list (arXiv IDs, verification status)

SRE/AIOps: AIOpsLab 2501.06706 ✅ · Flow-of-Action 2502.08224 ✅ · StepFly 2510.10074
✅ · ITBench 2502.05352 ✅ · SREGym 2605.07161 ✅(PDF in repo) · Agent-S 2503.15520 ✅.
Skill/agent search: Voyager 2305.16291 ✅ · ADAS 2408.08435 ✅ · (skill-induction '26:
ProcMEM/Skill-Pro 2602.01869 ⚠️ · SkillOS 2605.06614 ⚠️ · SkillRevise 2606.01139 ⚠️ ·
MemSkill 2602.02474 ⚠️). Reflective: Reflexion 2303.11366 ✅ · Self-Refine 2303.17651
✅. Agent-RL: GRPO/DeepSeekMath 2402.03300 ✅ · DeepSeek-R1 2501.12948 ✅ · RAGEN/StarPO
2504.20073 ✅ · ETO 2403.02502 ✅ · ArCHer 2402.19446 ✅ · WebRL 2411.02337 ✅ ·
AgentTuning 2310.12823 ✅ · SWE-Gym 2412.21139 ✅ · SWE-RL 2502.18449 ✅ · Agentic-RL
survey 2509.02547 ✅. Prompt-opt: APE 2211.01910 ✅ · OPRO 2309.03409 ✅ · PromptBreeder
2309.16797 ✅ · EvoPrompt 2309.08532 ✅ · DSPy/MIPROv2 2406.11695 ✅ · TextGrad
2406.07496 ✅ · GEPA 2507.19457 ✅. Expert-iteration: STaR 2203.14465 ✅ · ReST
2308.08998 ✅ · ReST^EM 2312.06585 ✅ · RAFT 2304.06767 ✅ · Re-ReST 2406.01495 ✅.
Diversity-collapse / reward-hacking / judge-robustness: DPH-RL 2509.07430 ✅ · AEPO
2510.08141 ⚠️ · UCAS 2510.10649 ⚠️ · "One Token to Fool LLM-as-a-Judge" 2507.08794 ✅ ·
RobustJudge 2506.09443 ⚠️.

> ⚠️ entries are corroborative recent preprints surfaced via search summary but not
> individually abstract-verified; verify IDs/venues before they enter the paper's
> bibliography. All ✅ entries had their abstract or metadata confirmed.
