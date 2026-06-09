# RESULTS — agent-in-the-loop RL skill optimization

**Every number below is from a real run.** No keyword proxy, no static dataset.
The real Siclaw agent investigated the live `cks-test` cluster on every rollout
(scitix **Kimi-K2.5** brain), and a real LLM judge (scitix
**claude-sonnet-4-6**) scored the real diagnosis.

> **Headline (honest):** the real loop works and a *good* diagnostic skill
> demonstrably and generalizably raises Siclaw's diagnosis quality
> (held-out **0.70 → 1.00**, +0.30). The H100 skill-proposer RL bootstrap,
> however, **did not** learn a generalizing skill in the available pod window:
> its best skill helped on training cases but **regressed on held-out**
> (0.70 → 0.60, **−0.10**) by over-specializing to DNS and dropping the
> NetworkPolicy reasoning. Both facts are reported as found.

---

## 0. Proof that Siclaw actually ran in the loop

The prior (discarded) attempt's tell was *flat* MaaS token usage. Here, across
all `reward.json` produced in this experiment:

| Metric | Value |
|---|---|
| Real Siclaw rollouts (case investigations) | **97** |
| Real tool calls against the live cluster | **700** |
| MaaS tokens consumed (Kimi-K2.5 brain) | **9,339,235** |
| Judge calls (claude-sonnet-4-6) | one per rollout |

Per-rollout token/tool-call counts are recorded in every
`results/*/reward.json` (`tokens` field, sourced from the agent's
`getSessionStats`). A skill *changes behaviour*, not just the answer — e.g. with
the hand-crafted skill the agent runs `kubectl get networkpolicy` **first** and
inspects the client pod's `dnsConfig`, instead of describing pod restart events
(see §4).

---

## 1. Environment (Stage 1) — validated

Weak category chosen for headroom: **network-dns** (the eval showed it 40–70%).
Train set = 6 cases spanning all three sub-types
(`c068,c069,c070,c071,c072,c073`: NetworkPolicy-deny-egress on client,
NetworkPolicy-deny-ingress on server, client DNS override).

**No-skill baseline vs hand-crafted skill** (same 6 cases, real agent + real
judge):

| Condition | mean judge | pass% | per-case |
|---|---|---|---|
| No skill | **0.600** | 50% | c068 1.0, c069 0.1, c070 1.0, c071 0.2, c072 1.0, c073 0.3 |
| Hand-crafted skill | **1.000** | 100% | all 1.0 |
| **Advantage** | **+0.40** | +50pp | every weak case fixed |

The hand-crafted skill (`skills/network-dns-handcrafted.txt`) is a generic SOP —
no case names, no ground truth — that tells the agent to (1) enumerate
NetworkPolicies and match their selectors against the client/server, and (2)
inspect the client pod's `dnsConfig` for an overriding nameserver, before
blaming CNI/nodes. This is a **clean Stage-1 checkpoint**: real agent runs, real
reward flows, and skill injection meaningfully moves the real judge score.

---

## 2. Skill-proposer RL (Stage 2) — real reward trajectory

Policy: `Qwen/Qwen2.5-3B-Instruct` + LoRA on the H100 pod (`rl-skill-trainer`).
Method: **RAFT / ReST** — each round the proposer generates K=4 candidate skills
(prompted with the category + 2 example *symptoms*, NO ground truth); each is
scored by the **real** environment (`reward.mjs`, 6 train cases); the policy is
LoRA-SFT'd to imitate the round's top-reward skills (advantage-weighted). 3
rounds. No-skill baseline reward = **0.600**.

