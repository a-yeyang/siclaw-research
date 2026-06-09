#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const ROOT = "experiments/siclaw-agent-eval";
const NS = process.env.SICLAW_EVAL_NAMESPACE || "siclaw-eval-yye-20260602";
const LABEL_RUN = "siclaw.ai/eval-run";
const RUN = "20260602";

function id(n) {
  return `c${String(n).padStart(3, "0")}`;
}

function labels(caseId, extra = {}) {
  return {
    [LABEL_RUN]: RUN,
    "siclaw.ai/eval-case": caseId,
    ...extra,
  };
}

function meta(name, caseId, extra = {}) {
  return { name, namespace: NS, labels: labels(caseId, extra) };
}

function pod(caseId, name, spec, extraLabels = {}) {
  const mergedSpec = {
    restartPolicy: spec.restartPolicy ?? "Always",
    containers: spec.containers,
    ...spec,
  };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: meta(name, caseId, extraLabels),
    spec: mergedSpec,
  };
}

function busyContainer(name, command, extra = {}) {
  return {
    name,
    image: extra.image ?? "busybox:1.36",
    imagePullPolicy: extra.imagePullPolicy ?? "IfNotPresent",
    command: ["sh", "-c", command],
    ...extra,
  };
}

function service(caseId, name, selector, port = 80, targetPort = 8080) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: meta(name, caseId),
    spec: {
      selector,
      ports: [{ name: "http", port, targetPort }],
    },
  };
}

function deployment(caseId, name, podLabels, container, extraSpec = {}) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: meta(name, caseId),
    spec: {
      replicas: extraSpec.replicas ?? 1,
      selector: { matchLabels: podLabels },
      template: {
        metadata: { labels: { ...labels(caseId), ...podLabels } },
        spec: {
          containers: [container],
          ...extraSpec.podSpec,
        },
      },
      ...extraSpec.deploymentSpec,
    },
  };
}

function pvc(caseId, name, storageClassName = "missing-storageclass") {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: meta(name, caseId),
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName,
      resources: { requests: { storage: "1Gi" } },
    },
  };
}

function networkPolicy(caseId, name, podSelector, policyTypes, ingress, egress) {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta(name, caseId),
    spec: {
      podSelector: { matchLabels: podSelector },
      policyTypes,
      ...(ingress ? { ingress } : {}),
      ...(egress ? { egress } : {}),
    },
  };
}

function hpa(caseId, name, targetName) {
  return {
    apiVersion: "autoscaling/v2",
    kind: "HorizontalPodAutoscaler",
    metadata: meta(name, caseId),
    spec: {
      minReplicas: 1,
      maxReplicas: 3,
      scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: targetName },
      metrics: [
        {
          type: "Resource",
          resource: {
            name: "cpu",
            target: { type: "Utilization", averageUtilization: 60 },
          },
        },
      ],
    },
  };
}

function volcanoJob(caseId, name, specPatch) {
  const baseTask = {
    replicas: 1,
    name: "trainer",
    template: {
      spec: {
        restartPolicy: "Never",
        containers: [
          busyContainer("trainer", "echo trainer-started; sleep 3600", {
            resources: { requests: { cpu: "20m", memory: "32Mi" }, limits: { cpu: "50m", memory: "64Mi" } },
          }),
        ],
      },
    },
  };
  return {
    apiVersion: "batch.volcano.sh/v1alpha1",
    kind: "Job",
    metadata: meta(name, caseId),
    spec: {
      schedulerName: "volcano",
      queue: "default",
      minAvailable: 1,
      maxRetry: 0,
      tasks: [baseTask],
      ...specPatch,
    },
  };
}

function volcanoPodGroup(caseId, name, specPatch = {}) {
  return {
    apiVersion: "scheduling.volcano.sh/v1beta1",
    kind: "PodGroup",
    metadata: meta(name, caseId),
    spec: {
      minMember: 1,
      queue: "default",
      ...specPatch,
    },
  };
}

function volcanoGroupedPod(caseId, name, groupName, specPatch = {}) {
  return pod(
    caseId,
    name,
    {
      schedulerName: "volcano",
      containers: [busyContainer("trainer", "echo trainer-started; sleep 3600", {
        resources: { requests: { cpu: "20m", memory: "32Mi" }, limits: { cpu: "50m", memory: "64Mi" } },
      })],
      ...specPatch,
    },
    {},
  );
}

