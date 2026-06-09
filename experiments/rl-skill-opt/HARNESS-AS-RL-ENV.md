# Can Siclaw's Harness Be an RL Environment? — Feasibility & Architecture

> **Q2 design study.** Can Siclaw's agent harness (the real agent loop: tools, skills,
> guards, swappable LLM brain) be turned into a proper RL environment/gym for training,
> and what architecture do we recommend?
>
> Scope: code reading + web research only (no scitix/MaaS calls). Companion to
> `RELATED-WORK-AND-PLAN.md` and `reward.mjs`/`orchestrate_v2.mjs`. Citation hygiene
> matches that doc: ✅ = abstract/repo/source-line verified during this study;
> ⚠️ = surfaced via search summary, **verify before citing in the paper**.

---

## TL;DR

**Yes — and there are two distinct ways to do it, which we must not conflate.**

1. **Harness-as-reward-oracle** (what we already do). The harness is a black-box
   function `skill_text → scalar reward`. The *policy being trained* is a **separate
   local model** (the Qwen2.5-3B skill-proposer; gradients flow there via LoRA in
   `update_v2.py`). The agent brain inside the harness is a **frozen API model**. This
   already works end-to-end and needs **no gradients through the harness**.

2. **Harness-as-full-RL-env** (new, for training the *brain/policy* itself). Treat each
   agent turn as `state → action → observation`, train the **brain** with policy RL
   (GRPO/PPO). This requires (a) a **local trainable brain** (API models give no
   gradients), and (b) a thin env API. The 2025–26 consensus pattern makes this cheap:
   **keep the harness unchanged and intercept at the OpenAI-compatible LLM-API
   boundary** (Agent-Lightning, Polar). Because Siclaw's brain is *already* an
   `openai-completions` provider selected by a `baseUrl` in `settings.json`, swapping
   that URL to a policy-serving proxy is a **near-zero-code change**.

**Recommended architecture:** adopt the **proxy-at-the-LLM-boundary** pattern (don't
rewrite the agent as a gym). Concretely: a thin **OpenEnv-style `reset/step/reward`
server** wrapping `createSiclawSession`, fed by an **Agent-Lightning-style trajectory
proxy** so we can later attach **verl/SkyRL/TRL-GRPO** as the trainer when (and only
when) we want to train a local brain. Until then, our current skill-search RL is the
right tool and needs no brain training at all.

---

## Part 1 — Siclaw's harness assessed as an RL env (from the code)

### 1.1 What the harness gives RL for free (already present)

The current rollout entry point is
`experiments/siclaw-agent-eval/eval-harness.mjs`, which drives
`createSiclawSession()` (`src/core/agent-factory.ts`) → `PiAgentBrain`
(`src/core/brains/pi-agent-brain.ts`, the policy) → `BrainSession`
(`src/core/brain-session.ts`, the interface). Mapping these to RL primitives:

| RL primitive | Where it already lives | Notes |
|---|---|---|
| **Episode rollout** | `brain.prompt(prompt)` runs the full multi-turn agent loop to completion; `eval-harness.mjs` wraps one case = one episode. | Synchronous, run-to-completion. Timeout + `brain.abort()` bound it. |
| **Trajectory capture** (states/actions/obs/messages) | `brain.subscribe(event => …)` streams `tool_execution_start/end` (=action + observation), `message_end` (assistant text), `agent_start/turn_start/…`. `eval-harness.mjs` records `events`, `toolCalls`, `assistantMessages`, `finalText`. | This is a **token-faithful-ish event trace already**, exactly what RL trainers reconstruct trajectories from. Missing: per-token logprobs (see 1.2). |
| **Reward hookup** | `reward.mjs` spawns the harness per case, then runs the **real LLM judge** (`experiments/aaai-paper/judge-llm.mjs`) + the **composite verifiable reward** (`composite-reward.mjs`) → scalar (+ per-case + advantage vs baseline). | A working outcome reward with verifiable rubric + spurious-cue penalty + audit cases. This is our env's reward function. |
| **Swappable policy** | `BrainSession` interface + `setModel()`/`registerProvider()`; brain is any `openai-completions`/`anthropic` provider via `settings.json` (`getDefaultLlm()` reads `baseUrl`+`apiKey`). | The policy is **swappable by config** — the single most important property for plugging a different (local) policy later. |
| **Tools / action space (de-facto)** | `ToolRegistry.resolve()` in `agent-factory.ts`; read-only kubectl + restricted-bash + file tools + memory + MCP. Guard pipeline (`installGuardPipeline`) sanitizes I/O. | A **fixed, validated, security-hardened tool set** = a clean, safe action space. Guards/skills stay intact regardless of policy. |
| **Skill / prompt injection hook** | `eval-harness.mjs --skill-file` → `systemPromptAppend` → `createSiclawSession({ systemPromptAppend })` → appended in `appendSystemPromptOverride`. | This is the **action channel for skill-search RL** (our current experiment): the proposer's output is injected here. |
| **Per-rollout accounting** | `brain.getSessionStats()` → tokens/cost; harness records duration, statuses. | Lets us report matched-budget rollouts and token spend (already in `reward.json`). |

