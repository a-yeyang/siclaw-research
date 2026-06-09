#!/usr/bin/env node
/**
 * AAAI Paper Experiment: GPU/RDMA Observable-Signal Fault Scenarios
 *
 * 10 cases simulating GPU hardware and RDMA network faults through
 * Kubernetes-observable signals (Events, Conditions, Pod Status, Labels,
 * ConfigMaps with simulated telemetry logs).
 *
 * Research basis:
 *   - Cui et al. (2025) "Characterizing GPU Resilience" — Xid 48/31/94/95, NVLink errors, ECC
 *   - Kokolis et al. (2024, Meta) — MTTF at scale, GPU failure modes
 *   - ByteRobust (SOSP'25) — production GPU failure taxonomy
 *   - Ghorbani et al. (IMC'25) — RDMA datacenter congestion patterns
 *   - SHIFT (2025) — RDMA failover trilemma
 *   - Holmes (NSDI'25) — silent irregularity localization via NCCL traces
 *
 * Approach: "Observable-signal simulation" — inject the signals an SRE agent
 * would see (Events, logs in ConfigMaps, node conditions, pod annotations),
 * not the hardware faults themselves. This is consistent with the agent's
 * diagnostic interface: it reads kubectl output, not hardware registers.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const NS = "siclaw-eval-gpu-rdma";
const RUN = "20260604";
const LABEL_RUN = "siclaw.ai/eval-run";

function labels(caseId, extra = {}) {
  return { [LABEL_RUN]: RUN, "siclaw.ai/eval-case": caseId, ...extra };
}
function meta(name, caseId, extra = {}) {
  return { name, namespace: NS, labels: labels(caseId, extra) };
}

// ── Helper: ConfigMap with simulated telemetry/log output ──────────
function telemetryConfigMap(caseId, name, data) {
  return {
    apiVersion: "v1", kind: "ConfigMap",
    metadata: meta(name, caseId),
    data,
  };
}

// ── Helper: Pod with GPU resource request ──────────────────────────
function gpuPod(caseId, name, spec) {
  return {
    apiVersion: "v1", kind: "Pod",
    metadata: {
      ...meta(name, caseId, spec.extraLabels || {}),
      annotations: spec.annotations || {},
    },
    spec: {
      restartPolicy: spec.restartPolicy || "Never",
      schedulerName: spec.schedulerName || "default-scheduler",
      nodeSelector: spec.nodeSelector || { "scitix.ai/gpu-type": "h20nvlink141" },
      tolerations: spec.tolerations || [],
      containers: spec.containers,
      ...(spec.volumes ? { volumes: spec.volumes } : {}),
    },
  };
}

// ── Helper: Volcano Job ───────────────────────────────────────────
function volcanoJob(caseId, name, specPatch) {
  return {
    apiVersion: "batch.volcano.sh/v1alpha1", kind: "Job",
    metadata: meta(name, caseId),
    spec: {
      schedulerName: "volcano", queue: "default",
      minAvailable: 1, maxRetry: 0,
      tasks: [{
        replicas: 1, name: "trainer",
        template: {
          spec: {
            restartPolicy: "Never",
            containers: [{
              name: "trainer",
              image: "busybox:1.36",
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-c", "echo trainer; sleep 3600"],
              resources: { requests: { cpu: "20m", memory: "32Mi" }, limits: { cpu: "50m", memory: "64Mi" } },
            }],
          },
        },
      }],
      ...specPatch,
    },
  };
}

// ════════════════════════════════════════════════════════════════════
//  10 GPU/RDMA Fault Cases
// ════════════════════════════════════════════════════════════════════

const cases = [];
const manifests = [];

// ────────────────────────────────────────────────────────────────────
// G01: GPU Xid 48 (Double-Bit ECC Error) — uncorrectable memory error
// Reference: Cui et al. (2025) — 90% job failure probability for Xid 48
// ────────────────────────────────────────────────────────────────────
cases.push({
  id: "g01", category: "gpu-hardware", difficulty: "hard",
  title: "GPU Xid 48 double-bit ECC error causing training crash",
  targets: ["pod/g01-training-xid48"],
  symptom: "GPU training pod g01-training-xid48 crashed with exit code 134 (SIGABRT). The pod was running a multi-GPU training job on node fake-node-105.",
  groundTruth: {
    localization: "pod/g01-training-xid48 on node fake-node-105",
    mechanism: "GPU 3 on node fake-node-105 experienced Xid 48 (Double-Bit ECC / DBE uncorrectable memory error), corrupting GPU memory and triggering a CUDA illegal memory access fatal error. The Xid 48 error indicates a hardware-level uncorrectable memory fault (two bits flipped in the same memory word). This requires GPU replacement or row remapping.",
    scope: "Single GPU (GPU 3) on fake-node-105; affects all pods using that GPU. Node should be cordoned for GPU health check.",
  },
  expectedSignals: ["dmesg xid log", "nvidia-smi ecc errors", "cuda error", "pod exit code", "node events"],
});
manifests.push(
  telemetryConfigMap("g01", "g01-node-dmesg", {
    "dmesg.log": [
      "[1234567.890] NVRM: Xid (PCI:0000:3b:00): 48, pid=18234, name=python3, Ch 00000010, intr 00000000, 0000 00000000 00000000",
      "[1234567.891] NVRM: GPU at PCI:0000:3b:00 has fallen off the bus.",
      "[1234567.892] NVRM: GPU 0000:3b:00.0: GPU has been lost; attempting recovery...",
      "[1234570.100] NVRM: Xid (PCI:0000:3b:00): 31, pid=18234, name=python3, Ch 00000010, intr 00000000 (MMU fault)",
    ].join("\n"),
  }),
  telemetryConfigMap("g01", "g01-nvidia-smi", {
    "nvidia-smi-output.txt": [
      "+-----------------------------------------------------------------------------------------+",
      "| NVIDIA-SMI 550.127.05   Driver: 550.127.05   CUDA: 12.4                                |",
      "|   GPU 0: NVIDIA H100 80GB HBM3 ... Temp: 42C  Power: 310W/700W  Util: 0%  Mem: 0MiB/81559MiB",
      "|   GPU 1: NVIDIA H100 80GB HBM3 ... Temp: 45C  Power: 320W/700W  Util: 0%  Mem: 0MiB/81559MiB",
      "|   GPU 2: NVIDIA H100 80GB HBM3 ... Temp: 43C  Power: 315W/700W  Util: 0%  Mem: 0MiB/81559MiB",
      "|   GPU 3: NVIDIA H100 80GB HBM3 ... Temp: 89C  Power: ERR!/700W  Util: ERR!  Mem: ERR!/81559MiB  <<< FAILED",
      "|   GPU 4-7: OK",
      "+-----------------------------------------------------------------------------------------+",
      "| ECC Errors:                                                                             |",
      "|   GPU 3: Volatile Double-Bit: 3   Aggregate Single-Bit: 47   Row Remap: FAILED         |",
      "|   GPU 0-2,4-7: Volatile Double-Bit: 0   Aggregate Single-Bit: 0-2                      |",
      "+-----------------------------------------------------------------------------------------+",
    ].join("\n"),
  }),
  gpuPod("g01", "g01-training-xid48", {
    annotations: {
      "siclaw.ai/crash-reason": "CUDA error: an illegal memory access was encountered (Xid 48 → GPU 3 DBE)",
      "siclaw.ai/last-log": "RuntimeError: CUDA error: an illegal memory access was encountered\nCUDA kernel errors might be asynchronously reported at some other API call",
    },
    containers: [{
      name: "trainer", image: "busybox:1.36", imagePullPolicy: "IfNotPresent",
      command: ["sh", "-c", "exit 134"], // SIGABRT
      resources: { requests: { "nvidia.com/gpu": "4", cpu: "80", memory: "512Gi" }, limits: { "nvidia.com/gpu": "4" } },
    }],
  }),
);

// ────────────────────────────────────────────────────────────────────
// G02: NVLink Degradation — GPU-to-GPU interconnect failure
// Reference: Cui et al. (2025) — 1,922 NVLink errors on A100; single degraded link drops throughput 40%
// ────────────────────────────────────────────────────────────────────
cases.push({
  id: "g02", category: "gpu-hardware", difficulty: "hard",
  title: "NVLink degradation causing training slowdown",
  targets: ["pod/g02-nvlink-slow"],
  symptom: "GPU training pod g02-nvlink-slow is running but training throughput has dropped by approximately 40%. The job has not crashed but iteration time increased from 2.3s to 3.8s. Pod is on node fake-node-105.",
  groundTruth: {
    localization: "pod/g02-nvlink-slow on node fake-node-105, NVLink between GPU 2 and GPU 3",
    mechanism: "NVLink connection between GPU 2 and GPU 3 has degraded from NVLink speed (450 GB/s per direction) to PCIe fallback speed (64 GB/s). nvidia-smi topo shows the link as 'PIX' instead of 'NV18'. The NCCL allreduce operations fall back to PCIe path, reducing collective communication throughput and causing ~40% training slowdown.",
    scope: "All multi-GPU jobs using GPU 2-3 pair on this node are affected. Single-GPU jobs unaffected.",
  },
  expectedSignals: ["nvidia-smi topo", "nvlink error counter", "nccl log", "training throughput"],
});
manifests.push(
  telemetryConfigMap("g02", "g02-nvidia-topo", {
    "nvidia-smi-topo.txt": [
      "        GPU0  GPU1  GPU2  GPU3  GPU4  GPU5  GPU6  GPU7",
      "GPU0     X    NV18  NV18  NV18  NV18  NV18  NV18  NV18",
      "GPU1    NV18   X    NV18  NV18  NV18  NV18  NV18  NV18",
      "GPU2    NV18  NV18   X    PIX   NV18  NV18  NV18  NV18   <<< DEGRADED: GPU2-GPU3 fell to PCIe",
      "GPU3    NV18  NV18  PIX    X    NV18  NV18  NV18  NV18   <<< DEGRADED: GPU3-GPU2 fell to PCIe",
      "GPU4    NV18  NV18  NV18  NV18   X    NV18  NV18  NV18",
      "GPU5    NV18  NV18  NV18  NV18  NV18   X    NV18  NV18",
      "GPU6    NV18  NV18  NV18  NV18  NV18  NV18   X    NV18",
      "GPU7    NV18  NV18  NV18  NV18  NV18  NV18  NV18   X",
    ].join("\n"),
    "nvlink-errors.txt": "GPU 2 → GPU 3 (Link 3): CRC Errors: 14832, Replay Errors: 2491, Recovery Count: 87\nGPU 3 → GPU 2 (Link 3): CRC Errors: 14710, Replay Errors: 2388, Recovery Count: 85\nAll other links: CRC Errors: 0, Replay Errors: 0",
  }),
  telemetryConfigMap("g02", "g02-nccl-log", {
    "nccl-debug.log": [
      "fake-node-105:18234:18234 [2] NCCL WARN NET/IB : GPU 2 → GPU 3 NVLink path unavailable, falling back to PCIe",
      "fake-node-105:18234:18234 [2] NCCL INFO Ring 0: GPU 2 → GPU 3 path: PIX (was NV18)",
      "fake-node-105:18234:18234 [2] NCCL WARN allReduce bandwidth dropped: 380 GB/s → 52 GB/s on ring 0",
    ].join("\n"),
  }),
  gpuPod("g02", "g02-nvlink-slow", {
    annotations: {
      "siclaw.ai/status": "running-degraded",
      "siclaw.ai/symptom": "Training throughput dropped ~40%. Iteration time 2.3s→3.8s. No crash.",
    },
    containers: [{
      name: "trainer", image: "busybox:1.36", imagePullPolicy: "IfNotPresent",
      command: ["sh", "-c", "echo running-degraded; sleep 3600"],
      resources: { requests: { "nvidia.com/gpu": "8", cpu: "160", memory: "1Ti" }, limits: { "nvidia.com/gpu": "8" } },
    }],
  }),
);

// ────────────────────────────────────────────────────────────────────
// G03: GPU Thermal Throttling — overheating reduces effective clock speed
// Reference: Industry practice — thermal throttle at ~105C, VRAM overheating reduces effective capacity
// ────────────────────────────────────────────────────────────────────
cases.push({
  id: "g03", category: "gpu-hardware", difficulty: "medium",
  title: "GPU thermal throttling causing CUDA OOM",
  targets: ["pod/g03-thermal-oom"],
  symptom: "GPU training pod g03-thermal-oom crashes with CUDA out-of-memory error, but the model should fit in 80GB VRAM. Pod is on node fake-node-105.",
  groundTruth: {
    localization: "pod/g03-thermal-oom on node fake-node-105, GPU 6",
    mechanism: "GPU 6 temperature reached 103C, triggering thermal throttling that reduces effective VRAM capacity. nvidia-smi shows GPU 6 at 103C with power throttle reason 'HW Thermal Slowdown Active'. The thermal throttling reduces available memory bandwidth, causing the CUDA memory allocator to fail despite nominal 80GB capacity. Root cause is likely inadequate cooling (blocked airflow or fan failure).",
    scope: "Single GPU (GPU 6). Other GPUs on the node at normal temperature (42-55C).",
  },
  expectedSignals: ["nvidia-smi temperature", "power throttle reason", "cuda oom error"],
});
manifests.push(
  telemetryConfigMap("g03", "g03-nvidia-smi", {
    "nvidia-smi-query.txt": [
      "GPU 0: 42C, 310W/700W, Util 95%, Mem 71234/81559 MiB, Throttle: None",
      "GPU 1: 45C, 320W/700W, Util 94%, Mem 71234/81559 MiB, Throttle: None",
      "GPU 2: 43C, 315W/700W, Util 95%, Mem 71234/81559 MiB, Throttle: None",
      "GPU 3: 44C, 312W/700W, Util 94%, Mem 71234/81559 MiB, Throttle: None",
      "GPU 4: 46C, 325W/700W, Util 95%, Mem 71234/81559 MiB, Throttle: None",
      "GPU 5: 48C, 330W/700W, Util 94%, Mem 71234/81559 MiB, Throttle: None",
      "GPU 6: 103C, 250W/700W, Util 12%, Mem 71234/81559 MiB, Throttle: HW Thermal Slowdown Active  <<< OVERHEATING",
      "GPU 7: 55C, 340W/700W, Util 95%, Mem 71234/81559 MiB, Throttle: None",
    ].join("\n"),
  }),
  gpuPod("g03", "g03-thermal-oom", {
    annotations: {
      "siclaw.ai/crash-reason": "RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB. GPU 6 has 79.14 GiB capacity with only 1.82 GiB free.",
      "siclaw.ai/exit-code": "1",
    },
    containers: [{
      name: "trainer", image: "busybox:1.36", imagePullPolicy: "IfNotPresent",
      command: ["sh", "-c", "exit 1"],
      resources: { requests: { "nvidia.com/gpu": "8", cpu: "160", memory: "1Ti" }, limits: { "nvidia.com/gpu": "8" } },
    }],
  }),
);

// ────────────────────────────────────────────────────────────────────
// G04: RDMA Link Flap — InfiniBand port toggling causes NCCL timeout
// Reference: Varuna (2025) — 5,000–60,000 link flaps/day at Alibaba 15k-GPU cluster
// ────────────────────────────────────────────────────────────────────
cases.push({
  id: "g04", category: "rdma-network", difficulty: "hard",
  title: "RDMA link flap causing NCCL allreduce timeout",
  targets: ["pod/g04-rdma-flap"],
  symptom: "Distributed training pod g04-rdma-flap hangs at NCCL allreduce and eventually times out. The training was running across 2 nodes (fake-node-105 and fake-node-106) using RDMA/RoCEv2.",
  groundTruth: {
    localization: "pod/g04-rdma-flap on fake-node-105, RDMA HCA mlx5_0 port 1",
    mechanism: "InfiniBand port mlx5_0:1 on fake-node-105 is experiencing link flapping (state toggling between Active and Down). ibstat shows port state 'Polling' (attempting to re-establish link). The physical link recovers and drops repeatedly (43 state changes in 10 minutes), causing in-flight RDMA operations to fail and NCCL to timeout waiting for allreduce completion. Root cause: likely a damaged optical cable or dirty transceiver on that port.",
    scope: "All inter-node RDMA communication involving fake-node-105 port mlx5_0:1. Intra-node NVLink communication is unaffected. Multi-node training jobs using this node will hang.",
  },
  expectedSignals: ["ibstat port state", "link flap count", "nccl timeout", "dmesg rdma"],
});
manifests.push(
  telemetryConfigMap("g04", "g04-ibstat", {
    "ibstat.txt": [
      "CA 'mlx5_0'",
      "  Port 1:",
      "    State: Polling    <<< NOT Active — link trying to re-establish",
      "    Physical state: LinkUp/Polling (flapping)",
      "    Rate: 200 Gb/sec (4X HDR)",
      "    Link layer: InfiniBand",
      "    SM lid: 0   (no subnet manager reachable during flap)",
      "  Port 2:",
      "    State: Active",
      "    Physical state: LinkUp",
      "    Rate: 200 Gb/sec (4X HDR)",
    ].join("\n"),
    "dmesg-rdma.txt": [
      "[1234500.100] mlx5_core 0000:3b:00.0: Port 1: Link Up",
      "[1234502.340] mlx5_core 0000:3b:00.0: Port 1: Link Down",
      "[1234504.890] mlx5_core 0000:3b:00.0: Port 1: Link Up",
      "[1234505.120] mlx5_core 0000:3b:00.0: Port 1: Link Down",
      "[1234508.670] mlx5_core 0000:3b:00.0: Port 1: Link Up",
      "[1234509.010] mlx5_core 0000:3b:00.0: Port 1: Link Down",
      "... (43 state transitions in last 10 minutes)",
    ].join("\n"),
  }),
  telemetryConfigMap("g04", "g04-nccl-log", {
    "nccl-error.log": [
      "fake-node-105:21001:21001 [0] NCCL INFO RDMA send to fake-node-106 via mlx5_0:1 failed: IBV_WC_RETRY_EXC_ERR",
      "fake-node-105:21001:21001 [0] NCCL WARN allReduce timeout after 300000ms on ring 0",
      "fake-node-105:21001:21001 [0] NCCL WARN Watchdog timeout: rank 0 is stalled at ncclAllReduce",
    ].join("\n"),
  }),
  gpuPod("g04", "g04-rdma-flap", {
    annotations: {
      "siclaw.ai/crash-reason": "NCCL timeout: allReduce watchdog expired after 300s",
      "siclaw.ai/topology": "2-node distributed training: fake-node-105 (rank 0-7), fake-node-106 (rank 8-15)",
    },
    containers: [{
      name: "trainer", image: "busybox:1.36", imagePullPolicy: "IfNotPresent",
      command: ["sh", "-c", "echo 'NCCL allReduce timeout'; sleep 3600"],
      resources: { requests: { "nvidia.com/gpu": "8", "rdma/hca_shared_devices_all": "1", cpu: "160", memory: "1Ti" }, limits: { "nvidia.com/gpu": "8", "rdma/hca_shared_devices_all": "1" } },
    }],
  }),
);

// ────────────────────────────────────────────────────────────────────
// G05: RDMA PFC Storm (Priority Flow Control back-pressure cascade)
// Reference: Ghorbani et al. (IMC'25) — PFC shifts congestion to network core in RDMA datacenters
// ────────────────────────────────────────────────────────────────────
cases.push({
  id: "g05", category: "rdma-network", difficulty: "hard",
  title: "PFC storm causing cluster-wide RDMA congestion",
  targets: ["pod/g05-pfc-storm"],
  symptom: "Multiple distributed training jobs report slowdown. Pod g05-pfc-storm on fake-node-105 shows RDMA bandwidth dropped from 180 GB/s to 23 GB/s. Other training jobs on different nodes also report 20-30% throughput degradation.",
  groundTruth: {
    localization: "RDMA fabric congestion originating from fake-node-110 (a noisy-neighbor node running unoptimized all-to-all communication)",
    mechanism: "A noisy-neighbor job on fake-node-110 is generating excessive RDMA traffic with poor congestion control, triggering PFC (Priority Flow Control) PAUSE frames. These PFC frames propagate back-pressure through the network fabric ('PFC storm'), congesting switch buffers and causing head-of-line blocking for all RDMA traffic traversing the shared fabric links. ethtool counters show rx_pfc_pause on the leaf switch port spiking to 1.2M frames/sec. The DCQCN rate limiting is insufficient because the offending job bypasses ECN marking.",
    scope: "Cluster-wide impact: all multi-node training jobs sharing the same leaf-spine fabric segment. Intra-node NVLink traffic is unaffected.",
  },
  expectedSignals: ["rdma bandwidth drop", "pfc pause counters", "ethtool stats", "ecn counters"],
});
manifests.push(
  telemetryConfigMap("g05", "g05-rdma-counters", {
    "ethtool-stats.txt": [
      "NIC Statistics (mlx5_0, fake-node-105):",
      "  rx_pfc_pause: 1247832    <<< 1.2M PFC pause frames received (abnormal; normal < 100)",
      "  tx_pfc_pause: 0",
      "  rx_bytes: 23410000000    (23 GB/s — expected 180+ GB/s)",
      "  tx_bytes: 22890000000",
      "  rx_ecn_marked_pkts: 8923410    <<< heavy ECN marking indicates congestion",
      "",
      "NIC Statistics (mlx5_0, fake-node-110) [SUSPECTED SOURCE]:",
      "  tx_bytes: 198000000000   (198 GB/s — saturating link)",
      "  tx_pfc_pause: 0          (not receiving pause — it IS the source)",
      "  rx_pfc_pause: 4012       (minimal — downstream isn't pushing back to it)",
    ].join("\n"),
    "perftest-result.txt": "ib_write_bw test (fake-node-105 → fake-node-106):\n  Expected: 180 Gb/s (HDR200)\n  Measured: 23.4 Gb/s (87% degradation)\n  Retransmissions: 14,329 (normal: 0-10)",
  }),
  gpuPod("g05", "g05-pfc-storm", {
    annotations: {
      "siclaw.ai/symptom": "RDMA throughput dropped 87%: 180→23 GB/s. PFC pause frames 1.2M/sec.",
      "siclaw.ai/suspected-source": "fake-node-110 running unoptimized all-to-all communication",
    },
    containers: [{
      name: "trainer", image: "busybox:1.36", imagePullPolicy: "IfNotPresent",
      command: ["sh", "-c", "echo 'running slow due to PFC storm'; sleep 3600"],
      resources: { requests: { "nvidia.com/gpu": "8", "rdma/hca_shared_devices_all": "1", cpu: "160", memory: "1Ti" }, limits: { "nvidia.com/gpu": "8", "rdma/hca_shared_devices_all": "1" } },
    }],
  }),
);

// ────────────────────────────────────────────────────────────────────
// G06: GPU ECC Row Remapping Failure — GPU memory degraded beyond repair
// Reference: Cui et al. (2025) — H100 observed 8 row remapping failures
// ────────────────────────────────────────────────────────────────────
cases.push({
  id: "g06", category: "gpu-hardware", difficulty: "medium",
  title: "GPU row remapping exhausted — persistent ECC errors",
  targets: ["pod/g06-ecc-exhausted"],
  symptom: "Pod g06-ecc-exhausted keeps crashing with CUDA errors on node fake-node-105. Restarting the pod does not help. The issue persists across different training jobs on the same node.",
  groundTruth: {
    localization: "node fake-node-105 GPU 5",
    mechanism: "GPU 5 has exhausted its row remapping capacity. nvidia-smi shows 'Row Remap: Pending (reboot required)' with aggregate ECC double-bit errors count of 12. The GPU HBM3 memory has developed persistent faults that exceeded the hardware's self-repair capability (row remapping). Every job allocated GPU 5 will encounter uncorrectable memory errors. The GPU needs replacement.",
    scope: "All pods allocated GPU 5 on fake-node-105. Other GPUs on the node are healthy. Node should be cordoned and GPU 5 decommissioned.",
  },
  expectedSignals: ["ecc error count", "row remap status", "gpu health", "persistent across restarts"],
});
manifests.push(
  telemetryConfigMap("g06", "g06-gpu-health", {
    "nvidia-smi-ecc.txt": [
      "GPU 5 ECC Error Summary:",
      "  Volatile Uncorrectable: 3 (since last reboot)",
      "  Aggregate Uncorrectable: 12 (lifetime)",
      "  Aggregate Correctable: 847 (lifetime)",
      "  Row Remap Status: PENDING (reboot required to attempt remap)",
      "  Row Remap Availability: 0 of 512 (EXHAUSTED)",
      "  Retired Pages: 24 (double-bit), 3 (single-bit pending)",
      "",
      "GPU 0-4,6-7: Aggregate Uncorrectable: 0, Row Remap: Available (512/512 free)",
    ].join("\n"),
  }),
  gpuPod("g06", "g06-ecc-exhausted", {
    annotations: {
      "siclaw.ai/crash-reason": "CUDA error: uncorrectable ECC error encountered (GPU 5)",
      "siclaw.ai/restart-count": "4",
      "siclaw.ai/note": "Same error on every restart. Not workload-specific.",
    },
    containers: [{
      name: "trainer", image: "busybox:1.36", imagePullPolicy: "IfNotPresent",
      command: ["sh", "-c", "exit 1"],
      resources: { requests: { "nvidia.com/gpu": "8", cpu: "160", memory: "1Ti" }, limits: { "nvidia.com/gpu": "8" } },
    }],
  }),
);

// ────────────────────────────────────────────────────────────────────
// G07: NCCL Timeout due to GPU clock mismatch (Silent Degradation)
// Reference: Holmes (NSDI'25) — localizing silent irregularities in mega-scale training
// ────────────────────────────────────────────────────────────────────
cases.push({
  id: "g07", category: "gpu-hardware", difficulty: "hard",
  title: "Silent GPU clock degradation causing NCCL timeout in distributed training",
  targets: ["pod/g07-clock-mismatch"],
  symptom: "Distributed training pod g07-clock-mismatch times out intermittently at NCCL barrier synchronization. The issue appears every 15-20 minutes and resolves itself. Training job uses 16 GPUs across 2 nodes.",
  groundTruth: {
    localization: "node fake-node-105 GPU 7",
    mechanism: "GPU 7 on fake-node-105 has a degraded SM (Streaming Multiprocessor) clock that intermittently drops from 1980 MHz to 1200 MHz due to internal power delivery issues. This causes GPU 7's compute kernels to run 40% slower, making rank 7 the straggler in NCCL collective operations. When the allreduce barrier timeout (300s) is hit before GPU 7 completes its gradient computation, NCCL reports a timeout. The clock recovers spontaneously, making the issue intermittent.",
    scope: "Any distributed training job that includes GPU 7 on fake-node-105. The straggler effect is proportional to the communication-to-computation ratio.",
  },
  expectedSignals: ["gpu clock speed mismatch", "nccl timeout intermittent", "straggler rank"],
});
manifests.push(
  telemetryConfigMap("g07", "g07-gpu-clocks", {
    "nvidia-smi-clocks.txt": [
      "GPU Clock Frequencies (fake-node-105):",
      "  GPU 0: SM 1980 MHz, Mem 2619 MHz (normal)",
      "  GPU 1: SM 1980 MHz, Mem 2619 MHz (normal)",
      "  GPU 2: SM 1980 MHz, Mem 2619 MHz (normal)",
      "  GPU 3: SM 1980 MHz, Mem 2619 MHz (normal)",
      "  GPU 4: SM 1980 MHz, Mem 2619 MHz (normal)",
      "  GPU 5: SM 1980 MHz, Mem 2619 MHz (normal)",
      "  GPU 6: SM 1980 MHz, Mem 2619 MHz (normal)",
      "  GPU 7: SM 1200 MHz, Mem 2619 MHz  <<< DEGRADED (expected 1980 MHz)",
      "",
      "GPU Clock Frequencies (fake-node-106):",
      "  GPU 0-7: SM 1980 MHz, Mem 2619 MHz (all normal)",
    ].join("\n"),
    "nccl-straggler.log": [
      "Rank 7 (fake-node-105:GPU7): allReduce latency 287ms (p50: 23ms, p99: 42ms for other ranks)",
      "Rank 7 consistently slowest across 847 allReduce calls (100% straggler)",
      "NCCL WARN: Watchdog timeout at allReduce #12847, rank 7 stalled",
    ].join("\n"),
  }),
  gpuPod("g07", "g07-clock-mismatch", {
    annotations: {
      "siclaw.ai/symptom": "Intermittent NCCL timeout every 15-20 min. Rank 7 always the straggler.",
    },
    containers: [{
      name: "trainer", image: "busybox:1.36", imagePullPolicy: "IfNotPresent",
      command: ["sh", "-c", "echo 'intermittent NCCL timeout'; sleep 3600"],
      resources: { requests: { "nvidia.com/gpu": "8", "rdma/hca_shared_devices_all": "1", cpu: "160", memory: "1Ti" }, limits: { "nvidia.com/gpu": "8", "rdma/hca_shared_devices_all": "1" } },
    }],
  }),
);

// ────────────────────────────────────────────────────────────────────
// G08: RDMA Connection Reset — QP state transition failure
// Reference: SHIFT (2025) — RDMA failure-resilient layer for distributed training
// ────────────────────────────────────────────────────────────────────
cases.push({
  id: "g08", category: "rdma-network", difficulty: "medium",
  title: "RDMA QP error state causing training hang",
  targets: ["pod/g08-qp-error"],
  symptom: "Distributed training pod g08-qp-error hangs with no progress. No timeout yet but zero training throughput for 10 minutes. Two nodes: fake-node-105 and fake-node-106.",
  groundTruth: {
    localization: "RDMA Queue Pair between fake-node-105 and fake-node-106",
    mechanism: "An RDMA Queue Pair (QP) transitioned to ERROR state after a transport-layer retry exceeded (IBV_WC_RETRY_EXC_ERR). Once a QP enters ERROR state, all subsequent RDMA operations on that QP silently fail. NCCL does not detect QP ERROR state until the watchdog timer fires (default 300s). The QP error was triggered by a transient network issue (brief packet loss) but the QP cannot self-recover — it must be destroyed and recreated. This is the fundamental problem that SHIFT (2025) addresses.",
    scope: "All RDMA communication between the two nodes on the affected QP. Other QPs (if any) are unaffected.",
  },
  expectedSignals: ["qp state error", "rdma retry exceeded", "zero throughput", "ibv_wc status"],
});
manifests.push(
  telemetryConfigMap("g08", "g08-rdma-diag", {
    "rdma-resource.txt": [
      "RDMA Resource State (fake-node-105, mlx5_0):",
      "  QP 0x1a2b: state=RTS (Ready-To-Send), type=RC, remote=fake-node-106:mlx5_0  [OK]",
      "  QP 0x1a2c: state=ERR, type=RC, remote=fake-node-106:mlx5_0   <<< ERROR STATE",
      "  QP 0x1a2d: state=RTS, type=RC, remote=fake-node-107:mlx5_0  [OK]",
      "",
      "Last Error on QP 0x1a2c:",
      "  Work Completion Status: IBV_WC_RETRY_EXC_ERR (transport retry exceeded)",
      "  Timestamp: 2026-06-04T12:34:56Z",
      "  Affected operation: RDMA_WRITE, remote_addr=0x7f8a00000000, length=4194304",
    ].join("\n"),
  }),
  gpuPod("g08", "g08-qp-error", {
    annotations: {
      "siclaw.ai/symptom": "Zero training throughput for 10 minutes. No crash, no timeout yet.",
      "siclaw.ai/rdma-error": "QP 0x1a2c in ERROR state: IBV_WC_RETRY_EXC_ERR",
    },
    containers: [{
      name: "trainer", image: "busybox:1.36", imagePullPolicy: "IfNotPresent",
      command: ["sh", "-c", "echo 'hung waiting for RDMA'; sleep 3600"],
      resources: { requests: { "nvidia.com/gpu": "8", "rdma/hca_shared_devices_all": "1", cpu: "160", memory: "1Ti" }, limits: { "nvidia.com/gpu": "8", "rdma/hca_shared_devices_all": "1" } },
    }],
  }),
);

// ────────────────────────────────────────────────────────────────────
// G09: Compound — GPU ECC + RDMA congestion (multi-root-cause)
// Reference: ByteRobust (SOSP'25) — 38,236 explicit + 5,948 implicit failures in 3 months
// ────────────────────────────────────────────────────────────────────
cases.push({
  id: "g09", category: "compound-gpu-rdma", difficulty: "hard",
  title: "Compound: GPU ECC errors AND RDMA congestion on same node",
  targets: ["pod/g09-compound"],
  symptom: "Training pod g09-compound on fake-node-105 crashes intermittently. Sometimes with CUDA error, sometimes with NCCL timeout. Restarts sometimes succeed briefly before crashing again.",
  groundTruth: {
    localization: "pod/g09-compound on fake-node-105; two independent root causes: GPU 4 ECC errors AND RDMA port mlx5_0 congestion",
    mechanism: "Two independent faults compound on fake-node-105: (1) GPU 4 has developing ECC single-bit errors (847 volatile correctable) with occasional uncorrectable errors causing CUDA failures, AND (2) RDMA port mlx5_0 is experiencing congestion from PFC pause frames (suspected cable degradation on uplink). The GPU ECC errors cause sporadic CUDA crashes, while the RDMA congestion causes NCCL timeouts. Because the faults are independent, the failure mode alternates between CUDA error and NCCL timeout depending on which triggers first.",
    scope: "All jobs on fake-node-105 are affected by both issues. GPU 4 needs replacement. RDMA uplink cable needs inspection.",
  },
  expectedSignals: ["ecc errors gpu 4", "rdma congestion", "alternating failure modes", "two root causes"],
});
manifests.push(
  telemetryConfigMap("g09", "g09-multi-telemetry", {
    "nvidia-smi-ecc.txt": "GPU 4: Volatile Correctable ECC: 847, Volatile Uncorrectable: 2, Row Remap: Available (508/512)\nGPU 0-3,5-7: Volatile Correctable: 0-3, Volatile Uncorrectable: 0",
    "rdma-stats.txt": "mlx5_0 (fake-node-105):\n  rx_pfc_pause: 342891 (elevated)\n  rx_bytes: 89 GB/s (expected 180+ GB/s)\n  symbol_errors: 127 (cable degradation indicator)",
    "crash-history.txt": [
      "Crash 1 (12:10): CUDA error illegal memory access (GPU 4)",
      "Crash 2 (12:25): NCCL timeout allReduce 300s",
      "Crash 3 (12:42): CUDA error ECC uncorrectable (GPU 4)",
      "Crash 4 (13:01): NCCL timeout allReduce 300s",
      "Crash 5 (13:15): CUDA error illegal memory access (GPU 4)",
    ].join("\n"),
  }),
  gpuPod("g09", "g09-compound", {
    annotations: {
      "siclaw.ai/crash-count": "5",
      "siclaw.ai/crash-history": "Alternating: CUDA error (GPU 4) / NCCL timeout",
    },
    containers: [{
      name: "trainer", image: "busybox:1.36", imagePullPolicy: "IfNotPresent",
      command: ["sh", "-c", "exit 1"],
      resources: { requests: { "nvidia.com/gpu": "8", "rdma/hca_shared_devices_all": "1", cpu: "160", memory: "1Ti" }, limits: { "nvidia.com/gpu": "8", "rdma/hca_shared_devices_all": "1" } },
    }],
  }),
);

// ────────────────────────────────────────────────────────────────────
// G10: Compound — Volcano Gang Scheduling + GPU Node Drain Race
// Reference: Industry pattern — node drain races with gang-scheduled jobs
// ────────────────────────────────────────────────────────────────────
cases.push({
  id: "g10", category: "compound-gpu-rdma", difficulty: "hard",
  title: "Volcano gang scheduling failure due to GPU node drain race",
  targets: ["vcjob/g10-gang-drain"],
  symptom: "Volcano job g10-gang-drain requires 16 GPUs across 2 nodes (minMember=2 PodGroup) but remains Pending despite available GPU nodes. Some worker pods briefly start then get evicted.",
  groundTruth: {
    localization: "vcjob/g10-gang-drain, PodGroup g10-gang-drain",
    mechanism: "A race condition between Volcano gang scheduling and node cordoning: fake-node-105 is being cordoned (kubectl cordon) for maintenance while Volcano attempts to schedule the 2-node gang. Volcano allocates both nodes, starts pods on fake-node-105, but the kubelet evicts them due to the cordon+drain sequence. The PodGroup then fails minMember check (only 1 of 2 nodes usable), but Volcano does not release the allocation on fake-node-106, creating a deadlock. Meanwhile, the node condition shows 'SchedulingDisabled' on fake-node-105.",
    scope: "This specific Volcano job and any other gang-scheduled job competing for the same 2-node allocation. Single-node jobs on fake-node-106 are unaffected.",
  },
  expectedSignals: ["podgroup pending", "node cordon", "pod eviction", "gang scheduling", "minMember"],
});
manifests.push(
  volcanoJob("g10", "g10-gang-drain", {
    minAvailable: 2,
    tasks: [
      {
        replicas: 2, name: "worker",
        template: {
          spec: {
            restartPolicy: "Never",
            nodeSelector: { "scitix.ai/gpu-type": "h20nvlink141" },
            containers: [{
              name: "worker", image: "busybox:1.36", imagePullPolicy: "IfNotPresent",
              command: ["sh", "-c", "echo worker; sleep 3600"],
              resources: { requests: { "nvidia.com/gpu": "8", cpu: "20m", memory: "32Mi" }, limits: { "nvidia.com/gpu": "8" } },
            }],
          },
        },
      },
    ],
  }),
);

// ════════════════════════════════════════════════════════════════════
//  Output
// ════════════════════════════════════════════════════════════════════

// Write cases.json
const casesPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpu-rdma-cases.json");
fs.writeFileSync(casesPath, JSON.stringify(cases.map(c => ({
  namespace: NS, ...c,
})), null, 2) + "\n");

// Write manifests.yaml
const nsManifest = { apiVersion: "v1", kind: "Namespace", metadata: { name: NS } };
const allManifests = [nsManifest, ...manifests];
const yamlPath = path.join(path.dirname(new URL(import.meta.url).pathname), "gpu-rdma-manifests.yaml");
fs.writeFileSync(yamlPath, allManifests.map(m => yaml.dump(m, { lineWidth: -1 })).join("---\n"));

console.log(`Generated ${cases.length} cases → ${casesPath}`);
console.log(`Generated ${allManifests.length} manifests → ${yamlPath}`);
console.log("\nCases:");
for (const c of cases) {
  console.log(`  ${c.id}: [${c.category}/${c.difficulty}] ${c.title}`);
}