function casePrompt(c) {
  return `You are Siclaw under evaluation as a read-only SRE diagnostic agent.

Incident:
${c.symptom}

Target cluster: cks-test
Namespace: ${c.namespace}
Primary target resource(s): ${c.targets.join(", ")}
Case id: ${c.id}

Rules:
- Do not modify, delete, restart, scale, patch, or create cluster resources.
- Prefer Siclaw's relevant Kubernetes/Volcano diagnostic skills when applicable.
- Inspect only this case's resources plus minimal cluster context needed for diagnosis.
- Return a concise final diagnosis with: root cause(s), concrete evidence, impact/scope, confidence, and safe remediation suggestion.
`;
}

const cases = [];
const resources = [];

function addCase(c, objs) {
  cases.push({
    namespace: NS,
    difficulty: "easy",
    noise: false,
    ...c,
  });
  resources.push(...objs);
}

let n = 1;

// 1-10: image pull and registry faults.
[
  ["missing image tag", "registry.invalid/scitix/missing-trainer:v404", "image registry host/tag is invalid and cannot be pulled"],
  ["nonexistent docker image", "docker.io/library/siclaw-does-not-exist:v1", "image repository does not exist"],
  ["bad private registry", "private.invalid.local/gpu/train:v1", "private registry is unreachable or unauthorized"],
  ["typoed cuda image", "nvcr.io/nvidia/pytroch:24.01-py3", "image name has a typo: pytroch instead of pytorch"],
  ["bad model sidecar image", "registry.invalid/scitix/model-loader:v404", "sidecar image cannot be pulled"],
  ["bad init image", "registry.invalid/scitix/init-gpu:v404", "initContainer image cannot be pulled"],
  ["wrong exporter image", "registry.invalid/scitix/dcgm-exporter:v0", "GPU exporter image tag is invalid"],
  ["bad training image digest", "busybox@sha256:0000000000000000000000000000000000000000000000000000000000000000", "image digest does not exist"],
  ["bad pull secret reference", "private.invalid.local/team/train:v2", "private image cannot be pulled and pull secret is missing"],
  ["airgap mirror typo", "mirror.invalid.local/scitix/busybox:1.36", "air-gapped mirror hostname is wrong"],
].forEach(([title, imageName, mechanism]) => {
  const caseId = id(n++);
  const name = `${caseId}-image`;
  const spec = {
    restartPolicy: "Always",
    ...(title === "bad pull secret reference" ? { imagePullSecrets: [{ name: `${caseId}-missing-pull-secret` }] } : {}),
    initContainers: title === "bad init image" ? [{ name: "init", image: imageName, command: ["sh", "-c", "echo init"] }] : undefined,
    containers: [
      busyContainer("main", "sleep 3600", {
        image: title === "bad init image" ? "busybox:1.36" : imageName,
        imagePullPolicy: "Always",
      }),
    ],
  };
  if (!spec.initContainers) delete spec.initContainers;
  addCase({
    id: caseId,
    category: "image-pull",
    title,
    targets: [`pod/${name}`],
    symptom: `GPU workload pod ${name} never starts and is reported around ImagePullBackOff/ErrImagePull.`,
    groundTruth: { localization: `pod/${name}`, mechanism, scope: "single pod image startup" },
    expectedSignals: ["pod waiting reason", "describe pod events", "image field"],
  }, [pod(caseId, name, spec)]);
});

// 11-20: crash loops with application/config-like root causes.
[
  ["missing model path env", "test -n \"$MODEL_PATH\" || { echo 'fatal: MODEL_PATH missing'; exit 42; }; sleep 3600", "required MODEL_PATH env var is absent"],
  ["bad cuda visible devices", "test \"$CUDA_VISIBLE_DEVICES\" = all || { echo 'cuda devices masked'; exit 43; }", "CUDA_VISIBLE_DEVICES is mis-set for the workload"],
  ["bad entrypoint", "echo 'unknown flag --tensor-parallel'; exit 2", "container command exits because startup arguments are invalid"],
  ["missing checkpoint", "echo 'checkpoint /models/ckpt.pt not found'; exit 44", "application exits because checkpoint path is missing"],
  ["bad nccl interface", "echo 'NCCL_SOCKET_IFNAME=eth9 not found'; exit 45", "NCCL network interface env points to a nonexistent interface"],
  ["oom-like self exit", "echo 'allocator failed before training loop'; exit 137", "process exits with 137-like code from memory allocation failure"],
  ["permission denied", "echo 'permission denied: /models'; exit 13", "application lacks permission to read its model directory"],
  ["bad config yaml", "echo 'YAML parse error in trainer-config.yaml'; exit 46", "trainer configuration file content is invalid"],
  ["missing license token", "test -n \"$LICENSE_TOKEN\" || { echo 'license token missing'; exit 47; }", "required LICENSE_TOKEN env var is absent"],
  ["wrong port binding", "echo 'listen tcp :8080: bind: address already in use'; exit 48", "application fails during startup while binding its port"],
].forEach(([title, command, mechanism]) => {
  const caseId = id(n++);
  const name = `${caseId}-crash`;
  addCase({
    id: caseId,
    category: "crashloop",
    title,
    targets: [`pod/${name}`],
    symptom: `Training pod ${name} repeatedly restarts before becoming ready.`,
    groundTruth: { localization: `pod/${name}`, mechanism, scope: "single container crash loop" },
    expectedSignals: ["CrashLoopBackOff", "previous logs", "restart count"],
  }, [pod(caseId, name, { containers: [busyContainer("trainer", command)] })]);
});