**Verdict:** the harness is **already a usable black-box environment** — `prompt()` is
"run episode," `subscribe()` is "observe trajectory," `reward.mjs` is "reward." This is
why our skill-search RL works. What it is *not* yet is a *gym for training the brain*.

### 1.2 What is MISSING for a clean RL gym (and the effort to add it)

Ordered by how much each blocks brain/policy-RL specifically.

| Missing piece | Why RL wants it | Effort | Notes / where it goes |
|---|---|---|---|
| **A local trainable brain** (gradients) | **The blocker.** Our brain is a remote API model (scitix gpt-5.4 / Kimi). API inference returns text, **not gradients or token logprobs** — you cannot do policy-gradient on it. Policy-RL *requires* a local model served by vLLM/SGLang. | **M** (infra, not Siclaw code) | Stand up vLLM/SGLang OpenAI server for a local model (e.g. Qwen-7/14B); point Siclaw's `baseUrl` at it. Siclaw core unchanged. |
| **`reset()/step()/reward()` env API** | Trainers (TRL `environment_factory`, SkyRL `BaseTextEnv`, OpenEnv) expect a stepwise contract; our harness is run-to-completion only. | **S–M** | Two options: (a) **episode-level** env (`reset`=new case+session, `step`=`prompt()`, `reward`=judge) — trivial, fits GRPO/outcome reward; (b) **turn-level** env (intercept each `tool_execution`) — needed only for per-step/PRM rewards. Start with (a). |
| **Per-token logprobs / token-faithful trajectory** | Importance sampling / PPO ratios need the *behavior policy's* token logprobs at generation time; the event stream has text, not token ids+logprobs. | **S** (if proxy) / **L** (if via pi-agent) | The **proxy pattern solves this for free**: Polar/Agent-Lightning record prompts, sampled token ids, and logprobs *at the OpenAI API boundary*, so we never touch pi-agent internals. (Polar ✅, A-L `LlmProxyTraceToTriplet` ✅.) |
| **Batched / parallel async rollouts** | RL needs many rollouts/step; `reward.mjs` already pools (`CONCURRENCY`) but each rollout is a **separate `node` subprocess** booting a fresh session — heavyweight. | **M** | For throughput: run N in-process `createSiclawSession` instances (LocalSpawner-style) **or** keep subprocess isolation and scale horizontally (Polar "runtime pooling"). Subprocess isolation is actually a *feature* for a security agent — matches SkyRL/OpenHands remote-sandbox model. |
| **Deterministic seeding** | Reproducibility + variance reduction. Today: live cluster + API sampling temperature = **two nondeterminism sources**. | **M–L** | Brain temperature/seed: controllable once local (vLLM `seed`). **Cluster state is genuinely stochastic** (live cks-test) — this is inherent to the "expensive live env" regime we sell; mitigate via fixed case fixtures / snapshotting, not full determinism. |
| **Action/observation space definition** | A formal `ActionSpace`/`ObservationSpace` (tool schema as action grammar; tool output as obs). | **S** | Already *implicit* in `ToolRegistry` + tool JSON schemas; just needs to be *exposed/declared* for the env wrapper. Low effort because tools are already declarative. |
| **Advantage / return computation** | GRPO group-advantage, GAE, etc. | **S (reuse)** | We already compute **group advantage + Pareto-keep in `update_v2.py`** for the proposer; the same module applies to brain trajectories. Trainers (verl/TRL/OpenRLHF) ship these built-in. |
| **Reward shaped as RL signal at the right granularity** | Outcome-only is fine for GRPO; PRM/turn-level needs per-step credit. | **S–M** | `composite-reward.mjs` is outcome-level today. Process reward (e.g. "enumerated NetworkPolicies before concluding") is sketched in `RELATED-WORK-AND-PLAN.md` C.3 and maps to turn-level `step()` rewards if we go turn-level. |

