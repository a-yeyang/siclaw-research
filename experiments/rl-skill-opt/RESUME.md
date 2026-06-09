# RESUME — pick up here (updated 2026-06-06)

Branch: `research/rl-skill-opt`. All work committed.

## ✅ Q1 ANSWERED this session (the core question)
**"Does RL optimize Siclaw's skills, or does reflective search (GEPA) suffice?"**
→ **Reflective search (GEPA) suffices; RL not yet justified on in-distribution
accuracy.** Pre-registered rule (GRPO ≥ GEPA on held-out AND cross-brain) **FAILS on
held-out**: GEPA **1.458 [1.38,1.50]** vs GRPO-ours **1.183 [1.03,1.33]** (Δ −0.275,
GEPA CI entirely above GRPO mean). BUT GRPO-ours **wins cross-brain** (1.167 vs 0.90)
and **audit** (1.252 vs 0.978) with lower mislabel — the honest, nuanced result:
*GEPA peak-fits in-distribution, RL transfers more robustly.* Full table + verdict +
diagnostics + budget in **`RESULTS-v2.md` §2–5**; machine-readable in
`results-v2/ANALYSIS.json` (regen: `node experiments/rl-skill-opt/analyze.mjs`).

Headline (mean composite [95% CI]):
| method | held-out | cross-brain | audit |
|---|---|---|---|
| no-skill | 0.633 | 0.55 | 0.545 |
| Flow-of-Action (1-shot, no reward) | 0.384 | 0.458 | 0.70 |
| hand-crafted | 0.80 | 1.375 | 1.333 |
| **GEPA** | **1.458** | 0.90 | 0.978 |
| **GRPO-ours** | 1.183 | **1.167** | **1.252** |

## What's DONE (all real runs; tokens prove Siclaw ran)
- **GEPA baseline** (the headline competitor): held-out 1.458, judge 1.0, mislabel 0,
  cross-brain 0.9, audit 0.978. `results-v2/gepa_netdns/` + `results-v2/eval/gepa/`.
- **GRPO-ours** seed s1, 3 rounds trained (`results-v2/grpo_netdns_s1/`), and all 3
  round-best checkpoints evaluated on held-out/audit/cross-brain
  (`results-v2/eval/grpo_s1{,_r1,_r2}/`) = the trajectory-ckpt ensemble for the CI.
- **Anchors**: no-skill (0.633 held-out), hand-crafted (0.80), Flow-of-Action one-shot
  (0.384 — *below* no-skill; un-optimized SOP is the clear loser). `results-v2/eval/`.
- **Collapse diagnostics**: GRPO edit-dist 0.86→0.83→0.12, entropy 0.71→0.23→0.05
  (managed late collapse, β=0.01 too weak); v1 naïve RAFT = 744-char clones + −0.10
  regression (`results/rl_netdns_main/`). In `RESULTS-v2.md §4`.
- **Budget**: 44 NEW rollouts this session (cap 150; stopped early per rule). Lifetime
  191 rollouts / 18.23M tokens across all phases.

## What's INCOMPLETE (next session — needs a WORKING GPU pod)
1. **≥3 independent random seeds for GRPO** (s2, s3). The harness is READY:
   `RL_POD=<pod> node orchestrate_v2.mjs --seed-tag s2 --cuda-device 0 ...` and
   `--seed-tag s3 --cuda-device 1 ...` train in parallel on 2 GPUs. Then
   `eval-matrix.mjs --label grpo_s2/grpo_s3` and re-run `analyze.mjs` (it auto-switches
   to seed-basis CIs once ≥3 `grpo_s\d+` eval dirs exist). The −0.275 held-out gap is
   large, so the verdict direction is robust, but seeds make the CI airtight.
2. **Optional ladder rows** (budget permitting, not decisive): best-of-N+verifier
   (`baselines/best-of-n.mjs`, ~36 rollouts), OPRO/DSPy, second-judge swap.
3. **Stronger entropy floor ablation** (β=0.05 / forward-KL) to show collapse→recovery,
   not just managed-collapse.

## ⚠️ GPU INFRA BLOCKER (why seeds s2/s3 did not run)
- Designated pod `rl-skill-trainer-3` (8×H100, `hpe-node144`) was **EVICTED** mid-setup:
  the 5.8 GB Qwen HF download filled the node's ephemeral-storage, which sits
  permanently ~1 GB over its disk-pressure eviction threshold (other tenants).
- Replacement `rl-skill-trainer-4` (manifest `pod-trainer-4.yaml`, HF cache on
  memory-backed `/dev/shm`, 2 GPUs) was **rejected at admission** — `hpe-node144` is
  actively `DiskPressure=True` so the kubelet blocks ALL new pods there.
- The only other healthy real GPU node `gpu-10-208-55-159` had all 8 GPUs held by a
  legit `qwen32b-pretrain` Job (do NOT disturb). All `gemini-c-*` nodes unreachable.
- **To resume GPU work:** wait for `hpe-node144` DiskPressure to clear
  (`kubectl get node hpe-node144 -o jsonpath='{.status.conditions[?(@.type=="DiskPressure")].status}'`)
  OR for the qwen32b Job to finish freeing `gpu-10-208-55-159`, then `kubectl apply -f
  pod-trainer-4.yaml` (already targets memory-backed cache; edit nodeSelector if using
  the gpu-node). NB: I **can** create+delete pods in `siclaw-rl-yye` (RBAC allows both,
  contrary to the old note); the pod self-terminates at 8h via activeDeadlineSeconds.
- Dead pod objects `rl-skill-trainer-3` (Evicted) and `-4` (Evicted) are harmless
  (no resources held); leave or delete as you prefer.

## How to resume (commands)
```bash
nc -z 127.0.0.1 16443 && echo tunnel-up        # bastion tunnel to cks-test
export PATH=/Users/yye/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH  # node 24
export KUBECONFIG=~/.kube/config
# orchestrate_v2.mjs now reads RL_POD / RL_POD_CONTAINER env + --cuda-device flag.
# Agent brain gpt-5.4 (providers/gpt). Cross-brain = Kimi (providers/kimi). Judge = Claude.
```

## Other session threads still pending (separate from RL)
- Multi-model eval (paper): gpt-5.4 now works as a 5th model; hard-mode judging + v2
  stealthy-injection analysis still queued (`experiments/aaai-paper/`).
- Paper credibility fixes confirmed: real-judge (not keyword), GPU-SRE benchmark design.

## Housekeeping
- **Rotate the scitix API key** — pasted in chat earlier, lives in gitignored
  `experiments/aaai-paper/.secrets.env`.