// 21-30: config, secret, and volume materialization faults.
[
  ["missing configmap key", { env: [{ name: "MODEL_BUCKET", valueFrom: { configMapKeyRef: { name: "missing-model-config", key: "bucket" } } }] }, "ConfigMap missing-model-config/key bucket is absent"],
  ["missing secret key", { env: [{ name: "REGISTRY_TOKEN", valueFrom: { secretKeyRef: { name: "missing-registry-secret", key: "token" } } }] }, "Secret missing-registry-secret/key token is absent"],
  ["missing envFrom configmap", { envFrom: [{ configMapRef: { name: "missing-env-config" } }] }, "envFrom references a missing ConfigMap"],
  ["missing secret envFrom", { envFrom: [{ secretRef: { name: "missing-env-secret" } }] }, "envFrom references a missing Secret"],
  ["missing config volume", { volumes: [{ name: "cfg", configMap: { name: "missing-volume-config" } }], volumeMounts: [{ name: "cfg", mountPath: "/etc/trainer" }] }, "volume references a missing ConfigMap"],
  ["missing secret volume", { volumes: [{ name: "secret", secret: { secretName: "missing-volume-secret" } }], volumeMounts: [{ name: "secret", mountPath: "/run/secret" }] }, "volume references a missing Secret"],
  ["missing pvc volume", { volumes: [{ name: "data", persistentVolumeClaim: { claimName: "missing-data-pvc" } }], volumeMounts: [{ name: "data", mountPath: "/data" }] }, "pod references a missing PVC"],
  ["bad projected secret", { volumes: [{ name: "projected", projected: { sources: [{ secret: { name: "missing-projected-secret" } }] } }], volumeMounts: [{ name: "projected", mountPath: "/projected" }] }, "projected volume references a missing Secret"],
  ["bad config subpath", { volumes: [{ name: "cfg", configMap: { name: "missing-subpath-config" } }], volumeMounts: [{ name: "cfg", mountPath: "/etc/trainer/config.yaml", subPath: "config.yaml" }] }, "subPath mount depends on a missing ConfigMap"],
  ["missing downward config", { env: [{ name: "TRAINING_CONFIG", valueFrom: { configMapKeyRef: { name: "missing-training-config", key: "config.yaml" } } }] }, "pod references a missing training ConfigMap"],
].forEach(([title, patch, mechanism]) => {
  const caseId = id(n++);
  const name = `${caseId}-config`;
  const container = busyContainer("trainer", "sleep 3600", {
    ...(patch.env ? { env: patch.env } : {}),
    ...(patch.envFrom ? { envFrom: patch.envFrom } : {}),
    ...(patch.volumeMounts ? { volumeMounts: patch.volumeMounts } : {}),
  });
  const spec = {
    containers: [container],
    ...(patch.volumes ? { volumes: patch.volumes } : {}),
  };
  addCase({
    id: caseId,
    category: "config",
    title,
    targets: [`pod/${name}`],
    symptom: `Pod ${name} is stuck during container configuration or volume setup.`,
    groundTruth: { localization: `pod/${name}`, mechanism, scope: "single pod configuration dependency" },
    expectedSignals: ["CreateContainerConfigError or FailedMount", "describe pod events"],
  }, [pod(caseId, name, spec)]);
});

