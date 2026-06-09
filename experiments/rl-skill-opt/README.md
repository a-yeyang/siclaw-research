# RL Skill Optimization — agent-in-the-loop skill search for Siclaw

> **This replaces an earlier, discarded approach.** The first attempt built a
> *static text dataset* and rewarded a local model with *keyword matching*. The
> real Siclaw agent never ran, scitix/MaaS token usage stayed flat, and reward
> was flat. That defeated the purpose and was thrown away. The architecture
> below is the corrected, real one: **Siclaw actually runs every rollout**, and
> the reward is a **real LLM judge** scoring Siclaw's **real** diagnosis of a
> **live** cluster.

We learn a **skill-proposer policy**: a local LLM (on H100s) that writes a
focused diagnostic SOP ("skill"). A skill is judged purely by whether injecting
it into the real Siclaw agent **raises Siclaw's real diagnosis score** on a
weak fault category. The proposer is the *policy*; the real Siclaw agent + real
judge is the (slow) *environment*.

```
            ┌─────────────────────── H100 pod (rl-skill-trainer) ───────────────────────┐
            │  proposer policy  πθ  =  Qwen2.5-3B-Instruct + LoRA                          │
            │     prompt: "category + 1–2 example incidents (NO ground truth)"            │
            │     → generates K candidate skills (focused SOPs)                            │
            └───────────────┬───────────────────────────────────▲───────────────────────┘
        kubectl cp skills   │                                    │  kubectl exec: REINFORCE/RAFT
                            ▼                                    │  update on (skill, reward)
   ┌──────────────────────────── LOCAL (this repo) ─────────────┴───────────────────────┐
   │  reward.mjs:                                                                          │
   │    for each candidate skill, for N cases of the category:                            │
   │      eval-harness.mjs  --skill-file <skill>   →  REAL Siclaw agent                    │
   │         · scitix model brain (kimi/gpt/…)  ← MaaS tokens flow = proof it ran          │
   │         · investigates the LIVE cks-test cluster with its real tools/skills           │
   │      judge-llm.mjs (scitix Claude)  →  REAL per-dimension judge score                 │
   │    reward = mean judge total ;  advantage = reward − no-skill baseline                │
   └──────────────────────────────────────────────────────────────────────────────────────┘
```

The proof Siclaw genuinely runs in the loop is the **MaaS token usage** logged
per rollout (`stats.tokens` from `getSessionStats`) and the real **tool calls**
against the live cluster — both reported in every `reward.json`.

---

## Files

| File | Purpose |
|---|---|
| `reward.mjs` | **The real reward.** Runs the real Siclaw agent (scitix brain) on a case set with a skill injected, then the real LLM judge; returns mean score + advantage + token proof. |
| `skills/network-dns-handcrafted.txt` | Hand-written demo skill used to validate the environment (Stage 1). |
| `proposer.py` | On-pod: load Qwen2.5-3B (+ optional LoRA adapter), generate K candidate skills for a category, write them to a JSON file. |
| `update.py` | On-pod: RAFT/REINFORCE LoRA update on (skill, reward) pairs; persists the adapter. |
| `orchestrate.mjs` | The RL loop: per round — `kubectl exec proposer.py` → score each skill with `reward.mjs` locally → `kubectl exec update.py`. Tracks reward per round. |
| `RESULTS.md` | Honest results: real reward trajectory, before/after held-out judge scores, token/rollout evidence, limitations. |
| `results/` | Per-run trace + judge + `reward.json` outputs. |

The harness change lives in `experiments/siclaw-agent-eval/eval-harness.mjs`:
a `--skill-file <path>` flag that reads the file and passes its text as
`systemPromptAppend` to `createSiclawSession` (hook confirmed at
`src/core/agent-factory.ts` lines 603–608). The real agent then has the proposed
skill in context while it diagnoses.

---

## The real reward (`reward.mjs`)

```bash
# no-skill baseline on a weak category (writes results/<run>/judgments.json)
node experiments/rl-skill-opt/reward.mjs \
  --cases c068,c069,c070,c071,c072,c073 --provider kimi \
  --run-dir experiments/rl-skill-opt/results/baseline_netdns6

# with a candidate skill, advantage vs that baseline
node experiments/rl-skill-opt/reward.mjs \
  --cases c068,c069,c070,c071,c072,c073 --provider kimi \
  --skill-file experiments/rl-skill-opt/skills/<candidate>.txt \
  --baseline-judge experiments/rl-skill-opt/results/baseline_netdns6/judgments.json \
  --run-dir experiments/rl-skill-opt/results/<run>
```