| Round | mean reward | best reward | candidate rewards | MaaS tokens |
|---|---|---|---|---|
| 0 (base model) | **0.737** | **0.850** | 0.85, 0.80, 0.70, 0.60 | 3,029,882 |
| 1 (after RAFT #0) | 0.587 | 0.750 | 0.75, 0.73, 0.58, 0.28 | 2,291,733 |
| 2 (after RAFT #1) | 0.583 | 0.650 | 0.65, 0.60, 0.58, 0.50 | 1,897,479 |

Reading the curve honestly:
- **Every round's candidates beat the 0.600 no-skill baseline on average**, and
  the best-of-round was always ≥ 0.65 — so on *training* cases the proposer does
  produce skills that raise Siclaw's real score.
- But the trajectory **declines** (0.737 → 0.587 → 0.583). The single best skill
  appeared in **round 0** (0.850), from the *base* model — the RL updates did not
  improve on it.

**Why it declined (diagnosed, not hand-waved):** RAFT on a tiny group (K=4) with
a strong concise winner caused **mode collapse**. After round 0, *every*
candidate became a ~744-char near-clone of round-0's concise DNS-leaning skill
(visible in `round*/candidates.json`: all `chars≈744`). The policy lost
diversity and the reward variance it needs to climb; the LoRA SFT loss collapsed
to ~0.0004 (the model just memorised one template). This is the classic
sparse-reward / small-group RAFT failure mode.

---

## 3. Held-out validation (before / after) — the honest verdict

Held-out set = the 4 network-dns cases **never used in training**:
`c074` (NetPol egress), `c075` (NetPol ingress), `c076` (DNS override),
`c077` (NetPol egress). Same real agent + real judge.

| Held-out skill | mean judge | pass% | advantage vs no-skill |
|---|---|---|---|
| **No skill (baseline)** | **0.700** | 75% | — |
| **Hand-crafted skill** | **1.000** | 100% | **+0.30** |
| **RL-learned best skill** (round 0, train-reward 0.85) | **0.600** | 50% | **−0.10** |

Per-case (the decisive detail):

| case | type | no-skill | RL-learned | hand-crafted |
|---|---|---|---|---|
| c074 | NetPol egress | 1.0 | **0.1** | 1.0 |
| c075 | NetPol ingress | 0.1 | 0.3 | 1.0 |
| c076 | DNS override | 0.7 | **1.0** | 1.0 |
| c077 | NetPol egress | 1.0 | 1.0 | 1.0 |

The RL-learned skill is a **DNS-tunnel-vision** skill. It *helped* the DNS case
(c076: 0.7 → 1.0) but **broke** a NetworkPolicy case the agent already solved
(c074: 1.0 → 0.1): the skill steers the agent to fixate on "DNS configuration",
so it diagnosed an egress-deny NetworkPolicy as a DNS failure. Judge evidence on
c074: *"the agent identifies 'DNS resolution failure'… ground truth is a
NetworkPolicy blocking all egress."* The hand-crafted skill — which enumerates
NetworkPolicies **first** — gets all four. The RL loop optimised a surface
correlation (DNS keywords scored well on the easy train DNS cases) rather than
the underlying multi-cause procedure, and it did not generalize.

---

## 4. Evidence the skill changes agent behaviour (not just wording)

`c069` (NetworkPolicy deny-ingress), client tool calls:

- **No skill:** `get service` → `get endpoints` → `get pod` → `describe pod …
  grep Events` → concludes "client one-shot container restart loop" (**0.1**,
  never inspects the policy).
- **Hand-crafted skill:** `get networkpolicy` **first** → `get pod -o yaml`
  (dnsConfig) → `get pod --show-labels` → `get networkpolicy c069-deny-ingress
  -o yaml` → names the deny-ingress policy (**1.0**).

`c073` (DNS override): with the skill the agent runs `get pod c073-client -o
yaml` and reads the overriding nameserver; without it the agent blames inter-node
CNI/firewall and never checks DNS config. Traces under
`results/baseline_netdns6/traces/` vs `results/withskill_netdns6/traces/`.

---

## 5. Limitations (honest)

1. **The RL bootstrap did not beat the base model or generalize.** Best skill was
   round-0 (base model), and on held-out it was −0.10 vs no-skill. The real,
   working environment is the deliverable; the *learned* policy is not yet a win.
2. **Too sample-starved.** 3 rounds × K=4 candidates × 6 cases is ~72 real
   rollouts of policy signal — far too few for stable RL. Real rollouts are slow
   (~30–90 s + judge), so the run was deliberately small to fit the pod window.
3. **RAFT mode collapse.** Imitating a single concise winner with no diversity
   pressure (no length/format regularizer, no min-reward floor on *which* surface
   form to imitate) collapsed candidates to one template. Mitigations for a real
   run: keep more candidates, add a KL/diversity term or entropy bonus, imitate
   the *content* (NetworkPolicy + dnsConfig coverage) not the surface string,
   sample at higher temperature, and seed the proposer with the hand-crafted
   skill as a behavioural prior.
4. **Reward variance.** With only 6 train cases, ±1 case flipping moves the mean
   ~0.17; some round-to-round movement is noise, not signal. A larger N per skill
   would tighten it but multiplies the (already dominant) rollout cost.
5. **Single category / brain / judge.** Validated on network-dns with Kimi as the
   brain and Claude as the judge. Other weak categories (compound 57–71%) and
   other brains are untested here.
6. **Judge is the reward.** A strong, real LLM judge — but still an LLM; it is the
   ground-truth signal by construction, and any judge bias is inherited by the
   reward.

**Bottom line.** Stage 1 is solid and the central claim holds: a real
skill, injected into the *real* running Siclaw agent, generalizably improves its
real diagnosis (held-out +0.30). Stage 2 ran the full real RL loop end-to-end on
the H100 — proposer → real Siclaw + real judge reward → RAFT update, repeatedly,
with millions of MaaS tokens flowing — but in the small available window it
learned an over-specialised skill that did not generalize. The honest curve and
the held-out regression are reported exactly as observed.

---

## Run index (all under `results/`)

| Dir | What |
|---|---|
| `baseline_netdns6/` | Stage-1 no-skill baseline, 6 train cases (0.600). |
| `withskill_netdns6/` | Stage-1 hand-crafted skill, 6 train cases (1.000, +0.40). |
| `rl_netdns_main/` | Stage-2 RL run: `trajectory.json`, `round{0,1,2}/` (candidates, per-candidate `eval_cand*/`, scored.json), `BEST_SKILL.txt`. |
| `heldout_baseline/` | Held-out no-skill (c074–c077, 0.700). |
| `heldout_learned/` | Held-out RL-learned best skill (0.600, −0.10). |
| `heldout_handcrafted/` | Held-out hand-crafted skill (1.000, +0.30). |
| `logs/orchestrate.log` | Full RL-loop log. |

Each dir has `traces/<case>/result.json` (the real agent trace incl.
`stats.tokens`) and `judgments.json` (the real judge's per-dimension checklist).
On-pod adapters: `/workspace/out/skillprop/round{0,1,2}/adapter`.