// 31-45: scheduling and GPU placement faults.
[
  ["gpu type selector unavailable", { nodeSelector: { "scitix.ai/gpu-type": "h100-pcie-80gb" } }, "nodeSelector asks for unavailable GPU type h100-pcie-80gb"],
  ["impossible gpu count", { resources: { limits: { "nvidia.com/gpu": "999" } } }, "pod requests more GPUs than any node/cluster can provide"],
  ["huge cpu request", { resources: { requests: { cpu: "100000", memory: "64Mi" }, limits: { cpu: "100000", memory: "64Mi" } } }, "CPU request exceeds schedulable capacity"],
  ["huge memory request", { resources: { requests: { cpu: "20m", memory: "20Ti" }, limits: { cpu: "50m", memory: "20Ti" } } }, "memory request exceeds schedulable capacity"],
  ["nonexistent scheduler", { schedulerName: "gpu-scheduler-does-not-exist" }, "pod names a scheduler that is not running"],
  ["missing gpu scheduler profile", { schedulerName: "gpu-scheduler-profile-missing" }, "schedulerName points to a nonexistent GPU scheduler profile"],
  ["zone selector impossible", { nodeSelector: { "topology.kubernetes.io/zone": "zone-does-not-exist" } }, "nodeSelector asks for a nonexistent zone"],
  ["hostname selector impossible", { nodeSelector: { "kubernetes.io/hostname": "node-does-not-exist" } }, "nodeSelector pins pod to nonexistent node"],
  ["gpu label typo", { nodeSelector: { "scitix.ai/gpu-typ": "h20nvlink141" } }, "nodeSelector key has a typo: gpu-typ instead of gpu-type"],
  ["pod anti-affinity impossible", { affinity: { podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: { matchExpressions: [{ key: "siclaw.ai/eval-run", operator: "Exists" }] }, topologyKey: "kubernetes.io/hostname" }] } } }, "required anti-affinity conflicts with broad existing eval labels"],
  ["gpu plus invalid selector", { nodeSelector: { "scitix.ai/gpu-type": "l40s-does-not-exist" }, resources: { limits: { "nvidia.com/gpu": "1" } } }, "GPU request is combined with an unavailable GPU type selector"],
  ["gpu no toleration style", { nodeSelector: { "node-role.kubernetes.io/gpu-dedicated": "true" }, tolerations: [] }, "selector targets a dedicated label that no node has"],
  ["min cpu on fake pool", { nodeSelector: { "scitix.ai/nodepool": "nonexistent-gpu-pool" }, resources: { limits: { "nvidia.com/gpu": "1" } } }, "GPU workload targets a nonexistent node pool"],
  ["required affinity impossible", { affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: "siclaw.ai/nonexistent-affinity", operator: "In", values: ["true"] }] }] } } } }, "required node affinity uses a label that no node has"],
  ["wrong arch", { nodeSelector: { "kubernetes.io/arch": "arm64-does-not-exist" } }, "node architecture selector is impossible"],
].forEach(([title, patch, mechanism]) => {
  const caseId = id(n++);
  const name = `${caseId}-pending`;
  const resourcePatch = patch.resources ?? { requests: { cpu: "20m", memory: "32Mi" }, limits: { cpu: "50m", memory: "64Mi" } };
  const spec = {
    containers: [busyContainer("trainer", "sleep 3600", { resources: resourcePatch })],
    ...(patch.nodeSelector ? { nodeSelector: patch.nodeSelector } : {}),
    ...(patch.schedulerName ? { schedulerName: patch.schedulerName } : {}),
    ...(patch.runtimeClassName ? { runtimeClassName: patch.runtimeClassName } : {}),
    ...(patch.affinity ? { affinity: patch.affinity } : {}),
    ...(patch.tolerations ? { tolerations: patch.tolerations } : {}),
    ...(patch.priorityClassName ? { priorityClassName: patch.priorityClassName } : {}),
  };
  addCase({
    id: caseId,
    category: "scheduling-gpu",
    title,
    targets: [`pod/${name}`],
    symptom: `GPU or training pod ${name} remains Pending / unscheduled.`,
    groundTruth: { localization: `pod/${name}`, mechanism, scope: "single workload scheduling constraint" },
    expectedSignals: ["FailedScheduling events", "pod spec resource requests/selectors"],
  }, [pod(caseId, name, spec)]);
});

