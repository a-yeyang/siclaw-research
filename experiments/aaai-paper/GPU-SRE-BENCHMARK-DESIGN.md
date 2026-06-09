# GPU-SREGym: A Benchmark for AI SRE Agents on Kubernetes GPU/AI Clusters

**Design document — v0.1 (draft for build)**
Authors: Siclaw project (AAAI submission track)
Status: design proposal, intended to be buildable as-is.

> **Scope of this document.** This is a concrete, buildable design for an open-source
> benchmark that evaluates LLM-based SRE agents on the failure modes that are *specific
> to Kubernetes GPU / AI-training clusters* — GPU hardware faults, RDMA/NCCL networking,
> gang scheduling, distributed-training pathologies, and the GPU control plane — none of
> which are covered by existing SRE/AIOps benchmarks. It is positioned as a **complementary
> extension to SREGym** (Clark et al., 2026) and **AIOpsLab** (Chen et al., MLSys 2025),
> reusing their four-tuple problem model, MCP agent interface, and LLM-as-judge checklist
> oracle, and adding a new fault domain plus an *observable-signal injection* layer that
> makes hardware faults reproducible without specialized hardware.

> **A note on sourcing.** External web access was unavailable while this document was
> written. All external statistics are attributed to primary sources already collected
> and cited by the Siclaw paper's `references.bib` (verified there), and to the extracted
> full texts of the SREGym and AIOpsLab papers held locally under
> `experiments/siclaw-agent-eval/papers/`. The GPU/RDMA technical content (Xid taxonomy,
> DCGM field names, NCCL error strings, RoCE/PFC mechanics) is drawn from the author's
> knowledge of NVIDIA/Mellanox/NCCL documentation; before publication, every Xid number,
> DCGM field, and counter name in §4 and Appendix A should be re-verified against the
> current `docs.nvidia.com` Xid reference, the DCGM API reference, and the NCCL docs.
> Items needing such verification are flagged `[verify]`.

---

## Table of contents