`reward.mjs` prints a compact JSON last line `{reward, advantage, passRate,
tokensTotal, completed, runDir}` and writes the full `reward.json`. The brain is
selected by `--provider` (a dir under `experiments/aaai-paper/providers/`, each
holding a `.siclaw/config/settings.json`); `reward.mjs` sets `SICLAW_CONFIG_DIR`
to it. **kimi (`moonshotai/Kimi-K2.5`) is proven end-to-end** and recommended;
`gpt`/`qwen`/`deepseek` also work. The judge is scitix Claude
(`--judge-model claude-sonnet-4-6`). Claude does *not* work as the agent brain
via scitix — only as the judge.

> Real rollouts are SLOW (~30–90 s each, judge adds a few seconds). This is
> **sample-efficient policy search**, not large-scale gradient RL. Keep groups
> (K) and case sets (N) small.

---

## Stage 2 — H100 skill-proposer RL (the policy)

All GPU steps run inside the pre-provisioned pod via
`kubectl -n siclaw-rl-yye exec rl-skill-trainer -- …`. **Create no new GPU
pods; delete nothing.** Model `Qwen/Qwen2.5-3B-Instruct` is already cached at
`/workspace/hf` (`HF_HOME=/workspace/hf`).

Loop (`orchestrate.mjs`), small by design:

1. `proposer.py` generates K candidate skills for the target category from a
   prompt containing the category + 1–2 example *incident symptoms* (NO ground
   truth).
2. `reward.mjs` scores each candidate (real Siclaw + real judge, N cases).
3. `update.py` does a **RAFT/ReST** SFT step (LoRA) on the top-reward skills (or
   REINFORCE on (skill, reward)); the adapter is persisted in the pod and
   reloaded next round.
4. Repeat for a few rounds.

Validation: the best learned skill vs the no-skill baseline on a **held-out**
set of the category's cases, scored by the real judge. Honest before/after
(pass% + mean) is in `RESULTS.md`.

---

## Reproduce

```bash
# 0) confirm pod + GPUs + cached model
kubectl -n siclaw-rl-yye get pod rl-skill-trainer
kubectl -n siclaw-rl-yye exec rl-skill-trainer -- nvidia-smi -L
kubectl -n siclaw-rl-yye exec rl-skill-trainer -- ls /workspace/hf/models--Qwen--Qwen2.5-3B-Instruct

# 1) build dist so the harness can import createSiclawSession
npm run build            # (already built: dist/core/agent-factory.js)

# 2) establish the no-skill baseline (real agent + real judge)
node experiments/rl-skill-opt/reward.mjs --category network-dns --n 6 \
  --provider kimi --run-dir experiments/rl-skill-opt/results/baseline_netdns6

# 3) run the proposer RL loop (copies proposer.py/update.py into the pod itself)
node experiments/rl-skill-opt/orchestrate.mjs \
  --category network-dns \
  --train-cases c068,c069,c070,c071,c072,c073 \
  --rounds 3 --k 4 --provider kimi \
  --baseline-judge experiments/rl-skill-opt/results/baseline_netdns6/judgments.json

# 4) held-out validation: best skill vs no-skill on cases NOT used in training
node experiments/rl-skill-opt/reward.mjs --cases c074,c075,c076,c077 --provider kimi \
  --run-dir experiments/rl-skill-opt/results/heldout_baseline
node experiments/rl-skill-opt/reward.mjs --cases c074,c075,c076,c077 --provider kimi \
  --skill-file <best skill from the run> \
  --baseline-judge experiments/rl-skill-opt/results/heldout_baseline/judgments.json \
  --run-dir experiments/rl-skill-opt/results/heldout_best
```

The MUST node runtime is **node v24** (the `codex-primary-runtime` node binary,
auto-selected by `reward.mjs`/`orchestrate.mjs`); the repo requires Node ≥22.12
and the harness uses `node:sqlite`.