// 46-55: storage/PVC faults.
for (let i = 0; i < 10; i++) {
  const caseId = id(n++);
  const claim = `${caseId}-data`;
  const name = `${caseId}-storage`;
  const sc = i % 2 === 0 ? "missing-storageclass" : "gpu-local-ssd-missing";
  addCase({
    id: caseId,
    category: "storage",
    title: i % 2 === 0 ? "PVC storageClass does not exist" : "GPU local SSD class typo",
    targets: [`pvc/${claim}`, `pod/${name}`],
    symptom: `Training pod ${name} cannot start because its dataset PVC ${claim} is not bound.`,
    groundTruth: { localization: `pvc/${claim}`, mechanism: `PVC requests nonexistent storageClass ${sc}`, scope: "pod blocked by unbound PVC" },
    expectedSignals: ["PVC Pending", "pod FailedScheduling due unbound PVC", "storageClassName"],
  }, [
    pvc(caseId, claim, sc),
    pod(caseId, name, {
      containers: [busyContainer("trainer", "sleep 3600", { volumeMounts: [{ name: "data", mountPath: "/data" }] })],
      volumes: [{ name: "data", persistentVolumeClaim: { claimName: claim } }],
    }),
  ]);
}

// 56-67: service, readiness, and endpoint faults.
for (let i = 0; i < 12; i++) {
  const caseId = id(n++);
  const app = `${caseId}-app`;
  const svc = `${caseId}-svc`;
  const labelsOk = { app };
  const server = deployment(
    caseId,
    app,
    labelsOk,
    busyContainer("http", "mkdir -p /www && echo ok >/www/index.html && httpd -f -p 8080 -h /www", {
      ports: [{ containerPort: 8080 }],
      readinessProbe: i % 3 === 0 ? { httpGet: { path: "/missing-healthz", port: 8080 }, initialDelaySeconds: 1, periodSeconds: 3 } : undefined,
    }),
  );
  const svcObj = service(caseId, svc, i % 3 === 1 ? { app: `${app}-typo` } : labelsOk, 80, i % 3 === 2 ? 9090 : 8080);
  const mechanism =
    i % 3 === 0 ? "readiness probe points to a missing health endpoint, so endpoints are not ready" :
    i % 3 === 1 ? "Service selector does not match the backing pod labels, so endpoints are empty" :
    "Service targetPort points to 9090 while the container listens on 8080";
  addCase({
    id: caseId,
    category: "service-readiness",
    title: mechanism,
    difficulty: i < 6 ? "medium" : "hard",
    targets: [`deployment/${app}`, `service/${svc}`],
    symptom: `Internal service ${svc} for workload ${app} is unavailable to clients.`,
    groundTruth: { localization: i % 3 === 0 ? `deployment/${app}` : `service/${svc}`, mechanism, scope: "one service path in the eval namespace" },
    expectedSignals: ["deployment readiness", "service selector", "endpoints/endpointslices", "pod events"],
  }, [server, svcObj]);
}

// 68-77: NetworkPolicy and DNS faults.
for (let i = 0; i < 10; i++) {
  const caseId = id(n++);
  const client = `${caseId}-client`;
  const server = `${caseId}-server`;
  const serverLabels = { app: server };
  const clientLabels = { app: client };
  const objs = [
    pod(caseId, server, {
      containers: [busyContainer("http", "mkdir -p /www && echo ok >/www/index.html && httpd -f -p 8080 -h /www", { ports: [{ containerPort: 8080 }] })],
    }, serverLabels),
    pod(caseId, client, {
      containers: [busyContainer("client", "sleep 3600")],
      ...(i % 3 === 2 ? { dnsPolicy: "None", dnsConfig: { nameservers: ["203.0.113.1"], searches: ["bad.local"], options: [{ name: "ndots", value: "5" }] } } : {}),
    }, clientLabels),
    service(caseId, `${caseId}-server-svc`, serverLabels, 80, 8080),
  ];
  let mechanism;
  if (i % 3 === 0) {
    objs.push(networkPolicy(caseId, `${caseId}-deny-egress`, clientLabels, ["Egress"], [], []));
    mechanism = "NetworkPolicy selects the client and denies all egress, including DNS/service traffic";
  } else if (i % 3 === 1) {
    objs.push(networkPolicy(caseId, `${caseId}-deny-ingress`, serverLabels, ["Ingress"], [], []));
    mechanism = "NetworkPolicy selects the server and denies all ingress from the client";
  } else {
    mechanism = "client pod overrides DNS with TEST-NET nameserver 203.0.113.1, so cluster DNS resolution fails";
  }
  addCase({
    id: caseId,
    category: "network-dns",
    title: mechanism,
    difficulty: "medium",
    targets: [`pod/${client}`, `pod/${server}`, `service/${caseId}-server-svc`],
    symptom: `Client pod ${client} cannot resolve or reach service ${caseId}-server-svc even though the server pod exists.`,
    groundTruth: { localization: i % 3 === 2 ? `pod/${client}` : `networkpolicy/${caseId}-${i % 3 === 0 ? "deny-egress" : "deny-ingress"}`, mechanism, scope: "traffic involving this case's client/server pods" },
    expectedSignals: ["NetworkPolicy spec", "pod DNS config", "service endpoints"],
  }, objs);
}