1. [Name, positioning, and contribution](#1-name-positioning-and-contribution)
2. [Landscape survey: SOTA SRE/AIOps benchmarks and the gap](#2-landscape-survey)
3. [What makes a GPU cluster different (fault-relevant domains)](#3-what-makes-a-gpu-cluster-different)
4. [Production reliability data → fault distribution](#4-production-reliability-data--fault-distribution)
5. [Problem taxonomy (7 categories, target ~120 problems)](#5-problem-taxonomy)
6. [Problem schema (JSON)](#6-problem-schema)
7. [Environment & fault injection (layered)](#7-environment--fault-injection)
8. [Oracles (diagnosis + mitigation + κ validation)](#8-oracles)
9. [Agent interface (MCP)](#9-agent-interface)
10. [Metrics & evaluation protocol](#10-metrics--evaluation-protocol)
11. [HuggingFace packaging](#11-huggingface-packaging)
12. [Anti-reward-hacking & limitations](#12-anti-reward-hacking--limitations)
13. [Appendix A — Xid / DCGM / NCCL reference tables](#appendix-a)
14. [Appendix B — Build plan / milestones](#appendix-b)

---

## 1. Name, positioning, and contribution

**Proposed name:** **GPU-SREGym** (alt: *AICluster-Bench*, *Neb-SRE* "NVLink/eBPF-backed").
Throughout we use **GPU-SREGym**.

**One-line positioning.** *The first benchmark that evaluates AI SRE agents on the
failure modes unique to Kubernetes GPU/AI-training clusters — GPU silicon faults, RDMA/NCCL
fabric, gang scheduling, and distributed-training pathologies — with a layered injection
substrate (real chaos injection where possible; faithful observable-signal injection where
hardware faults cannot be physically reproduced).*

**Why it is needed (the gap, confirmed in §2).** Every published SRE/AIOps benchmark —
AIOpsLab (48 problems), SREGym (90), ITBench, OpenRCA, Cloud-OpsBench — targets
**microservice application faults** on commodity Kubernetes (DeathStarBench, Train Ticket,
Astronomy Shop). Their fault catalogs (SREGym Table 1: kill pod, stress hardware, eBPF
syscall failure, disk-sector corruption, mis-deploy, misconfig, code bug, mis-operation,
overload, latency/drop, noisy-neighbor) contain **zero** GPU-, NVLink-, RDMA-, NCCL-, or
gang-scheduling-specific faults. Yet GPU hardware errors are *the dominant failure mode in
production AI clusters* (Cui et al. 2025; Wan et al., ByteRobust SOSP 2025). GPU-SREGym fills
that hole.

**Contributions.**
1. **A GPU/AI-cluster fault taxonomy** (7 categories, ~120 problems) grounded in production
   reliability data (Xid frequencies, RDMA link-flap rates, MTBF — §4).
2. **A layered injection substrate**: real injection (chaos-mesh, `tc netem`, cgroup/thermal
   pressure, DCGM fault injection, scheduler manipulation) where physically possible, plus
   **observable-signal injection** for true silicon faults (dmesg/Xid, `nvidia-smi`, DCGM,
   `ibstat`/`ethtool`, NCCL logs delivered through the *same* read paths the agent uses).
3. **GPU-specific oracles**: a 6-dimension LLM-as-judge checklist that grades *which GPU /
   which link / which Xid* the agent named, plus a state-based mitigation oracle adapted for
   node-cordon / GPU-drain / job-requeue remediations.
4. **A reproducible, HuggingFace-published artifact**: task-instance JSONL, dataset card,
   dockerized eval harness, Gradio leaderboard, and released injector code — meeting the
   rigor standards of Zhu et al. (2025) "Best Practices for Building Rigorous Agentic
   Benchmarks."

**Relationship to the existing Siclaw 10-case eval.** GPU-SREGym is the *productionized
generalization* of the 10 GPU/RDMA cases in `experiments/aaai-paper/gpu-rdma-cases.json`.
Those 10 cases become the seed of categories C1/C2/C7; the schema in §6 is a strict superset
of their schema; the judge in §8 generalizes `judge-llm.mjs` (5 dims → 6 dims, adds
GPU-entity-level scoring).

---

## 2. Landscape survey

> Confirmed gap: **no existing benchmark evaluates GPU-cluster-specific SRE.** The table
> below catalogs the most advanced SRE/AIOps and agentic-ops benchmarks; the rightmost
> columns make the absence explicit.

### 2.1 Comparison table

| Benchmark | Scale (# problems) | Environment | Fault types | Oracle / scoring | Metrics reported | Agent interface | OSS | Data format | GPU/RDMA/gang? |
|---|---|---|---|---|---|---|---|---|---|
| **AIOpsLab** (Chen, MLSys'25) | **48** | Live K8s; DeathStarBench (Hotel, Social) | app/cluster/security/misconfig | Per-task programmatic oracles; 4 isolated tasks (detect/localize/RCA/mitigate) | TTD, TTM, accuracy per task | **ACI** (Agent-Cloud Interface) via Orchestrator; `get_logs`,`get_metrics`,`get_traces`,`exec_shell` | Yes | Python task classes | **No** |
| **SREGym** (Clark, 2026) | **90** (50 fault primitives; 3,623 viable fault×target pairs) | **Live K8s**; DeathStarBench, Train Ticket, Astronomy Shop, +2 in-house | kill, stress(fail-slow), **eBPF syscall fail (OS/HW)**, disk-sector corrupt, mis-deploy, mis-config, code bug, mis-operation, overload, latency/drop, noisy-neighbor; **+ noise injectors** | **LLM-as-judge checklist** (3 dims, weighted, threshold 0.70) for diagnosis; **state-based** mitigation oracle (probes live health) | Diag %, Mitig %, **E2E %** = P(D∧M), TTD, TTM, # tokens | **MCP** servers (Metrics/Logs/Traces/Cluster-control/Submission); architecture-agnostic | Yes | Python `Problem` = (E,I,F,O) | **No** |
| **ITBench** (Jha, ICML'25) | ~36 SRE (+ FinOps, CISO tracks) | Live K8s + chaos-mesh | chaos-mesh faults, mis-config | Alert-based + checks | Resolution success | Agent SDK | Yes | YAML/Python | **No** (general IT) |
| **OpenRCA** (Xu, ICLR'25) | 335 tasks (from 3 telemetry datasets) | **Static** telemetry (logs/metrics/traces) | Real recorded incidents | Localization correctness (component/time) | RCA accuracy | Code interpreter over CSV | Yes | CSV/parquet telemetry + QA | **No** (static, app-level) |
| **Cloud-OpsBench** (Wang, 2026) | reproducible agentic RCA set | Live, reproducible | app faults | RCA correctness | RCA metrics | tool API | Yes | — | **No** |
| **MicroRemed** | microservice remediation set | Live K8s microservices | app/config | remediation success | mitigation | tool API | Yes | — | **No** |
| **SRE-skills-bench** (Rootly) | skill-graded incident tasks | mixed | ops tasks/incidents | rubric / skill scoring | skill pass | chat/tools | partial | — | **No** |
| **Flow-of-Action** (Pei, WWW'25) | SOP-driven RCA (not a fault catalog; a method+eval) | enterprise telemetry | recurring incidents | RCA accuracy | accuracy | multi-agent + SOP | — | SOP graphs | **No** |
| **GPU-SREGym (this)** | **~120** | **Live K8s + observable-signal injection** | **GPU-HW (Xid/ECC/NVLink), RDMA/NCCL, gang/queue, dist-training, GPU control-plane, compound** | **6-dim LLM-judge** (adds GPU-entity scoring) + **state-based** mitigation | Diag/Mitig/E2E, TTD/TTM, GPU-entity-correctness, noise-robustness | **MCP** (+ GPU servers: nvidia-smi, dcgmi, ibstat/ethtool) | Yes | JSONL task-instances + Python `GpuProblem` | **YES** |

### 2.2 What none of them cover (the precise gap)

Cross-referencing every fault catalog above, **none** include any of:
- GPU silicon faults surfaced as **Xid** kernel events, **ECC** SBE/DBE counters, **row-remap**
  exhaustion, "**fallen off the bus**", thermal/clock throttling, **silent data corruption (SDC)**
  at the GPU level.
- **NVLink/NVSwitch** degradation or link errors (intra-node interconnect).
- **RDMA fabric** faults: RoCEv2/IB link flap, **PFC storms**, ECN/DCQCN congestion,
  **QP→ERROR**, GPUDirect RDMA failures, mis-cabling, SR-IOV VF issues.
- **NCCL** collective timeouts/hangs, straggler-induced barrier timeouts, mismatched topology.
- **Gang/co-scheduling** failures: partial gangs, `minMember` deadlock, priority preemption of
  training jobs, GPU fragmentation, Volcano/Kueue/Kubeflow-training-operator pathologies,
  MIG/time-slice/MPS sharing faults.
- **Distributed-training** operational failures: checkpoint/restart, host↔device bottleneck,
  checkpoint storage I/O, OOM under sharded states.

SREGym's eBPF "syscall fail (OS/HW)" primitive is the closest prior art, but it injects *generic*
syscall errors into application processes; it does not model GPU/RDMA telemetry or the
GPU-specific observability surface (`nvidia-smi`, DCGM, `ibstat`). **GPU-SREGym is the first to
treat the GPU cluster as a first-class fault domain with its own observability surface and oracles.**

---

## 3. What makes a GPU cluster different

A GPU/AI-training cluster is not "Kubernetes with bigger nodes." Five structural differences
create entirely new failure modes and a distinct observability surface. (Domain reference;
re-verify Xid/DCGM specifics against vendor docs before publication — `[verify]` tags.)

### 3.1 Scheduling — *all-or-nothing, topology-sensitive*

- **Gang / co-scheduling**: a distributed-training job needs *all N* workers simultaneously or
  *none* (Volcano `PodGroup.spec.minMember`; Kueue `Workload`; Kubeflow `PyTorchJob`/`MPIJob`;
  `JobSet`). Partial allocation wastes GPUs and can **deadlock**.
- **Topology-aware placement**: rail-optimized / NVLink-domain / same-leaf placement matters for
  collective bandwidth; a topologically-bad placement silently halves throughput.
- **GPU sharing**: **MIG** (hardware partitions, e.g. 7×1g.10gb on H100), **time-slicing**
  (oversubscription via the NVIDIA device plugin), **MPS** (concurrent contexts). Each has
  distinct fault modes (MIG misconfig, time-slice contention, MPS daemon crash).
- **Binpacking & fragmentation**: 8-GPU nodes fragmented to 8×1-GPU jobs cannot host a new
  8-GPU job even though cluster-wide free GPUs exist.
- **Failure modes**: partial gangs; `minMember` deadlock; priority-preemption cascade (a
  high-priority job evicts a 256-GPU run); fragmentation-induced unschedulable; quota/queue
  starvation (Kueue `ClusterQueue` borrowing exhausted); race between scheduler and
  cordon/drain.

### 3.2 Networking — *RDMA, not TCP*

- **RDMA transports**: **RoCEv2** (RDMA over Converged Ethernet, lossless via PFC) or
  **InfiniBand**. Kernel-bypass; the NIC (Mellanox/NVIDIA ConnectX, `mlx5` driver) maintains
  **Queue Pairs (QPs)**.
- **NCCL** runs collectives (all-reduce, all-gather, reduce-scatter) over RDMA via GPUDirect
  RDMA (NIC ↔ GPU memory without host bounce).
- **SR-IOV** exposes NIC Virtual Functions to pods; RDMA shared-device or SR-IOV CNI.
- **Lossless fabric control**: **PFC** (Priority Flow Control, 802.1Qbb) PAUSE frames create
  lossless lanes; **ECN/DCQCN** does congestion control. Misbehaving traffic → **PFC storm**:
  PAUSE back-pressure propagates, head-of-line blocking across the fabric.
- **Failure modes**: link flap (port toggles Active/Down); **PFC storm**; **QP→ERROR**
  (`IBV_WC_RETRY_EXC_ERR` after retransmit exhaustion — once in ERROR a QP silently drops all
  ops until destroyed/recreated; cf. SHIFT 2025); NCCL timeout/hang; mis-cabling
  (wrong rail / cross-leaf); degraded link (FEC errors, symbol errors, dirty transceiver);
  GPUDirect RDMA disabled → silent host-bounce slowdown.

### 3.3 GPU interconnect — *NVLink/NVSwitch*

- **NVLink** (intra-node GPU↔GPU) and **NVSwitch** (all-to-all within node). H100: NVLink 4,
  ~900 GB/s aggregate; topology visible via `nvidia-smi topo -m` (`NV18`, `NVL`, `PIX`, `SYS`).
- **Failure modes**: NVLink degraded → fallback to PCIe path (e.g. `NV18`→`PIX`), ~40%
  collective slowdown; NVLink errors (CRC/replay), NVSwitch errors; **Xid 74/79** class events
  `[verify]`.

### 3.4 GPU hardware — *the Xid taxonomy*

The kernel driver emits **Xid** errors to `dmesg`/`/var/log/syslog`:
`NVRM: Xid (PCI:0000:<bus>): <id>, ...`. Key Xids (`[verify]` against `docs.nvidia.com/deploy/xid-errors`):

| Xid | Meaning | Severity | Action |
|---|---|---|---|
| **13** | Graphics Engine Exception (often app illegal access; sometimes HW) | app/HW | inspect |
| **31** | GPU memory page fault (MMU) | app/HW | inspect |
| **43** | GPU stopped processing (often app error) | app | inspect |
| **48** | **Double-Bit ECC (DBE)** uncorrectable memory error | **fatal HW** | drain + RMA / row-remap |
| **63** | ECC page retirement / **row-remap** recorded | HW | monitor; reboot to apply |
| **64** | ECC row-remap **failure** (remap could not be applied) | **fatal HW** | drain + RMA |
| **74** | **NVLink** error (also NVSwitch) | HW | inspect link/cable |
| **79** | **GPU fallen off the bus** | **fatal HW** | reseat / RMA; node down |
| **92** | High single-bit ECC (SBE) rate | warn HW | monitor |
| **94** | Contained ECC error (uncorrectable, contained) | HW | drain GPU |
| **95** | Uncontained ECC error | **fatal HW** | drain + RMA |
| **119/120** | **GSP** RPC timeout / error | HW/FW | reset GPU / driver |
| **48 vs 94/95** | DBE (48) vs contained/uncontained (94/95) distinction is a frequent agent confusion point | — | grade carefully |

- **ECC**: single-bit (corrected, counted) vs double-bit (uncorrectable). DCGM fields:
  `DCGM_FI_DEV_ECC_SBE_VOL_TOTAL`, `DCGM_FI_DEV_ECC_DBE_VOL_TOTAL`,
  `DCGM_FI_DEV_ECC_SBE_AGG_TOTAL`, `DCGM_FI_DEV_ECC_DBE_AGG_TOTAL` `[verify]`.
- **Row-remapping**: HBM self-repair; *finite* spare rows. `nvidia-smi -q` →
  `Remapped Rows: {Correctable, Uncorrectable, Pending, Failure}`; DCGM
  `DCGM_FI_DEV_ROW_REMAP_FAILURE`, `..._PENDING`. **Exhaustion** → persistent uncorrectable
  errors → GPU replacement.
- **Thermal/clock throttling**: `nvidia-smi -q -d PERFORMANCE` →
  `Clocks Throttle Reasons: HW Thermal Slowdown Active / SW Thermal / HW Power Brake`. DCGM
  `DCGM_FI_DEV_CLOCK_THROTTLE_REASONS`, `DCGM_FI_DEV_GPU_TEMP`.
- **"Fallen off the bus"** (Xid 79): GPU disappears from PCIe; `nvidia-smi` shows
  `ERR!` / "Unable to determine the device handle"; node likely needs reboot.
- **Silent Data Corruption (SDC)**: GPU computes wrong results without any error flag — the
  hardest fault; detected only by redundant compute, checksum mismatch, or loss-curve anomaly
  (cf. Holmes NSDI'25 "silent irregularities").

### 3.5 Distributed training — *coupled failure across ranks*

- **Stragglers**: one slow rank (degraded clock, thermal, bad NIC) makes the whole collective
  wait → barrier timeout. NCCL: `Watchdog ... Timeout(ms)=...` , `NCCL WARN ... timeout`.
- **Hangs**: deadlock on a collective when one rank dies silently; the survivors block on
  all-reduce forever (until `NCCL_ASYNC_ERROR_HANDLING` / `TORCH_NCCL_..._TIMEOUT` fires).
- **Checkpoint/restart**: checkpoint write stalls (storage I/O), restart loses progress, or
  resume mismatch (world-size change). Checkpoint storage (NFS/Lustre/object) is a shared
  bottleneck.
- **OOM**: CUDA OOM under sharded optimizer states (ZeRO/FSDP), activation memory spikes,
  fragmentation; vs. *apparent* OOM caused by thermal capacity reduction.
- **Host↔device bottleneck**: dataloader CPU starvation, PCIe contention, `pin_memory`
  mis-set, NUMA-misaligned NIC↔GPU.

### 3.6 Observability surface (what the agent reads to diagnose)

This is the heart of the benchmark: the agent diagnoses by reading these, mediated by MCP (§9).

| Surface | Tool / source | What it reveals | DCGM/metric anchor |
|---|---|---|---|
| Kernel | `dmesg`, `/var/log/syslog`, node-problem-detector | **Xid** events, RDMA link state, MCE | NPD `NodeCondition` |
| GPU telemetry | `nvidia-smi`, `nvidia-smi -q`, `dcgmi` | temp, power, clocks, ECC, remap, util, topo | DCGM fields below |
| GPU metrics | **dcgm-exporter** → Prometheus | `DCGM_FI_DEV_*` time series | `DCGM_FI_DEV_GPU_TEMP`, `..._ECC_DBE_VOL_TOTAL`, `..._XID_ERRORS`, `..._NVLINK_*`, `..._POWER_USAGE` |
| GPU control plane | `kubectl` on GPU operator, device-plugin, NPD, MIG manager | allocatable `nvidia.com/gpu`, plugin health | — |
| RDMA | `ibstat`, `ibstatus`, `iblinkinfo`, `perfquery`, `ethtool -S`, `ethtool -m` | port state, link speed, PFC/ECN counters, FEC/symbol errors | `node_infiniband_*` |
| NCCL | container logs (`NCCL_DEBUG=INFO/WARN`), Loki | ring/tree topo, timeouts, transport (NVLink vs NET) | — |
| Scheduler | `kubectl get podgroup/queue/workload`, Volcano/Kueue events | gang state, `minMember`, preemption, quota | — |
| Traces | Jaeger (for serving) | request paths (less central for training) | — |

DCGM Xid surfacing: `DCGM_FI_DEV_XID_ERRORS` (last Xid). NVLink: `DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT_TOTAL`, `DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL` `[verify]`.

---

## 4. Production reliability data → fault distribution

The fault distribution is **weighted by real production failure rates**, so the benchmark's
difficulty and category balance reflect what SREs actually face — not an arbitrary uniform mix.
Statistics below are attributed to the cited primary sources (verified in the Siclaw
`references.bib`); re-confirm exact figures from the papers before the camera-ready.

### 4.1 Key production statistics

| Statistic | Value | Source |
|---|---|---|
| GPU hardware errors are the **dominant** failure mode in production AI clusters | qualitative | Cui et al. 2025 (arXiv:2503.11901); Wan et al. ByteRobust (SOSP'25) |
| Xid characterization scale | **11.7M GPU-hours**, H100 | Cui et al. 2025 |
| H100 uncorrectable memory-error rate vs A100 | **3.2× worse** | Cui et al. 2025 |
| RDMA link flaps in a large datacenter | **5K–60K per day** | Cui et al. 2025 / Ghorbani et al. IMC'25 |
| RDMA datacenter congestion patterns (PFC/ECN) | measured at scale | Ghorbani et al. IMC'25 |
| QP-failure resilience problem (ERROR-state QPs are not self-healing) | motivates a dedicated layer | SHIFT 2025 (arXiv:2512.11094) |
| Large-scale training reliability / robust infra | production-grade | ByteRobust SOSP'25 |
| Silent irregularities in mega-scale LLM training | a distinct localization problem | Holmes NSDI'25 |
| Failure analysis & fault injection in AI systems (survey) | confirms no GPU/RDMA SRE-agent benchmark exists | Yu et al. (TOSEM, fault-injection survey) |

> Additional commonly-cited production datapoints to fold in once re-verified `[verify]`:
> Meta Llama-3 405B training (54-day run, hundreds of interruptions, ~58–78% of failures
> GPU/NVLink/HBM-attributable per the Llama-3 herd paper); ByteDance **MegaScale** (>10k GPUs,
> diagnosis tooling for stragglers/hangs); Alibaba/Microsoft Singularity scheduling. These
> motivate the *distributed-training* and *gang-scheduling* categories.

### 4.2 Resulting category weighting (target counts)

The distribution over-weights GPU-HW and RDMA (the empirically dominant classes) while
keeping enough scheduling/training/control-plane breadth to test the full diagnostic surface.

| Category | Share | Target N | Rationale (from §4.1) |
|---|---|---|---|
| C1 GPU hardware (Xid/ECC/NVLink/thermal/SDC) | **30%** | **36** | dominant production failure mode (Cui'25) |
| C2 RDMA / NCCL networking | **22%** | **26** | 5K–60K flaps/day; QP/PFC (Ghorbani, SHIFT) |
| C3 Gang scheduling / queueing | 15% | 18 | gang/preempt/fragmentation pervasive at scale |
| C4 Distributed-training pathologies | 14% | 17 | stragglers/hangs/checkpoint (MegaScale, Holmes) |
| C5 GPU control plane / operator | 9% | 11 | device-plugin/MIG/driver/operator faults |
| C6 Compound (cross-domain) | 7% | 8 | hardest; mirrors real multi-cause incidents |
| C7 Storage/IO for training (checkpoint) | 3% | 4 | checkpoint I/O bottleneck |
| **Total** | 100% | **~120** | |

(Counts are a v1 target; the framework supports continuous addition à la SREGym.)

---

## 5. Problem taxonomy

Seven categories. Each problem has a stable ID `g<NN>` (continuing from the existing g01–g10),
a difficulty tier (`easy`/`medium`/`hard`; see §10.7), and a primary fault domain. Examples
below give 3–5 concrete problems per category. Existing Siclaw cases are noted `[seed: gNN]`.

### C1 — GPU hardware faults (target 36)

| ID seed | Problem | Ground-truth mechanism (abridged) | Key signals |
|---|---|---|---|
| `[seed g01]` | **Xid 48 DBE** → training crash (SIGABRT/exit 134) | GPU k on node N hit Xid 48 (uncorrectable DBE), CUDA illegal memory access; RMA/row-remap | dmesg Xid 48, `nvidia-smi -q` ECC DBE, pod exit 134 |
| `[seed g03]` | **Thermal throttling masquerading as CUDA OOM** | GPU at 103 °C → `HW Thermal Slowdown`; allocator fails despite 80 GB; cooling/fan fault | `nvidia-smi` temp, throttle reasons, CUDA OOM |
| `[seed g06]` | **Row-remap exhausted** (persistent ECC across restarts) | GPU k remap capacity exhausted, `Remapped Rows: Pending(reboot)` + aggregate DBE>0; replace | `nvidia-smi -q` remap, ECC agg, persists across pod restarts |
| new | **Xid 79 "fallen off the bus"** | GPU disappears from PCIe; `nvidia-smi` `ERR!`; node degraded; reseat/RMA | dmesg Xid 79, `nvidia-smi` ERR, `nvidia.com/gpu` allocatable drops |
| new | **Silent data corruption (SDC)** | No Xid; loss diverges / checksum mismatch on one rank; DCGM clean; suspect GPU SDC | NCCL/loss anomaly on one rank, DCGM nominal, redundant-compute mismatch |
| new | **NVLink degradation** `[seed g02]` | NVLink GPU2↔GPU3 `NV18`→`PIX` (PCIe fallback); ~40% collective slowdown | `nvidia-smi topo -m`, NVLink err counters, NCCL transport=PCI |
| new | **SBE storm (Xid 92)** w/o uncorrectable | High SBE rate, no DBE yet; pre-failure warning, schedule maintenance | DCGM SBE_VOL rising, Xid 92, no crash |

### C2 — RDMA / NCCL networking (target 26)

| ID seed | Problem | Mechanism (abridged) | Key signals |
|---|---|---|---|
| `[seed g04]` | **IB/RoCE link flap** → NCCL all-reduce timeout | `mlx5_0:1` toggles Active/Down (43 flaps/10 min); in-flight RDMA fails; cable/transceiver | `ibstat` port state Polling, flap count, NCCL timeout, dmesg |
| `[seed g05]` | **PFC storm** → cluster-wide RDMA congestion | noisy-neighbor on node X → PFC PAUSE back-pressure; bw 180→23 GB/s; DCQCN insufficient | `ethtool -S` rx_pfc_pause spike, ECN counters, multi-job slowdown |
| `[seed g08]` | **QP → ERROR** (training hang, zero throughput) | `IBV_WC_RETRY_EXC_ERR` → QP ERROR; silent drop until watchdog; must recreate (cf. SHIFT) | QP state ERROR, retry-exceeded, zero throughput, `ibv_wc` status |
| new | **Mis-cabling / wrong rail** | job placed across leaf boundary / wrong rail; bandwidth ½; topo mismatch | `iblinkinfo`/`ibnetdiscover`, NCCL ring crosses rails, throughput |
| new | **GPUDirect RDMA disabled** (silent host-bounce) | `nv_peer_mem`/`gdrcopy` missing → NCCL falls back to host staging; throughput drop, no error | NCCL `NET/IB` vs `NET/Socket`, no GDR, lower bw |
| new | **Degraded link (FEC/symbol errors)** | link up but high symbol/FEC error rate; intermittent corruption/retrans | `ethtool -S` symbol/FEC errors, `perfquery` PortXmitDiscards |

### C3 — Gang scheduling / queueing (target 18)

| ID seed | Problem | Mechanism (abridged) | Key signals |
|---|---|---|---|
| `[seed g10]` | **Volcano gang + node-drain race** | `minMember=2` PodGroup; node cordon races allocation; partial gang evicted; deadlock | PodGroup Pending, node SchedulingDisabled, pod eviction, minMember |
| new | **Partial gang / insufficient gang** | only N−1 GPUs free; PodGroup stuck Pending; no preemption configured | PodGroup `Pending`/`Inqueue`, events "not enough resources" |
| new | **Priority-preemption cascade** | high-priority job preempts a 64-GPU run; victim requeues, re-preempted (livelock) | preemption events, PriorityClass, repeated evictions |
| new | **GPU fragmentation** | 8×1-GPU jobs fragment nodes; new 8-GPU job unschedulable despite free GPUs cluster-wide | per-node allocatable vs requested, binpack failure |
| new | **Kueue quota starvation** | `ClusterQueue` borrowing exhausted; `Workload` admitted=false; cohort over-committed | Kueue `Workload` conditions, quota, `AdmissionCheck` |
| new | **MIG misconfig** | job requests `nvidia.com/mig-1g.10gb` but nodes expose `3g.40gb`; unschedulable | device-plugin advertised MIG profiles, request mismatch |

### C4 — Distributed-training pathologies (target 17)

| ID seed | Problem | Mechanism (abridged) | Key signals |
|---|---|---|---|
| `[seed g07]` | **Silent GPU clock degradation → straggler → NCCL barrier timeout** | GPU clock drops 1980→1200 MHz on one rank; straggler; intermittent barrier timeout | `nvidia-smi` clocks, NCCL timeout intermittent, straggler rank |
| new | **NCCL hang from dead rank** | one worker OOM-killed; survivors block on all-reduce; watchdog fires after timeout | one pod `OOMKilled`, others `Running` but 0 progress, NCCL watchdog |
| new | **Checkpoint write stall (storage I/O)** | checkpoint to NFS stalls; training pauses; appears as hang but is storage | training stall correlated with ckpt step, PVC I/O latency, storage events |
| new | **CUDA OOM under FSDP** | activation/optimizer-state spike → CUDA OOM; *genuine* memory pressure (contrast g03 thermal) | CUDA OOM, mem util high, not thermal |
| new | **Host↔device dataloader bottleneck** | CPU dataloader starves GPUs; GPU util sawtooth; no HW fault | DCGM GPU util low/sawtooth, CPU saturated, throughput low |

### C5 — GPU control plane / operator (target 11)

| ID seed | Problem | Mechanism (abridged) | Key signals |
|---|---|---|---|
| new | **device-plugin crash** | `nvidia-device-plugin` DaemonSet pod CrashLoop; node `nvidia.com/gpu` allocatable → 0; new GPU pods Pending | DS pod CrashLoop, allocatable 0, pods Pending |
| new | **Driver/toolkit mismatch** | container CUDA newer than node driver; `CUDA driver version is insufficient`; pods crash on start | pod logs CUDA version error, node driver version |
| new | **GPU operator / DCGM-exporter down** | dcgm-exporter pod down → GPU metrics blind; *observability* incident, not compute | dcgm-exporter not ready, Prometheus target down, missing `DCGM_FI_*` |
| new | **NPD GPU condition stuck** | node-problem-detector flags a stale `XidError` condition; scheduler avoids healthy node | NodeCondition `XidError=True` but GPU healthy now, mis-cordon |
| new | **MPS daemon crash** | `nvidia-cuda-mps-control` down; concurrent jobs serialize / error | MPS pipe errors, contention |

### C6 — Compound, cross-domain (target 8)

| ID seed | Problem | Mechanism (abridged) | Why hard |
|---|---|---|---|
| `[seed g09]` | **GPU ECC + RDMA congestion on same node** | two independent faults: GPU4 SBE/occasional DBE **and** PFC congestion; alternating CUDA-error / NCCL-timeout | must report **both** root causes; failure mode alternates |
| new | **Thermal throttle + straggler timeout** | GPU thermal → clock drop → straggler → NCCL timeout (one causal chain vs two faults) | distinguish single-chain vs independent (contrast g09) |
| new | **Frag scheduling + dead GPU** | one GPU off-the-bus reduces node capacity → fragmentation → new gang unschedulable | cross-layer: HW fault → scheduling symptom |
| new | **Mis-cabling + NVLink fallback** | wrong rail (inter-node) **and** NVLink degraded (intra-node); compounded ½×½ throughput | two interconnect faults at different tiers |

### C7 — Storage/IO for training (target 4)

| ID seed | Problem | Mechanism (abridged) | Key signals |
|---|---|---|---|
| new | **Checkpoint storage saturation** | shared Lustre/NFS saturated by many concurrent ckpts; all jobs stall at ckpt step | storage throughput ceiling, correlated stalls across jobs |
| new | **Dataset cache thrash (`/dev/shm`)** | shm exhaustion → dataloader OOM/slow; GPUs idle | `/dev/shm` full, dataloader errors |

---

## 6. Problem schema (JSON)

A strict **superset** of the existing `gpu-rdma-cases.json` schema (so the 10 seed cases
validate unchanged). One JSON object per problem; the corpus is an array (dev work) and is also
flattened to JSONL task-instances for HF (§11).

```jsonc
{
  // ---- identity ----
  "id": "g04",                       // stable, immutable
  "schema_version": "1.0",
  "category": "rdma-network",        // C1..C7 enum: gpu-hardware | rdma-network |
                                     //   gang-scheduling | distributed-training |
                                     //   gpu-controlplane | compound | storage-io
  "difficulty": "hard",              // easy | medium | hard  (see §10.7)
  "title": "RDMA link flap causing NCCL allreduce timeout",
  "namespace": "gpu-sregym-eval",

  // ---- task framing given to the agent ----
  "task_type": ["diagnosis", "mitigation"],   // which oracles run; read-only agents skip mitigation
  "symptom": "Distributed training pod g04-rdma-flap hangs at NCCL allreduce and eventually times out ...",
  "targets": ["pod/g04-rdma-flap", "vcjob/g04"],   // resources the agent should localize to
  "primary_fault_domain": "rdma",    // gpu | nvlink | rdma | nccl | scheduler | training | storage | controlplane

  // ---- structured ground truth (authoritative for the judge) ----
  "groundTruth": {
    "localization": "pod/g04-rdma-flap on fake-node-105, RDMA HCA mlx5_0 port 1",
    "mechanism": "InfiniBand port mlx5_0:1 on fake-node-105 is link flapping (43 state changes in 10 min) ...",
    "scope": "All inter-node RDMA involving node-105 mlx5_0:1; intra-node NVLink unaffected; multi-node jobs hang.",

    // GPU-entity-level ground truth (NEW — enables fine-grained scoring, §8)
    "entity": {
      "node": "fake-node-105",
      "gpu_index": null,             // 0..7 or null
      "gpu_uuid": null,              // "GPU-xxxx" if applicable
      "hca": "mlx5_0",
      "ib_port": 1,
      "nvlink_pair": null,           // [2,3] for NVLink faults
      "rail": null
    },
    "error_codes": {                 // NEW — exact codes the diagnosis must name
      "xid": [],                     // e.g. [48]
      "ecc": null,                   // "DBE" | "SBE" | null
      "nccl": ["timeout"],           // ["timeout","watchdog","RETRY_EXC_ERR"]
      "ibv_wc": [],                  // e.g. ["IBV_WC_RETRY_EXC_ERR"]
      "throttle_reason": null        // "HW Thermal Slowdown Active" | ...
    },
    "num_root_causes": 1,            // >1 for compound (judge must find all)
    "causal_structure": "single",   // single | chain | independent-compound

    // mitigation ground truth (state-based oracle + recommended-action checklist)
    "remediation": {
      "recommended_actions": [
        "cordon fake-node-105 / mark mlx5_0:1 for cable inspection",
        "requeue the gang job to healthy nodes"
      ],
      "destructive_actions_forbidden": ["delete training data PVC", "kubectl drain without --ignore-daemonsets review"],
      "verifiable_state": {          // what the mitigation oracle probes after the agent acts
        "predicate": "no_pod_in_namespace_hung_for_seconds",
        "params": { "seconds": 120 },
        "alt_predicate": "vcjob_g04_running_and_progressing"
      }
    }
  },

  // ---- signals the agent is expected to consult (used for noise & faithfulness audit) ----
  "expectedSignals": [
    "ibstat port state", "link flap count", "nccl timeout", "dmesg rdma"
  ],

  // ---- injection plan (how the env is set up; consumed by the injector, NOT shown to agent) ----
  "injection": {
    "mode": "observable-signal",     // real-chaos | observable-signal | hybrid
    "components": [
      { "kind": "node-signal", "node": "fake-node-105",
        "dmesg": "fixtures/g04/dmesg.txt",
        "ibstat": "fixtures/g04/ibstat.txt",
        "ethtool": "fixtures/g04/ethtool_mlx5_0.txt" },
      { "kind": "pod-log", "target": "pod/g04-rdma-flap", "log": "fixtures/g04/nccl.log" },
      { "kind": "configmap", "name": "g04-node105-telemetry", "from": "fixtures/g04/telemetry.yaml" },
      { "kind": "prom-series", "metric": "DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL", "from": "fixtures/g04/series.json" }
    ],
    "real_chaos": null,              // for real-chaos mode: {tool:"tc-netem", spec:{...}} | {tool:"chaos-mesh", ...}
    "recover": { "delete_namespace_resources": true, "remove_node_annotations": true }
  },

  // ---- provenance & realism ----
  "grounded_in": ["cui2025gpuresilience", "ghorbani2025rdma", "lin2025shift"],
  "fidelity_notes": "ibstat/ethtool fixtures captured from a real RoCEv2 ConnectX-6 under induced flap; redacted serials.",

  // ---- bookkeeping ----
  "split": "test",                   // dev | test  (and tags by-difficulty/by-category)
  "tags": ["roce", "infiniband", "nccl", "link-flap"],
  "author": "siclaw",
  "created": "2026-06-05"
}
```

**Field discipline.** `groundTruth.entity` and `groundTruth.error_codes` are the new
load-bearing additions: they let the oracle grade *GPU-entity correctness* (did the agent name
the right GPU index / IB port / Xid?) deterministically, complementing the semantic judge. The
`injection` block is **never** visible to the agent (anti-reward-hacking, §12).

---

## 7. Environment & fault injection

### 7.1 The hard tradeoff

Physically injecting a double-bit ECC error or making a GPU "fall off the bus" on demand is
impractical (needs hardware, voids warranties, is non-deterministic). But the agent's *interface
to the fault is telemetry*, not silicon. So GPU-SREGym uses a **layered** approach, choosing the
most realistic injection that is feasible per fault:

| Layer | Faults injected this way | Mechanism | Fidelity |
|---|---|---|---|
| **L0 Real chaos** | scheduling, queueing, control-plane, some training, network jitter | chaos-mesh (`PodChaos`,`NetworkChaos`,`StressChaos`), Volcano/Kueue manipulation, kill device-plugin, cordon/drain, `kubectl` mutations | **highest** — genuine cluster state |
| **L1 Real network shaping** | RDMA-ish congestion, latency, loss, jitter, PFC-like back-pressure on the *Ethernet* path | `tc netem` (delay/loss/reorder/corrupt), `tc tbf`/`htb` rate caps, on the pod/node veth; if RoCE hardware present, real PFC via switch config | **high** for transport symptoms; RDMA-kernel-bypass specifics still need L3 telemetry |
| **L2 Real resource pressure** | thermal-like throttling, clock pressure, GPU memory pressure, host↔device contention | cgroup CPU/mem limits, `stress-ng`, DCGM **fault injection** (`dcgmi test --inject` / `nvidia-smi` injectable counters where supported), GPU memory hog pod, NUMA pinning | **medium-high** — real resource contention; some throttle reasons must be supplemented by L3 |
| **L3 Observable-signal injection** | **true silicon faults** (Xid, DBE/SBE, row-remap, off-the-bus, NVLink degr., QP→ERROR, mis-cabling) | inject the *exact telemetry the agent would read* through the same channels: `dmesg` fixtures, `nvidia-smi`/`dcgmi` output, `ibstat`/`ethtool` counters, NCCL logs, dcgm-exporter Prometheus series, NPD `NodeCondition`s | **faithful-by-construction** for the diagnostic surface (the agent cannot tell the difference if signals are coherent) |

A single problem may be **hybrid** (e.g. real `tc netem` loss *plus* L3-injected `ethtool`
PFC-pause counters and an L3 NCCL timeout log).

### 7.2 How L3 delivers signals through the agent's real read paths

The principle: the agent must observe injected signals **only via the tools it already uses**
(MCP §9) — never via a side channel it could detect.

- **dmesg / Xid / kernel** → a per-node DaemonSet (`gpu-sregym-signal-agent`, runs as a normal
  workload pod) exposes a *node-scoped signal file*; the MCP `node-exec`/`dmesg` tool is wired so
  that when the agent reads `dmesg` for node N it returns the injected buffer (real dmesg tail
  **merged** with the fixture, time-coherent). Alternatively NPD is fed a custom monitor that
  emits the `XidError`/`InfinibandPortDown` `NodeCondition`, so `kubectl describe node N` shows it.
- **nvidia-smi / dcgmi** → MCP exposes a `gpu-query` tool. In L3 mode it returns a deterministic
  rendering produced from the problem's `entity`+`error_codes` by a **faithful renderer** (a
  templating layer that produces byte-for-byte plausible `nvidia-smi -q` / `dcgmi dmon` output,
  including the *other 7 healthy GPUs* with realistic varying temps/util).
- **ibstat / ethtool / perfquery** → MCP `rdma-query` tool returns rendered IB/RoCE counters from
  fixtures; healthy ports rendered too.
- **NCCL logs** → delivered as **real pod logs**: the workload pod for the case is a small
  PyTorch/`nccl-tests` job (or a stub that prints a captured NCCL trace from a real failure),
  so `kubectl logs` / Loki return genuine-looking logs.
- **Prometheus / DCGM series** → a sidecar `prom-pushgateway`/recording-rules layer (or a
  benchmark-controlled Prometheus instance) serves the injected `DCGM_FI_DEV_*` series so the
  Metrics MCP returns them like any other metric.

**Fixtures are captured from real hardware where possible** (`fidelity_notes`): e.g. real
`ibstat` during an induced flap on a lab ConnectX, real `nvidia-smi -q` from a GPU with genuine
remapped rows, real NCCL timeout traces. This grounds L3 in real distributions, not invented strings.

### 7.3 Making simulated signals faithful (and auditable)

To prevent the simulation from being a giveaway:
1. **Coherence invariants** — a validator asserts cross-signal consistency: if `groundTruth.xid=[48]`
   then dmesg, `nvidia-smi -q` ECC DBE count, DCGM `DCGM_FI_DEV_XID_ERRORS`, and the pod exit code
   must all agree (right GPU index, right timestamps, right counts). Inconsistency = test bug.
2. **Healthy-baseline realism** — every L3 render includes the *non-faulty* entities with realistic
   noise (varying temps, nonzero-but-benign SBE counts, normal util) so the fault doesn't stand out
   as "the only populated field."
3. **No injector tells** — fixtures contain *no* benchmark identifiers, no "INJECTED", no
   `gpu-sregym` strings, no fake-host markers in the *signal payloads* (the namespace name is
   allowed since the agent is told its scope). cf. SREGym hiding the fault plane behind a proxy.
4. **Timestamp jitter** — rendered counters/logs use run-time-relative timestamps, not frozen ones.
5. **Distribution audit** — periodically diff injected counter distributions against the real
   captured fixtures (KS test) to ensure renders stay in-distribution.

### 7.4 Recovery / idempotency

Each problem's `injection.recover` deletes namespace resources, removes node annotations/NPD
conditions, and resets the signal DaemonSet's per-node file. Like SREGym's `recover_fault`, this
must be idempotent and leave no residue (no leftover BPF pins, no stale `NodeCondition`, no
lingering `tc qdisc`). A post-recover health probe asserts the node is clean before the next problem.

---

## 8. Oracles

Two oracles per problem, mirroring SREGym/AIOpsLab: a **diagnosis** oracle (LLM-as-judge
checklist) and a **mitigation** oracle (state-based). E2E success = diagnosis ∧ mitigation.

### 8.1 Diagnosis oracle — 6-dimension checklist (generalizes `judge-llm.mjs`)

Extends the existing 5-dimension judge (localization, mechanism, scope, evidence, remediation)
with a sixth, GPU-specific dimension and entity-level grading. Weighted mean; pass threshold
**0.65** (consistent with the seed cases; tunable). Each dimension = 2 grounded Yes/No questions,
answered by the judge LLM with an evidence quote + confidence (High/Med/Low).

| Dim | Name | Q1 | Q2 |
|---|---|---|---|
| **L** | Localization | Same target resource(s) as ground truth (pod/job/node)? | Avoids blaming a healthy/downstream resource as primary? |
| **M** | Mechanism | Same underlying root cause (not surface symptom)? | States the concrete mutated detail (right failure class)? |
| **S** | Scope | Blast radius consistent with ground truth (single GPU vs node vs fabric vs cluster)? | Avoids materially over/under-stating impact? |
| **E** | Evidence | Cites concrete observed signals (dmesg/`nvidia-smi`/`ibstat`/DCGM/NCCL/scheduler)? | Cited evidence consistent with the named cause (not fabricated)? |
| **R** | Remediation | Recommended fix would actually address the root cause? | Safe + appropriately scoped (no destructive over-reach)? |
| **G** | **GPU-entity correctness (NEW)** | Names the correct **entity** (right GPU index/UUID, IB port, NVLink pair, rail, node)? | Names the correct **error code/class** (right **Xid**, ECC SBE vs DBE, NCCL/`ibv_wc` status, throttle reason)? |

**Hybrid scoring.** Dimension **G** is graded *both* ways and reconciled:
- **Deterministic check** against `groundTruth.entity` and `groundTruth.error_codes` (regex/string
  match for the GPU index, Xid number, `mlx5_0:1`, etc.) → objective, no LLM ambiguity for the
  load-bearing facts.
- **Semantic check** by the judge LLM (handles "GPU 3" vs "the fourth GPU", "double-bit ECC" vs
  "Xid 48 / DBE"). Final G-score = the deterministic check gates, the LLM resolves phrasing.

**Compound handling.** When `num_root_causes > 1`, the judge must find **all** of them; M and G
are scored per-root-cause and averaged, and a "found all causes" boolean is reported (a single-cause
answer to a compound problem caps M at 0.5). This directly tests the SREGym-observed weakness:
"for compound failures, agents tend to draw partial conclusions, missing [causes]."

**Judge prompt** = the existing `judge-llm.mjs` system/user prompts, extended with the G dimension
and the structured `entity`/`error_codes` injected into the ground-truth block. Judge runs at
`temperature=0`. To reduce judge-model bias, the leaderboard reports scores under **≥2 judge
models** (e.g. Claude + a strong open model) and flags any problem where they disagree by >0.15.

### 8.2 Mitigation oracle — state-based (adapted from SREGym `MitigationOracle`)

For agents allowed to act (not read-only), the oracle **probes live environment health** after the
agent submits — never trusting alert-clearing (anti-reward-hacking, §12). GPU-specific predicates
(declared per problem in `groundTruth.remediation.verifiable_state`):

- `node_cordoned(node)` — the faulty node was cordoned / GPU marked unschedulable.
- `gpu_drained(node, gpu_index)` — pods rescheduled off the bad GPU (where MIG/labeling supports it).
- `vcjob_running_and_progressing(job)` — the gang job is Running and its step counter advances
  (probed via training-step metric / log tail) for ≥ T seconds.
- `no_pod_hung(namespace, seconds)` — no pod with zero throughput for `seconds`.
- `forbidden_action_not_taken` — the agent did **not** perform any `destructive_actions_forbidden`
  (checked from the action log; a destructive action **fails** the problem even if health is restored).

Because most GPU-HW faults are **not** software-fixable (you can't `kubectl` away a dead GPU), the
correct mitigation is operational (cordon/drain/requeue/escalate). The oracle credits *operationally
correct containment*, not "make the red light green."

### 8.3 Read-only variant — "recommended remediation correctness"

Siclaw runs agents under a read-only constraint. For read-only mode the mitigation oracle is replaced
by a **recommended-remediation** judge: the agent's *proposed* remediation text is graded by the LLM
judge against `groundTruth.remediation.recommended_actions` (would it fix it? is it safe/scoped? does
it avoid forbidden actions?). This is dimension R, elevated to a gating sub-score, and reported
separately from state-verified mitigation so the two regimes are never conflated.

### 8.4 Inter-evaluator agreement (κ) validation

SREGym validates its judge at **Cohen's κ = 0.90** vs human experts (Sonnet-4.6 vs Human:
Agree 0.95, κ 0.90; judge–judge κ up to 0.94). GPU-SREGym must clear a similar bar *for the new
GPU content*, where the judge LLM may be weaker (GPU/RDMA is more specialized than app faults):
1. **Human gold set** — 3 GPU/RDMA-expert annotators independently grade a stratified sample
   (≥30 problems × ≥3 agent outputs = ≥90 judgments) on the 6-dim checklist.
2. **Report** pairwise inter-human κ, and judge-vs-human κ per dimension. **Target κ ≥ 0.8 overall,
   ≥ 0.7 on the hardest dimension (G).** If G falls short, the deterministic entity/code check
   (which needs no human) carries more weight there.
3. **Calibration loop** — refine question wording / hints (SREGym's exact remedy: "refining checklist
   questions to improve inter-evaluator agreement, grounding the rubric in domain-expert" knowledge)
   until target κ is met; freeze checklist version (e.g. `gpu_rca_checklist v1.0`) and report it with
   every score (as `judge.py` does with `checklist_version`).

---

## 9. Agent interface (MCP)

**Architecture-agnostic, exactly like SREGym** — no assumption about the agent's internals; the
benchmark exposes **MCP servers**. We keep SREGym's five servers and add three GPU-specific ones.
This means any SREGym/AIOpsLab-compatible agent can run GPU-SREGym with minimal changes.

| MCP server | Backed by | Tools (read-only unless noted) | New? |
|---|---|---|---|
| **Metrics** | Prometheus (incl. **dcgm-exporter**) | `prom_query`, `prom_range` (exposes `DCGM_FI_DEV_*`, `node_infiniband_*`) | extends SREGym |
| **Logs** | Loki | `logs_search`, `logs_tail` (incl. **NCCL** logs) | extends SREGym |
| **Traces** | Jaeger | `trace_search` (serving paths; minor for training) | same |
| **Cluster control** | `kubectl` | read subcommands (`get/describe/logs/top/events`), **scheduler objects** (`podgroup`,`queue`,`workload`); mutation only in act-mode | same + scheduler kinds |
| **Submission** | harness | `submit_diagnosis`, `submit_mitigation` → triggers oracles | same |
| **GPU node query (NEW)** | signal DaemonSet | `gpu_smi(node[,gpu])` → `nvidia-smi`/`-q`; `dcgmi(node, group)`; `node_dmesg(node[, grep])` | **new** |
| **RDMA query (NEW)** | signal DaemonSet | `ibstat(node[,hca])`, `ibstatus`, `iblinkinfo`, `perfquery(node,hca,port)`, `ethtool(node,iface[,-S/-m])` | **new** |
| **Scheduler insight (NEW, optional)** | Volcano/Kueue API | `podgroup_status`, `queue_status`, `workload_admission`, `preemption_events` | **new** |

The new GPU/RDMA servers are the mechanism through which **L3 observable-signal injection** (§7.2)
is delivered: in L3 mode they return rendered-from-fixture output; in L0/L1/L2 mode they return the
real tool output. The agent sees one uniform tool surface either way.

**Security note (Siclaw-relevant).** Because these tools execute node-level commands, the production
Siclaw agent runs them under its whitelist/sanitization pipeline. The benchmark harness should treat
the agent as untrusted: the MCP servers themselves enforce read-only (no `kubectl exec`, no
`nvidia-smi -r` GPU reset) except in explicit act-mode problems.

---

## 10. Metrics & evaluation protocol

### 10.1 Primary metrics (per SREGym/AIOpsLab convention)

- **Diagnosis success %** — fraction with judge composite ≥ 0.65.
- **Mitigation success %** — fraction where the state-based oracle passes (act-mode only).
- **E2E success %** — `P(Diagnosis ∧ Mitigation)` (the SREGym headline metric).
- **Recommended-remediation %** — read-only-mode substitute for mitigation (§8.3).
- **Diagnosis composite score** (mean of the 6-dim weighted score) and **per-dimension means**
  (L/M/S/E/R/G) — surfaces *where* agents fail (we expect G and M to be the hardest, mirroring the
  Siclaw result where compound cases scored lowest).

### 10.2 Latency metrics

- **TTD** (Time-to-Detect) and **TTM** (Time-to-Mitigate) — from AIOpsLab.
- **Wall-clock per case** and **# tool calls** / **# tokens** (cost-efficiency; SREGym shows tokens
  do *not* predict success — we replicate that analysis).

### 10.3 GPU-specific correctness metrics (NEW)

- **Xid→GPU mapping accuracy** — % of GPU-HW problems where the agent named the correct GPU index/UUID
  *and* the correct Xid (deterministic check from dimension G).
- **Bad-link identification accuracy** — % of RDMA problems where the agent named the correct HCA+port
  (e.g. `mlx5_0:1`) / NVLink pair / rail.
- **Error-class accuracy** — SBE-vs-DBE, link-flap-vs-PFC-storm-vs-QP-error confusion matrix.
- **Compound recall** — for C6, mean fraction of root causes found (tests partial-conclusion failure).

### 10.4 Robustness

- **Noise robustness** — rerun a subset with SREGym-style noise injectors active (unrelated pod
  restarts, background load, irrelevant warnings, extra healthy-but-noisy GPU counters) and report the
  **Δ** in diagnosis/E2E (SREGym sees up to 40% E2E differences; we expect GPU diagnosis to be
  noise-sensitive because the agent must isolate one bad GPU among many).
- **Distractor robustness** — include a *healthy* second anomaly-looking signal (e.g. a benign SBE
  count on a different GPU) and check the agent doesn't misattribute.

### 10.5 Statistical protocol (per Zhu et al. 2025)

- **Multi-run**: each (agent, problem) run **k ≥ 3** times (SREGym uses 3); report mean and
  **bootstrap 95% CI** (or Wilson interval for pass rates).
- **Report variance**, not just point estimates; never claim an improvement without overlapping-CI
  analysis or a paired test.
- **Fixed seeds** for noise injection and timestamp jitter, recorded per run for reproducibility.
- **Judge robustness**: report under ≥2 judge models; flag high-disagreement problems.
- **No survivorship bias**: count crashed/timed-out agent runs as failures (SREGym's explicit policy),
  not "excluded."

### 10.6 Difficulty tiers

| Tier | Definition | Example |
|---|---|---|
| **easy** | single fault, single dominant signal, no distractor | device-plugin CrashLoop → allocatable 0 |
| **medium** | single fault but symptom ≠ cause, or requires correlating 2 surfaces | thermal throttle presenting as OOM |
| **hard** | compound / intermittent / silent / cross-layer | g09 ECC+PFC; SDC; straggler barrier timeout |

Report all metrics **broken down by tier and by category**, and provide **difficulty-balanced** and
**category-balanced** splits.

### 10.7 Splits

- **dev** (~20%, ≈24 problems): for agent development & judge calibration; ground truth fully public.
- **test** (~80%, ≈96 problems): leaderboard; ground truth held in the harness (released, but the
  leaderboard uses the harness so submissions can't peek — see §11).
- Also expose **by-difficulty** and **by-category** configs (HF dataset configs, §11).

---

## 11. HuggingFace packaging

GPU-SREGym ships as (a) a **dataset** (problem instances + fixtures) and (b) an **eval harness**
(injector + MCP + oracles, dockerized), with a **Gradio Space leaderboard** — matching how modern
agentic benchmarks (SWE-bench, GAIA, Terminal-Bench, τ-bench, BIRD) are published.

### 11.1 Repository layout

```
huggingface.co/datasets/siclaw/gpu-sregym
├── README.md                      # dataset card (YAML frontmatter below)
├── data/
│   ├── dev.jsonl                  # task instances (split=dev)
│   ├── test.jsonl                 # task instances (split=test)
│   └── problems.parquet           # same, columnar (for `datasets` fast load)
├── fixtures/                      # per-problem signal fixtures (dmesg, ibstat, nccl, prom series)
│   └── g04/{dmesg.txt,ibstat.txt,ethtool_mlx5_0.txt,nccl.log,series.json}
├── croissant.json                 # ML Croissant metadata
└── LICENSE

github.com/siclaw/gpu-sregym       # the harness (code can't live in HF dataset repo)
├── injector/                      # L0–L3 injection (chaos-mesh, tc, renderers, signal DaemonSet)
├── mcp_servers/                   # metrics/logs/traces/kubectl/submission + gpu/rdma/scheduler
├── oracles/                       # 6-dim judge + state-based mitigation + entity/code checker
├── harness/                       # run loop, k-repeat, CI computation
├── leaderboard/                   # Gradio Space app + submission verifier
└── images/                        # Dockerfiles for reproducible env + agent runners
```

### 11.2 Dataset card (`README.md`) YAML frontmatter

```yaml
---
license: apache-2.0
language:
  - en
pretty_name: "GPU-SREGym: SRE Agent Benchmark for Kubernetes GPU/AI Clusters"
tags:
  - sre
  - aiops
  - agents
  - kubernetes
  - gpu
  - rdma
  - nccl
  - llm-evaluation
  - benchmark
task_categories:
  - other            # (no native "agentic-ops" category; use 'other' + tags, like SWE-bench)
size_categories:
  - n<1K
source_datasets:
  - original
annotations_creators:
  - expert-generated
configs:
  - config_name: default
    data_files:
      - split: dev
        path: data/dev.jsonl
      - split: test
        path: data/test.jsonl
  - config_name: by_category
    data_files:
      - split: gpu_hardware
        path: data/by_category/gpu_hardware.jsonl
      - split: rdma_network
        path: data/by_category/rdma_network.jsonl
      # ... gang_scheduling, distributed_training, gpu_controlplane, compound, storage_io
  - config_name: by_difficulty
    data_files:
      - split: easy
        path: data/by_difficulty/easy.jsonl
      - split: medium
        path: data/by_difficulty/medium.jsonl
      - split: hard
        path: data/by_difficulty/hard.jsonl
extra_gated_fields: {}     # NOT gated; but see §11.6 on test-label handling
---
```

Body of the card (below the frontmatter) follows the HF dataset-card guide and includes: dataset
summary, the §5 taxonomy table, the §6 schema, **how to run the harness** (you do *not* evaluate by
string-matching the JSONL; you stand up the env and let the agent diagnose), supported splits, the
leaderboard link, licensing, citation (BibTeX), known limitations (§12), and a `croissant` link.

### 11.3 Task-instance JSONL schema (HF-facing, flattened from §6)

```jsonc
{"instance_id": "gpu-sregym__g04",
 "category": "rdma-network", "difficulty": "hard",
 "task_type": ["diagnosis","mitigation"],
 "symptom": "...", "namespace": "gpu-sregym-eval", "targets": ["pod/g04-rdma-flap"],
 "ground_truth": { /* §6 groundTruth, including entity + error_codes */ },
 "injection_ref": "fixtures/g04", "split": "test",
 "grounded_in": ["cui2025gpuresilience","ghorbani2025rdma","lin2025shift"]}
```

(Mirrors SWE-bench's `instance_id` convention; the *evaluation* is environment-based, the JSONL is
the manifest the harness consumes.)

### 11.4 Eval-harness design (dockerized, reproducible)

- **Two ways to run** (à la SWE-bench / Terminal-Bench):
  1. **Live mode** — point the harness at a real K8s cluster (with ≥1 GPU node for L0/L1/L2 problems);
     L3 problems run on *any* cluster (signals are injected). Per problem: `inject → agent(MCP) →
     submit → oracle → recover`.
  2. **Replay/CI mode** — a fully containerized **kind**-based cluster (SREGym ships `kind/` configs)
     with the signal DaemonSet, so the *L3-only* subset runs with **no GPU hardware at all** — this
     is the key reproducibility win and the default for the public leaderboard.
- **Determinism**: pinned container images (digests), pinned chaos-mesh/Volcano/Kueue versions,
  recorded seeds. A `make reproduce INSTANCE=g04` re-runs one case.
- **Agent contract**: agent connects to the MCP endpoints the harness prints; submits via the
  Submission server. Reference agent runners provided for SREGym-style clients (Claude Code, a generic
  MCP ReAct agent), reusing SREGym's `clients/` pattern.

### 11.5 Leaderboard (Gradio Space)

- **HF Space** (Gradio), like GAIA / τ-bench leaderboards. Columns: agent, model, Diag%, Mitig%/
  Rec-Remed%, E2E%, per-category E2E, Xid→GPU acc, bad-link acc, mean tokens, mean TTM, CI.
- **Submission flow**: contributor runs the harness (live or CI mode) → harness emits a signed
  `submission.json` (per-instance scores + full agent trajectories + tool logs) → uploaded to a
  gated submissions dataset → an automated **verifier** re-scores the *diagnosis text* with the
  reference judge (so contributors can't inflate by swapping the judge) and recomputes pass rates
  before the row appears. Trajectories are published for auditability.
- **Two tracks**: **read-only (diagnosis + recommended-remediation)** and **act (E2E)**.

### 11.6 Licensing & reproducibility

- **Code (harness, injector, MCP, oracles):** Apache-2.0 (matches SREGym's `LICENSE.txt`).
- **Data (problems, fixtures):** Apache-2.0 or CC-BY-4.0; fixtures captured from real hardware are
  **redacted** (no serials, MACs, hostnames, internal IPs).
- **Test labels:** ground truth is *released* (open science) but the **leaderboard is harness-mediated**
  so a submitted agent never receives the labels at run time; contamination risk is managed by (a)
  versioning the test set, (b) keeping a small **held-out hidden extension** rotated each release for
  spot-checking, and (c) timestamping submissions.
- **Reproducibility manifest:** every release pins image digests, dependency lockfile (`uv.lock`-style),
  chaos-mesh/Volcano/Kueue/NCCL/driver versions, and the judge model+checklist version.

---

## 12. Anti-reward-hacking & limitations

### 12.1 Anti-reward-hacking (following SREGym + Zhu et al. 2025)

SREGym documents two concrete exploits we must defend against, plus we add GPU-specific ones:

1. **Disabling the fault injector** — SREGym notes AIOpsLab/ITBench run injectors as *identifiable
   pods the agent can see and kill*. **Defense:** GPU-SREGym's signal-injection plane (the rendering
   layer + signal DaemonSet) is **not addressable by the agent** — it's not in the agent's namespace,
   its pods are unlabeled/looped behind the MCP servers, and the MCP read-only contract prevents
   deleting it. There is *always a real defect or a coherent fault state* to reason about; "stop the
   injector" is not reachable.
2. **Alert-clearing as success** — Stratus reports 44% of ITBench mitigations are "solved" by a generic
   pod-restart loop (the injector loses the pod, the alert clears). **Defense:** mitigation is judged
   by **state-based health probes** (training step advancing, no hung pod, node cordoned), never by
   alert suppression. For GPU-HW faults, a pod restart **cannot** fix a dead GPU, so the restart-loop
   exploit yields a still-failing state.
3. **GPU-specific: "restart until it lands on a good GPU"** — an agent could blindly delete the pod
   until the scheduler avoids the bad GPU, masking the fault without diagnosing it. **Defense:** (a)
   the *diagnosis* oracle independently requires naming the correct GPU/Xid (dimension G) — a lucky
   reschedule scores 0 on diagnosis; (b) the mitigation oracle credits *containment* (cordon/drain of
   the bad GPU), and a problem can mark "uncontained reschedule" as `forbidden` so masking fails.
4. **Forbidden-action gating** — performing any `destructive_actions_forbidden` (delete data PVC,
   `drain` without review, GPU reset that "fixes" the injected counter) **fails** the problem
   regardless of resulting health (outcome *and* process validity).
5. **Judge-gaming** — the agent cannot influence which judge runs (harness-side, ≥2 models), and the
   leaderboard verifier re-scores from raw trajectories. Checklist questions are grounded in structured
   ground truth (entity/codes), so keyword-stuffing the right Xid inside a wrong mechanism scores No on
   M (the judge grades *substance*, per `judge-llm.mjs` design).
6. **Outcome vs. solution validity** (Zhu et al.) — diagnosis is graded on **substance + cited
   evidence** (dim E requires evidence *consistent* with the cause); mitigation on **verified state**.
   We avoid pure outcome checks that a shortcut could satisfy.

### 12.2 Construct-validity safeguards

- **Faithful signals** (§7.3): coherence invariants, real-hardware-captured fixtures, healthy
  baselines with noise, no injector tells, timestamp jitter. The threat is an agent that learns "the
  populated field is the answer"; healthy-baseline realism + distractors blunt it.
- **κ-validated judge** (§8.4): the diagnosis metric is only trustworthy if the judge agrees with
  human experts on GPU content; we gate release on κ targets and fall back to deterministic
  entity/code checks where κ is weak.
- **No solvable-by-coincidence problems**: every problem must require *some* GPU/RDMA-specific reasoning;
  a pre-merge check confirms a "kubectl-only, no GPU tools" baseline agent scores below a floor (e.g.
  <0.3 composite) on it (otherwise it's a generic K8s problem belonging in SREGym, not here).

### 12.3 Limitations (stated plainly, per rigor norms)

- **L3 is simulation.** Observable-signal injection is faithful *at the diagnostic interface* but does
  not reproduce timing-level hardware behavior (e.g. exact ECC-scrubber latency, real DCQCN dynamics).
  It tests *diagnosis from telemetry*, not closed-loop hardware control. Problems requiring true
  hardware dynamics are out of scope or restricted to L0–L2.
- **Mitigation realism is bounded.** Many real GPU-HW remediations (RMA, reseat, BIOS/firmware) cannot
  be executed in software; the oracle credits operational containment, which is a proxy for the
  full real-world resolution.
- **Single-cluster topology** (inherited Siclaw limitation): one reference topology (rail-optimized,
  N GPU nodes); cross-topology generalization is future work.
- **Distributed-training faults at scale** are approximated with small jobs (`nccl-tests`/stub) plus
  injected logs; we do not run 1000-GPU jobs. The benchmark tests *diagnosis of the symptom pattern*,
  not the original at-scale event.
- **Judge-model dependence**: scores shift with judge model; we mitigate with multi-judge reporting +
  deterministic entity/code grading, but absolute composite scores are not cross-paper-comparable
  unless the same judge+checklist version is used.
- **Coverage is v1**: ~120 problems is small vs SREGym's 3,623 fault×target combinatorial space;
  the framework is built for continuous addition, and the combinatorial multiplier (faults ×
  GPU/node/port targets) is the growth path.

---

## Appendix A
### A.1 Xid quick reference (re-verify against `docs.nvidia.com/deploy/xid-errors`) `[verify]`
See §3.4 table. Load-bearing for dimension G: **48** (DBE, fatal), **63/64** (row-remap recorded/failed),
**74** (NVLink), **79** (off-the-bus), **92** (SBE high), **94/95** (contained/uncontained ECC),
**119/120** (GSP). Common agent confusions to grade strictly: 48 vs 94/95; 13/31/43 (app) vs true HW.

### A.2 DCGM field names (re-verify against the DCGM API reference) `[verify]`
`DCGM_FI_DEV_GPU_TEMP`, `DCGM_FI_DEV_POWER_USAGE`, `DCGM_FI_DEV_SM_CLOCK`,
`DCGM_FI_DEV_ECC_SBE_VOL_TOTAL`, `DCGM_FI_DEV_ECC_DBE_VOL_TOTAL`,
`DCGM_FI_DEV_ECC_SBE_AGG_TOTAL`, `DCGM_FI_DEV_ECC_DBE_AGG_TOTAL`,
`DCGM_FI_DEV_ROW_REMAP_PENDING`, `DCGM_FI_DEV_ROW_REMAP_FAILURE`,
`DCGM_FI_DEV_XID_ERRORS`, `DCGM_FI_DEV_CLOCK_THROTTLE_REASONS`,
`DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT_TOTAL`, `DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL`,
`DCGM_FI_DEV_GPU_UTIL`, `DCGM_FI_DEV_FB_USED`/`_FREE`.

### A.3 NCCL error patterns (re-verify against NCCL docs) `[verify]`
- Timeout/watchdog: `NCCL WARN ... Timeout(ms)=...`, `[Rank N] Watchdog ... timeout`,
  PyTorch `torch.distributed` `Watchdog caught collective operation timeout`.
- Transport: `NCCL INFO NET/IB : ...` (RDMA) vs `NET/Socket` (TCP fallback) vs `Channel.. via P2P/NVLink`.
- Async error: `ncclInternalError`, `ncclUnhandledCudaError`, `ncclRemoteError`.
- QP/IB: `IBV_WC_RETRY_EXC_ERR`, `IBV_WC_RNR_RETRY_EXC_ERR`, `transport retry counter exceeded`.

### A.4 RDMA tool outputs to render
`ibstat` (port state Active/Down/Polling, rate, base lid), `ibstatus`, `iblinkinfo`/`ibnetdiscover`
(topology, mis-cabling), `perfquery` (PortXmitDiscards, symbol errors, PortRcvErrors),
`ethtool -S` (`rx_pause`/`tx_pause`, `rx_pfc_*`, `*_fec_*`, `*_symbol_err*`), `ethtool -m` (transceiver
diagnostics for dirty/failing optics).

---

## Appendix B — Build plan / milestones

| Milestone | Deliverable | Reuses |
|---|---|---|
| **M0 Schema + 10 seed** | §6 schema; migrate `gpu-rdma-cases.json` (g01–g10) into it; validator + coherence checker | existing cases, `judge-llm.mjs` |
| **M1 L3 injection substrate** | signal DaemonSet, faithful renderers (`nvidia-smi`/`dcgmi`/`ibstat`/`ethtool`), NCCL-log pods, Prom series server; recover/idempotency | SREGym `kind/`, manifests |
| **M2 GPU/RDMA MCP servers** | `gpu-query`, `rdma-query`, scheduler-insight; wire into SREGym MCP set | SREGym `mcp_server/` |
| **M3 6-dim oracle** | extend judge to 6 dims + deterministic entity/code checker; state-based GPU mitigation oracle | `judge-llm.mjs`, SREGym `MitigationOracle` |
| **M4 Fill taxonomy → ~120** | author C1–C7 problems to target counts (§4.2); capture real fixtures | §5 |
| **M5 κ validation** | human gold-set annotation; tune checklist to κ targets; freeze `v1.0` | §8.4 |
| **M6 HF + leaderboard** | dataset card, JSONL/parquet, croissant, dockerized harness (kind CI mode), Gradio Space + verifier | §11 |
| **M7 Baselines** | run Claude Code / generic MCP ReAct / Siclaw; report all metrics with CIs | §10 |

---

### Citation anchors (from Siclaw `references.bib`, primary sources)
- **SREGym** — Clark et al., 2026 (`clark2026sregym`).
- **AIOpsLab** — Chen et al., MLSys 2025 (`chen2025aiopslab`).
- **ITBench** — Jha et al., ICML 2025 (`jha2025itbench`).
- **OpenRCA** — Xu et al., ICLR 2025 (`xu2025openrca`).
- **Cloud-OpsBench** — Wang et al., 2026 (`wang2026cloudopsbench`).
- **Flow-of-Action** — Pei et al., WWW 2025 (`pei2025flowofaction`).
- **GPU resilience / Xid characterization** — Cui et al., 2025, arXiv:2503.11901 (`cui2025gpuresilience`).
- **RDMA congestion** — Ghorbani et al., IMC 2025 (`ghorbani2025rdma`).
- **SHIFT (RDMA QP resilience)** — Lin et al., 2025, arXiv:2512.11094 (`lin2025shift`).
- **ByteRobust** — Wan et al., SOSP 2025 (`wan2025byterobust`).
- **Holmes (silent irregularities)** — Yao et al., NSDI 2025 (`yao2025holmes`).
- **Fault-injection survey** — Yu et al., TOSEM (`yu2024fisurvey`).
- **Rigorous agentic benchmarks** — Zhu et al., 2025, **arXiv:2507.02825**, "Establishing Best
  Practices for Building Rigorous Agentic Benchmarks," **NeurIPS 2025 Datasets & Benchmarks Track**
  (introduces the *Agentic Benchmark Checklist* / ABC). [verified 2026-06]. Also cited by SREGym [92].
- **Xid taxonomy** — verified 2026-06 against docs.nvidia.com/deploy/xid-errors and the NVIDIA GPU
  Debug Guidelines (Xid 48/63/64/74/79/92/94/95 confirmed; 63/64 are generation-dependent —
  legacy=ECC page retirement, A100+=row-remap recorded/failed).
- **HF dataset cards** — huggingface.co/docs/hub/datasets-cards (verified live).