**Effort legend:** S ≈ <1 day, M ≈ days, L ≈ week+. **The only true blocker is the local
brain;** everything else is small-to-medium glue, and the proxy pattern collapses the
two hardest items (logprobs, env API) into "point `baseUrl` at a proxy."

### 1.3 The crucial distinction (ties to our current experiment)

```
                      ┌──────────────────────────────────────────────┐
  OURS TODAY:         │  Skill-Proposer (LOCAL Qwen-3B)  ── TRAINED ──┼─► gradients (LoRA, update_v2.py)
  harness as REWARD   │        │ emits skill_text                      │
  ORACLE              │        ▼                                       │
                      │  Siclaw harness  (brain = FROZEN API model) ──►│ scalar reward (judge+composite)
                      └──────────────────────────────────────────────┘
                         the harness is a black box; no grad through it

                      ┌──────────────────────────────────────────────┐
  FULL RL ENV:        │  Siclaw harness  (brain = LOCAL model) ── TRAINED ─► gradients (GRPO/PPO)
  harness as          │   reset()/step()/reward()  +  logprob proxy   │
  GYM                 └──────────────────────────────────────────────┘
                         the BRAIN is the policy; needs a local model
```

Our v2 experiment is **row 1**: the harness is a *reward oracle* for **skill-search RL**;
the trainable policy is the external proposer, not the agent. That is why it runs fine
on an **API brain** — we never need gradients through Siclaw. **Row 2 (training the
brain) is the only thing that needs the new env API + a local brain.** Both are
legitimate "Siclaw as RL environment"; the paper should state which it means.

---

## Part 2 — How others wrap agent frameworks as RL envs (survey)

Four dominant patterns have crystallized in 2025–26. Pattern (iv) is the one the field
is converging on for *real* agent harnesses.

### (i) Env-server + external trainer (decoupled, framework-owned env API)

The trainer and the environment run as separate services; the env exposes a standard
interface the trainer calls.

- **OpenEnv** (Meta PyTorch × Hugging Face, 2025) ✅ — the emerging **standard**:
  Gymnasium-style **`reset()` / `step()` / `state()`**, environments run as **FastAPI
  servers in Docker**, clients talk **type-safe HTTP**. Consumed natively by
  **torchforge**, and integrated by **TRL, SkyRL, Unsloth**. Ships echo/coding/Atari/
  OpenSpiel + wraps BrowserGym (WebArena/WorkArena). *This is the interface to target.*
  Repo: <https://github.com/meta-pytorch/OpenEnv>; RFC spec:
  <https://github.com/meta-pytorch/OpenEnv/blob/main/rfcs/002-env-spec.md>; blog:
  <https://huggingface.co/blog/openenv>.
- **SkyRL / SkyRL-Agent** (Berkeley Sky Computing, arXiv:2511.16108 ✅) — modular
  **async rollout orchestration** for multi-turn long-horizon agents; tool-centric task
  interface, **fine-grained async dispatcher**, backend bridge to verl/Tinker.
  `SkyRL-Gym` exposes `BaseTextEnv` and adapts OpenEnv envs. SA-SWE-32B hits 39.4%
  SWE-Bench Verified. Remote-sandbox server decouples training from env (K8s-scalable).
  <https://arxiv.org/abs/2511.16108>, <https://skyrl.readthedocs.io>.