// 78-85: Deployment/HPA/Ingress controller-level symptoms.
for (let i = 0; i < 8; i++) {
  const caseId = id(n++);
  const dep = `${caseId}-deploy`;
  const objs = [];
  let mechanism;
  if (i % 4 === 0) {
    objs.push(deployment(caseId, dep, { app: dep }, busyContainer("app", "sleep 3600", { image: "registry.invalid/scitix/rollout:v404", imagePullPolicy: "Always" })));
    mechanism = "Deployment rollout is blocked because new ReplicaSet pods cannot pull the image";
  } else if (i % 4 === 1) {
    objs.push(deployment(caseId, dep, { app: dep }, busyContainer("app", "mkdir -p /www && echo ok >/www/index.html && httpd -f -p 8080 -h /www", {
      ports: [{ containerPort: 8080 }],
      readinessProbe: { httpGet: { path: "/healthz", port: 9090 }, initialDelaySeconds: 1, periodSeconds: 3 },
    })));
    mechanism = "Deployment pods run but readiness probe targets port 9090 instead of 8080";
  } else if (i % 4 === 2) {
    objs.push(deployment(caseId, dep, { app: dep }, busyContainer("app", "while true; do :; done")));
    objs.push(hpa(caseId, `${caseId}-hpa`, dep));
    mechanism = "HPA cannot compute CPU utilization because the target container has no CPU request";
  } else {
    const svcName = `${caseId}-missing-svc`;
    objs.push({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: meta(`${caseId}-ing`, caseId),
      spec: {
        ingressClassName: "nginx",
        rules: [{ host: `${caseId}.eval.local`, http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: svcName, port: { number: 80 } } } }] } }],
      },
    });
    mechanism = `Ingress backend points to missing Service ${svcName}`;
  }
  addCase({
    id: caseId,
    category: "controller",
    title: mechanism,
    difficulty: "medium",
    targets: objs.map((o) => `${o.kind.toLowerCase()}/${o.metadata.name}`),
    symptom: `Controller-managed workload ${dep} is not serving traffic or not progressing.`,
    groundTruth: { localization: objs[0].kind === "Ingress" ? `ingress/${caseId}-ing` : `deployment/${dep}`, mechanism, scope: "controller object and its owned resources" },
    expectedSignals: ["rollout status", "replicas/pods", "HPA conditions", "Ingress backend"],
  }, objs);
}

// 86-93: Volcano/GPU batch scheduling.
[
  ["minMember exceeds pods", "podgroup-minmember", "Volcano PodGroup has minMember=2 but only one grouped pod exists"],
  ["queue does not exist", "podgroup-missing-queue", "Volcano PodGroup references a nonexistent queue"],
  ["gpu count impossible", { tasks: [{ replicas: 1, name: "trainer", template: { spec: { restartPolicy: "Never", containers: [busyContainer("trainer", "sleep 3600", { resources: { limits: { "nvidia.com/gpu": "999" } } })] } } }] }, "Volcano task requests impossible GPU count"],
  ["wrong gpu type selector", { tasks: [{ replicas: 1, name: "trainer", template: { spec: { restartPolicy: "Never", nodeSelector: { "scitix.ai/gpu-type": "a100-missing" }, containers: [busyContainer("trainer", "sleep 3600", { resources: { limits: { "nvidia.com/gpu": "1" } } })] } } }] }, "Volcano task requires unavailable GPU type a100-missing"],
  ["bad priority class", { priorityClassName: "missing-volcano-priority" }, "Volcano Job references missing priority class"],
  ["min resources too high", { minAvailable: 1, tasks: [{ replicas: 1, name: "trainer", template: { spec: { restartPolicy: "Never", containers: [busyContainer("trainer", "sleep 3600", { resources: { requests: { cpu: "100000", memory: "64Mi" }, limits: { cpu: "100000", memory: "64Mi" } } })] } } }] }, "Volcano task CPU request is unschedulably high"],
  ["missing config in volcano task", { tasks: [{ replicas: 1, name: "trainer", template: { spec: { restartPolicy: "Never", containers: [busyContainer("trainer", "sleep 3600", { env: [{ name: "MODEL", valueFrom: { configMapKeyRef: { name: "missing-volcano-config", key: "model" } } }] })] } } }] }, "Volcano-created pod cannot start because task env references missing ConfigMap"],
  ["gang plus image pull", { minAvailable: 1, tasks: [{ replicas: 1, name: "trainer", template: { spec: { restartPolicy: "Never", containers: [busyContainer("trainer", "sleep 3600", { image: "registry.invalid/scitix/volcano:v404", imagePullPolicy: "Always" })] } } }] }, "Volcano-created pod is blocked by invalid image pull"],
].forEach(([title, patch, mechanism]) => {
  const caseId = id(n++);
  const name = `${caseId}-vj`;
  if (patch === "podgroup-minmember" || patch === "podgroup-missing-queue") {
    const pgName = `${caseId}-pg`;
    const podName = `${caseId}-vcpod`;
    addCase({
      id: caseId,
      category: "volcano-gpu",
      title,
      difficulty: "hard",
      targets: [`podgroup/${pgName}`, `pod/${podName}`],
      symptom: `Volcano GPU training pod ${podName} remains pending with PodGroup ${pgName}.`,
      groundTruth: { localization: `podgroup/${pgName}`, mechanism, scope: "Volcano podgroup / grouped pod" },
      expectedSignals: ["PodGroup spec/status", "grouped pod annotation", "Volcano scheduling events"],
    }, [
      volcanoPodGroup(caseId, pgName, patch === "podgroup-minmember" ? { minMember: 2 } : { minMember: 1, queue: "siclaw-missing-queue" }),
      {
        ...volcanoGroupedPod(caseId, podName, pgName),
        metadata: {
          ...meta(podName, caseId),
          annotations: { "scheduling.k8s.io/group-name": pgName },
        },
      },
    ]);
    return;
  }
  addCase({
    id: caseId,
    category: "volcano-gpu",
    title,
    difficulty: "hard",
    targets: [`job.batch.volcano.sh/${name}`],
    symptom: `Volcano GPU training job ${name} is not admitted/running as expected.`,
    groundTruth: { localization: `job.batch.volcano.sh/${name}`, mechanism, scope: "Volcano job / podgroup / owned pods" },
    expectedSignals: ["Volcano Job status", "PodGroup status", "owned pod events", "queue"],
  }, [volcanoJob(caseId, name, patch)]);
});