- **TRL GRPOTrainer + OpenEnv** (Hugging Face) ✅ — `environment_factory=` arg makes
  GRPOTrainer run the multi-turn tool-calling loop against an OpenEnv env; vLLM
  colocate/server modes. **Caveat (verify):** open bug
  [trl#4543](https://github.com/huggingface/trl/issues/4543) — server-mode GRPO
  mishandles **per-step prefixes** of multi-step trajectories, breaking importance
  sampling; single-step rollouts are fine. <https://huggingface.co/docs/trl/main/en/openenv>.
- **verl / HybridFlow** (ByteDance Seed × HKU, EuroSys'25, arXiv:2409.19256 ✅) — the
  production RL backend: **hybrid single+multi-controller** dataflow; FSDP/Megatron
  train, vLLM/SGLang rollout; PPO/GRPO/GSPO/DAPO/RLOO + verifiable rewards. The trainer
  most others (Agent-Lightning, SkyRL, RAGEN) plug *into*. <https://github.com/verl-project/verl>.
- **OpenRLHF** (arXiv:2405.11143 family) ✅ — **Ray + vLLM** distributed RLHF; decouples
  algorithm from agent execution via `AgentInstanceBase`/`AgentExecutorBase`; **async
  agentic RL** with a local **OpenAI-compatible agent server**
  (`OPENRLHF_ASYNC_NUM_TASKS`, `OPENRLHF_ASYNC_QUEUE_SIZE` for off-policy degree).
  <https://github.com/OpenRLHF/OpenRLHF>.

### (ii) Trajectory-replay / offline RL from logged rollouts

Train on *previously logged* agent trajectories rather than live stepping.

- **SWE-Gym** (ICML'25 ✅) — 2.4k executable SWE tasks + tests; **rejection-sampling
  fine-tuning** on sampled trajectories (+14% SWE-Bench Verified at 32B) and a **learned
  verifier for best-of-N** at inference. The canonical "log trajectories → filter by
  verifiable reward → SFT" loop (= our ReST/RAFT row).
  <https://github.com/SWE-Gym/SWE-Gym>.
- **ETO** (ACL'24, arXiv:2403.02502 ✅) — DPO on contrastive **success/fail trajectory
  pairs** (learn from failures, not just winners) — offline, replay-based.
- This is exactly the regime our **logged traces** (`reward.mjs` writes full
  `result.json` per rollout) already support: we could do offline RL on them without
  any new stepping API.

### (iii) Async distributed rollouts (throughput-first)

Decouple slow rollouts from GPU training so generators and trainers run concurrently.

- **OpenRLHF async** + **SkyRL async dispatcher** (1.55× over naïve async batching) +
  **verl** phase-switching. **RollArt** (arXiv:2512.22560 ⚠️) and **ProRL-Agent /
  Rollout-as-a-Service** (arXiv:2603.18815 ⚠️) push "rollout as a scalable service."
  Relevant because our rollouts are **30–90 s live-cluster investigations** — the
  expensive-rollout regime where async + caching dominate wall-clock.

### (iv) "Agent stays as-is, RL wraps it" — proxy at the LLM-API boundary ★

**The pattern that fits Siclaw.** Instead of rewriting the agent behind a framework env
API, leave the harness untouched and **intercept its model calls**; reconstruct
trajectories from what flows through the proxy.

- **Agent-Lightning** (Microsoft Research, arXiv:2508.03680 ✅) — **Training-Agent
  Disaggregation**: agent (CPU, client) and trainer (GPU, e.g. verl) are mutually
  agnostic. The dev subclasses **`LitAgent`** and implements **`rollout()` /
  `training_rollout()`**, returning a **float reward** (or `None` + **`emit_reward()`**).
  The agent's OpenAI client points `base_url` at a **proxy** (`llm.get_base_url(rollout_id,
  attempt_id)`); a FastAPI middleware injects `x-rollout-id` headers and a LiteLLM
  callback captures **token ids + logprobs**; **`LlmProxyTraceToTriplet`** turns the flat
  proxy spans into `(state, action, reward)` triplets. **`LightningRL`** does hierarchical
  **credit assignment** over arbitrary agent trajectories (formalized as an MDP).
  *Near-zero code change.* <https://arxiv.org/abs/2508.03680>,
  <https://github.com/microsoft/agent-lightning>,
  <https://microsoft.github.io/agent-lightning/>.
- **Polar: Agentic RL on Any Harness at Scale** (NVIDIA, arXiv:2605.24220 ✅) — same
  philosophy, scale-first: **"treat the agent harness as a black box; proxy LLM API
  calls, record token-level interactions, reconstruct token-faithful trajectories."**
  Explicitly argues *against* rewriting the harness behind a framework env API (it
  "loses important training signals" and couples the trainer to harness-specific code).
  "Harness as Environment / Rollout as a Service." Repo (NeMo):
  <https://github.com/NVIDIA-NeMo/ProRL-Agent-Server>; companion
  *From Model Scaling to System Scaling: Scaling the Harness in Agentic AI*
  (arXiv:2605.26112 ⚠️). <https://arxiv.org/abs/2605.24220>.
- **OpenPipe ART** (Agent Reinforcement Trainer) ✅ — **client/server**: your code runs
  the agentic workflow (parallel rollouts), an OpenAI-compatible client routes
  completions to the ART server (latest LoRA in vLLM), each message is stored in a
  **`Trajectory`**, and you assign a reward when it finishes. **RULER** = LLM-as-judge
  **relative** reward over a group of trajectories (no handcrafted reward) — *directly
  analogous to our judge reward*, and a baseline we can cite. <https://github.com/OpenPipe/ART>.

### Cross-cutting RL-method context (our diagnostics already align)

- **RAGEN / StarPO(-S)** (arXiv:2504.20073 ✅) — full multi-turn trajectory-RL system;
  names the **"Echo Trap"** (reward-variance cliff + entropy collapse + gradient spikes)
  = our mode-collapse, fixed by uncertainty-based trajectory filtering. 10 built-in
  envs. <https://github.com/mll-lab-nu/RAGEN>.
- **GRPO** (DeepSeekMath, arXiv:2402.03300 ✅) — critic-free group advantage; **the
  update rule** every framework above defaults to and the one our proposer already uses.
- **τ²-bench** (Sierra, arXiv:2406.12045 ✅) ships an optional **Gymnasium RL interface**
  (`uv sync --extra gym`); **AppWorld / WebArena** are wrapped for RL by **AgentGym-RL**
  (arXiv:2509.08755 ⚠️) and BrowserGym/OpenEnv. Evidence that **wrapping a tool-agent
  benchmark as a stepping env is now routine** — which is what we'd do for cks-test cases.

**Dominant-pattern synthesis:** the field has split into **(a) standardize the env**
(OpenEnv `reset/step/state` + SkyRL/TRL consumers) and **(b) don't touch the agent,
proxy its LLM calls** (Agent-Lightning, Polar, ART). For a *complex, security-hardened,
already-built* harness like Siclaw, **(b) is strictly easier and loses fewer signals** —
and it is explicitly the lesson of the newest (2026) work (Polar).

---

## Part 3 — Recommendation for Siclaw

### 3.1 Architecture: proxy-at-the-boundary, with a thin OpenEnv-shaped wrapper

**Do not rewrite the agent as a gym.** Adopt the Agent-Lightning/Polar pattern and add a
*thin* env shim:

```
┌─ Trainer (GPU) ─────────────┐        ┌─ Rollout service (CPU, N workers) ───────────┐
│ verl / SkyRL / TRL-GRPO     │  HTTP  │ SiclawEnv.reset(case)  → new createSiclawSession│
│  · GRPO group advantage     │◄──────►│ SiclawEnv.step(prompt) → brain.prompt() (1 episode)
│  · serves policy via vLLM   │        │ SiclawEnv.reward()     → judge + composite      │
│    OpenAI-compatible server │        │ trajectory  ← brain.subscribe() events +        │
└────────────▲────────────────┘        │               LLM-proxy token logprobs          │
             │ base_url + token logprobs└───────────────────────────────────────────────┘
             └──────── Siclaw brain points settings.json baseUrl here ───────────────────
```

- **Env API (new, small):** wrap `createSiclawSession` in a `SiclawEnv` exposing
  `reset(case_id) / step(prompt) / reward() / state()` (OpenEnv-shaped, so TRL/SkyRL can
  consume it directly). **Start episode-level** (`step` = one full `brain.prompt()`,
  outcome reward) — this matches GRPO and needs almost no new code beyond
  `eval-harness.mjs`. Promote to turn-level only if we need process/PRM rewards.
- **Policy plug-in (the key enabler, near-zero Siclaw code):** the brain is chosen by
  `settings.json` `{ baseUrl, apiKey, api:"openai-completions" }` (`getDefaultLlm()`).
  To train a **local** brain, **point `baseUrl` at a vLLM/SGLang server (or the
  Agent-Lightning/ART proxy) serving the policy-under-training.** Tools, guards, skills,
  memory, MCP all stay byte-identical — they live below the brain and don't care where
  tokens come from. *This is why Siclaw is unusually well-suited to pattern (iv).*
- **Logprobs/trajectory:** get them from the **proxy** (Polar/A-L
  `LlmProxyTraceToTriplet`), not from pi-agent internals — keeps us decoupled from the
  upstream framework and avoids touching `src/core`.
- **Reward:** reuse `composite-reward.mjs` + `judge-llm.mjs` verbatim as the env's
  `reward()`. (It is already an LLM-judge-relative reward, conceptually = ART's RULER.)
- **Parallelism:** keep per-rollout **subprocess isolation** (security win for an SRE
  agent; mirrors SkyRL/OpenHands remote sandbox) and scale horizontally à la Polar
  "runtime pooling"; or run in-process N sessions for cheaper local-model rollouts.

### 3.2 Which framework

| Goal | Pick | Why |
|---|---|---|
| **Train a local brain now, least integration** | **Agent-Lightning** (proxy) → **verl** trainer | Literal "any agent, ~zero code change"; our brain is already an OpenAI client → just swap `base_url`. verl is the proven GRPO backend underneath. |
| **Scale rollouts / "harness as env" at scale** | **Polar** (NVIDIA NeMo) | Purpose-built to make an arbitrary harness an RL env by proxying LLM calls; async rollout-as-a-service; the 2026 reference for our exact problem. |
| **Tightest agentic-RL loop, multi-turn first-class** | **SkyRL-Agent** (+ OpenEnv shim) | Async dispatcher, K8s-native remote sandboxes — matches our live-cluster, long-rollout regime. |
| **Thin/custom, stay in our stack** | **Custom `SiclawEnv` (OpenEnv-shaped) + reuse `update_v2.py` GRPO** | We *already* have group-advantage + Pareto-keep + entropy floor in Python; an episode-level env + local vLLM brain is a few hundred LOC. Good if we want full control and minimal deps. |

**Recommendation:** for the **paper's current claim**, change nothing — keep
**harness-as-reward-oracle** with the external proposer (no brain training needed). For a
**future brain-RL extension**, prototype with **Agent-Lightning's proxy → verl**, because
it exploits Siclaw's `baseUrl`-swappable brain for ~zero core changes; graduate to
**Polar/SkyRL** only if rollout scale demands it.

### 3.3 How this connects to our CURRENT experiment

- **What we have is legitimately "Siclaw as an RL environment"** — specifically as a
  **black-box reward oracle for skill-search RL**. The harness is the env; the **reward**
  is real (live diagnosis + judge); the **policy** is the local skill-proposer (gradients
  via `update_v2.py`). Nothing about Q2 invalidates it.
- **The key blocker, stated plainly:** *our agent brain is an API model, so no gradients
  flow through the agent.* **Full policy-RL (training the brain) needs a local brain;
  skill-search RL (what we do) does not.** That single sentence is the honest scope line
  for the paper.
- **Cheapest credible upgrade toward "full RL env"** (if a reviewer pushes "but is the
  *agent* learning?"): stand up one local brain (Qwen-7/14B via vLLM), point Siclaw's
  `baseUrl` at it, wrap an **episode-level `SiclawEnv.reset/step/reward`**, and run
  **GRPO via Agent-Lightning→verl** on a handful of cases — a proof-of-concept that the
  *same harness* trains a brain, not just searches skills. Effort: **M** (mostly infra),
  because the env shim is thin and the brain swap is config-only.

### 3.4 Effort estimate (to reach a brain-trainable gym)

| Component | Effort | Blocker? |
|---|---|---|
| Local brain served by vLLM/SGLang (OpenAI-compatible) | **M** (infra) | **Yes — the one true blocker** |
| `settings.json` `baseUrl` → local/proxy endpoint | **S (config)** | No (already supported) |
| `SiclawEnv.reset/step/reward` (episode-level, OpenEnv-shaped) | **S–M** | No |
| Token-faithful trajectory + logprobs (via proxy) | **S** (Agent-Lightning/Polar) | No |
| Advantage/return + GRPO update | **S (reuse `update_v2.py`)** or built-in (verl/TRL) | No |
| Parallel/async rollout scaling | **M** | No (works serially first) |
| Determinism (brain seed easy; **live-cluster stochasticity inherent**) | **M–L** | Partial — manage, don't eliminate |

**Bottom line.** Siclaw's harness is *already* a working RL environment in the
reward-oracle sense (and that is what the paper uses). Turning it into a **full
brain-training gym** is **not blocked by Siclaw's design** — its `baseUrl`-swappable
OpenAI-compatible brain makes it an almost-ideal fit for the 2025–26 "proxy the LLM
boundary, leave the harness alone" pattern (Agent-Lightning/Polar). The **only hard
prerequisite is a local trainable brain**; the env API, logprobs, and advantage math are
all small glue or reuse. Recommended path: **thin OpenEnv-shaped `SiclawEnv` +
Agent-Lightning proxy → verl/SkyRL**, adopted *only if* we choose to extend from
skill-search RL to brain/policy RL.

---

## Sources (primary)

Frameworks / patterns:
- Agent-Lightning — arXiv:2508.03680 ✅ · <https://github.com/microsoft/agent-lightning> · docs <https://microsoft.github.io/agent-lightning/>
- Polar: Agentic RL on Any Harness at Scale — arXiv:2605.24220 ✅ · <https://github.com/NVIDIA-NeMo/ProRL-Agent-Server>
- OpenEnv (Meta PyTorch × HF) — <https://github.com/meta-pytorch/OpenEnv> · RFC <https://github.com/meta-pytorch/OpenEnv/blob/main/rfcs/002-env-spec.md> · <https://huggingface.co/blog/openenv>
- verl / HybridFlow — arXiv:2409.19256 ✅ (EuroSys'25) · <https://github.com/verl-project/verl>
- OpenRLHF — <https://github.com/OpenRLHF/OpenRLHF>
- SkyRL-Agent — arXiv:2511.16108 ✅ · <https://skyrl.readthedocs.io>
- OpenPipe ART + RULER — <https://github.com/OpenPipe/ART> · <https://wandb.ai/site/ruler/>
- TRL GRPO + OpenEnv — <https://huggingface.co/docs/trl/main/en/openenv> · bug ⚠️ <https://github.com/huggingface/trl/issues/4543>
- RAGEN / StarPO — arXiv:2504.20073 ✅ · <https://github.com/mll-lab-nu/RAGEN>
- GRPO (DeepSeekMath) — arXiv:2402.03300 ✅
- SWE-Gym — ICML'25 ✅ · <https://github.com/SWE-Gym/SWE-Gym>
- ETO — arXiv:2403.02502 ✅
- τ²-bench (Gym extra) — arXiv:2406.12045 ✅ · <https://github.com/sierra-research/tau2-bench>
- AgentGym-RL — arXiv:2509.08755 ⚠️ · RollArt arXiv:2512.22560 ⚠️ · ProRL-Agent arXiv:2603.18815 ⚠️ · "Scaling the Harness" arXiv:2605.26112 ⚠️

Siclaw code (this repo, verified by reading):
- `experiments/siclaw-agent-eval/eval-harness.mjs` (rollout + `--skill-file` systemPromptAppend + event capture + static broker)
- `src/core/agent-factory.ts` (`createSiclawSession`, `systemPromptAppend`, tool registry, guard pipeline, `settings.json` `baseUrl` brain selection)
- `src/core/brains/pi-agent-brain.ts` + `src/core/brain-session.ts` (the policy + its swappable interface)
- `experiments/rl-skill-opt/reward.mjs`, `composite-reward.mjs`, `orchestrate_v2.mjs`, `update_v2.py` (harness-as-reward-oracle; local proposer GRPO)
- `src/core/config.ts` (`getDefaultLlm()` → `{ baseUrl, apiKey, api }`)

> ⚠️ entries are search-surfaced and **not abstract-verified** in this study — confirm
> arXiv id/venue before citing in the paper. All ✅ entries had their abstract, repo
> README, or source line confirmed during this study.