// 94-100: compound multi-root-cause incidents with distractors.
[
  {
    title: "service selector plus readiness probe",
    mechanism: "Service selector is wrong and the deployment readiness probe also points to a missing path",
    objs(caseId) {
      const app = `${caseId}-compound-app`;
      return [
        deployment(caseId, app, { app }, busyContainer("http", "mkdir -p /www && echo ok >/www/index.html && httpd -f -p 8080 -h /www", {
          ports: [{ containerPort: 8080 }],
          readinessProbe: { httpGet: { path: "/missing", port: 8080 }, initialDelaySeconds: 1, periodSeconds: 3 },
        })),
        service(caseId, `${caseId}-compound-svc`, { app: `${app}-typo` }, 80, 8080),
      ];
    },
  },
  {
    title: "GPU selector plus missing config",
    mechanism: "Pod has an unavailable GPU nodeSelector and also references a missing ConfigMap",
    objs(caseId) {
      return [
        pod(caseId, `${caseId}-compound-gpu`, {
          nodeSelector: { "scitix.ai/gpu-type": "h100-missing" },
          containers: [busyContainer("trainer", "sleep 3600", {
            resources: { limits: { "nvidia.com/gpu": "1" } },
            env: [{ name: "MODEL", valueFrom: { configMapKeyRef: { name: "missing-compound-config", key: "model" } } }],
          })],
        }),
      ];
    },
  },
  {
    title: "PVC pending plus service mismatch",
    mechanism: "Dataset PVC uses a missing storageClass and the Service selector does not match the app",
    objs(caseId) {
      const app = `${caseId}-compound-storage`;
      const claim = `${caseId}-compound-pvc`;
      return [
        pvc(caseId, claim, "missing-fast-gpu-ssd"),
        deployment(caseId, app, { app }, busyContainer("http", "sleep 3600", { volumeMounts: [{ name: "data", mountPath: "/data" }] }), {
          podSpec: { volumes: [{ name: "data", persistentVolumeClaim: { claimName: claim } }] },
        }),
        service(caseId, `${caseId}-compound-svc`, { app: `${app}-typo` }, 80, 8080),
      ];
    },
  },
  {
    title: "network deny plus DNS override",
    mechanism: "Client has invalid DNS config and a NetworkPolicy denying all egress",
    objs(caseId) {
      const client = `${caseId}-compound-client`;
      const cl = { app: client };
      return [
        pod(caseId, client, {
          dnsPolicy: "None",
          dnsConfig: { nameservers: ["203.0.113.1"] },
          containers: [busyContainer("client", "sleep 3600")],
        }, cl),
        networkPolicy(caseId, `${caseId}-compound-deny-egress`, cl, ["Egress"], [], []),
      ];
    },
  },
  {
    title: "Volcano queue plus GPU type",
    mechanism: "Volcano Job references a missing queue and requests an unavailable GPU type",
    objs(caseId) {
      return [
        volcanoPodGroup(caseId, `${caseId}-compound-pg`, { minMember: 1, queue: "siclaw-missing-queue" }),
        {
          ...volcanoGroupedPod(caseId, `${caseId}-compound-vcpod`, `${caseId}-compound-pg`, {
            nodeSelector: { "scitix.ai/gpu-type": "a100-missing" },
            containers: [busyContainer("trainer", "sleep 3600", { resources: { limits: { "nvidia.com/gpu": "1" } } })],
          }),
          metadata: {
            ...meta(`${caseId}-compound-vcpod`, caseId),
            annotations: { "scheduling.k8s.io/group-name": `${caseId}-compound-pg` },
          },
        },
      ];
    },
  },
  {
    title: "bad image plus HPA no requests",
    mechanism: "Deployment pods cannot pull the image and its HPA cannot compute CPU utilization because requests are absent",
    objs(caseId) {
      const dep = `${caseId}-compound-deploy`;
      return [
        deployment(caseId, dep, { app: dep }, busyContainer("app", "sleep 3600", { image: "registry.invalid/scitix/compound:v404", imagePullPolicy: "Always" })),
        hpa(caseId, `${caseId}-compound-hpa`, dep),
      ];
    },
  },
  {
    title: "scheduler profile plus NCCL env",
    mechanism: "Pod uses a nonexistent GPU scheduler profile and the container command would also fail due bad NCCL interface",
    objs(caseId) {
      return [
        pod(caseId, `${caseId}-compound-runtime`, {
          schedulerName: "gpu-scheduler-profile-missing",
          containers: [busyContainer("trainer", "echo 'NCCL_SOCKET_IFNAME=eth9 not found'; exit 45")],
        }),
      ];
    },
  },
].forEach((entry) => {
  const caseId = id(n++);
  const objs = entry.objs(caseId);
  addCase({
    id: caseId,
    category: "compound",
    title: entry.title,
    difficulty: "hard",
    noise: true,
    targets: objs.map((o) => `${o.kind.toLowerCase()}/${o.metadata.name}`),
    symptom: `Compound incident ${caseId}: a GPU-related service or training workflow has multiple symptoms. Diagnose all root causes, not just the first anomaly.`,
    groundTruth: { localization: objs.map((o) => `${o.kind.toLowerCase()}/${o.metadata.name}`).join(", "), mechanism: entry.mechanism, scope: "multi-resource compound failure in the eval namespace" },
    expectedSignals: ["multiple resources", "events", "spec mismatch", "avoid anchoring on first anomaly"],
  }, objs);
});

if (cases.length !== 100) {
  throw new Error(`expected 100 cases, got ${cases.length}`);
}

const namespaceObj = {
  apiVersion: "v1",
  kind: "Namespace",
  metadata: { name: NS, labels: { [LABEL_RUN]: RUN } },
};

const docs = [namespaceObj, ...resources].map((obj) => yaml.dump(obj, { noRefs: true })).join("---\n");
fs.mkdirSync(path.join(ROOT, "cases"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "cases", "cases.json"), JSON.stringify(cases, null, 2) + "\n");
fs.writeFileSync(path.join(ROOT, "cases", "manifests.yaml"), docs);

for (const c of cases) {
  const promptPath = path.join(ROOT, "logs", c.id, "prompt.txt");
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, casePrompt(c));
}

const apply = process.argv.includes("--apply");
if (apply) {
  const res = spawnSync("kubectl", ["apply", "-f", "-"], {
    input: docs,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  process.stdout.write(res.stdout);
  process.stderr.write(res.stderr);
  if (res.status !== 0) process.exit(res.status ?? 1);
}

console.log(JSON.stringify({
  namespace: NS,
  cases: cases.length,
  resources: resources.length,
  manifest: path.join(ROOT, "cases", "manifests.yaml"),
  casesFile: path.join(ROOT, "cases", "cases.json"),
}));
