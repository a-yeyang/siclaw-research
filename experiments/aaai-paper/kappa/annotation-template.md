# Human annotation for judge validation (κ)

**You are the human expert here.** For each of the 20 cases below, read the **AGENT DIAGNOSIS** and answer the 5 Yes/No questions, comparing against the **GROUND TRUTH**. Write `Yes` or `No` in each `[ ]`. Don't overthink — your honest judgment is the point.

- "Yes" = the diagnosis satisfies that question. "No" = it doesn't (wrong, missing, or vague).
- You are NOT shown the LLM judge's answers (so your labels are unbiased). We later compute how often you and the judge agree (Cohen's κ).
- ~5–10 min total. When done, save this file and run `compute-kappa.mjs`.

---

## 1. c001 (image-pull, easy)
**Symptom:** GPU workload pod c001-image never starts and is reported around ImagePullBackOff/ErrImagePull.

**GROUND TRUTH** — localization: `pod/c001-image`; mechanism: image registry host/tag is invalid and cannot be pulled; scope: single pod image startup

**AGENT DIAGNOSIS:**
> The evidence is clear. Here's my diagnosis:
> 
> ---
> 
> ## Diagnosis: c001-image — ImagePullBackOff
> 
> **Root cause:** The image `registry.invalid/scitix/missing-trainer:v404` references a non-existent/invalid registry hostname.
> 
> **Evidence from containerd logs on node `cpu-10-208-55-85`:**
> 
> ```
> level=error error="...dial tcp: lookup registry.invalid on 10.208.12.100:53: no such host"
> ```
> 
> DNS resolution fails because `registry.invalid` is a **reserved TLD** specifically designated by [RFC 6761 §6.4](https://datatracker.ietf.org/doc/html/rfc6761#section-6.4) for "testing" and does not resolve in any real DNS system. The node's DNS server (10.208.12.100) returns **NXDOMAIN / no such host**.
> 
> This is corroborated by:
> - The image name itself: `registry.invalid/scitix/missing-trainer:v404` — both the registry hostname and the tag `v404` (HTTP 404) are literal indicators of intentional non-existence.
> - The pod manifest (created via `kubectl.kubernetes.io/last-applied-configuration`) confirms the image is **not a typo** — it was intentionally set to this value.
> 
> **Impact/scope:** Single pod `c001-image` (namespace `siclaw-eval-yye-20260602`). Pending status, cannot start. No other pods are affected.
> 
> **Confidence:** High — the error is unambiguous and consistently replicated across ~4000 pull attempts over 15 hours.
> 
> **Safe remediation:** Replace the image reference with a valid one, e.g.:
> ```yaml
> image: registry.example.com/scitix/trainer:v1.2.3
> ```
> Or, if testing locally, use a locally available image or set `imagePullPolicy: Neve

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 2. c002 (image-pull, easy)
**Symptom:** GPU workload pod c002-image never starts and is reported around ImagePullBackOff/ErrImagePull.

**GROUND TRUTH** — localization: `pod/c002-image`; mechanism: image repository does not exist; scope: single pod image startup

**AGENT DIAGNOSIS:**
> The containerd logs are crystal clear. Here's the full diagnosis:
> 
> ---
> 
> ## Diagnosis: pod/c002-image — ImagePullBackOff
> 
> **Root cause:** The pod is configured with the image `docker.io/library/siclaw-does-not-exist:v1`, which **does not exist on Docker Hub**. containerd's error message is:
> 
> ```
> pull access denied, repository does not exist or may require authorization: 
>   server message: insufficient_scope: authorization failed
> ```
> 
> Docker Hub confirms the repository `library/siclaw-does-not-exist` does not exist — it's not an auth/permissions issue, the image simply was never pushed (or the name is misspelled).
> 
> **Evidence:**
> - Pod `c002-image` on node `cpu-10-208-55-85` has been in `ImagePullBackOff` for 15+ hours
> - Events show only generic `Back-off pulling image` (no additional detail)
> - containerd logs (from `cpu-10-208-55-85`) show repeated pull attempts all failing with the same `insufficient_scope` / `repository does not exist` error
> - Image name `siclaw-does-not-exist` is suggestive — this appears to be an intentionally non-existent test image
> 
> **Impact / scope:**
> - Single pod `c002-image` only — no other resources are affected
> - The pod has been stuck for 15h, unable to start its `main` container
> 
> **Confidence:** High — direct containerd error message matches a `not found` / `manifest unknown` pattern
> 
> **Safe remediation:**
> 1. Correct the image name to a valid Docker Hub image (e.g. `library/ubuntu:22.04`, `library/alpine:latest`, or whatever image the workload actually needs)
> 2. Update the pod/pod template

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 3. c011 (crashloop, easy)
**Symptom:** Training pod c011-crash repeatedly restarts before becoming ready.

**GROUND TRUTH** — localization: `pod/c011-crash`; mechanism: required MODEL_PATH env var is absent; scope: single container crash loop

**AGENT DIAGNOSIS:**
> Confirmed — no environment variables at all.
> 
> ## Diagnosis
> 
> **Root cause:** The pod's container command checks for the environment variable `MODEL_PATH` with `test -n "$MODEL_PATH"`, and exits with code 42 if it's missing. The pod spec defines **no environment variables** (`Environment: <none>` in `describe`), so `MODEL_PATH` is unset/empty on every start, the `test -n` fails, and the container immediately terminates.
> 
> **Evidence:**
> - Pod `c011-crash` is in `CrashLoopBackOff` with 182 restarts in 15h.
> - Container command: `sh -c 'test -n "$MODEL_PATH" || { echo "fatal: MODEL_PATH missing"; exit 42; }; sleep 3600'`
> - Last container exit code: **42** (the code from the `exit 42` in the script when `MODEL_PATH` is missing).
> - Exit happens immediately — the container lasted only ~0 seconds (Started and Finished at the same timestamp).
> - `kubectl describe` shows `Environment: <none>` and `kubectl get ... -o jsonpath='{.spec.containers[0].env}'` returns nothing — no env vars are injected.
> - Node: `cpu-10-208-55-85`, image `busybox:1.36`.
> 
> **Impact:** The pod never reaches Ready. With 182 restarts, it has been consuming cluster resources (container runtime, network, scheduling) for 15h with zero productive work.
> 
> **Confidence:** High. The exit code 42 matches the script's own failure branch, and the absence of env vars is confirmed.
> 
> **Remediation (safe, read-only suggestion):** Add the `MODEL_PATH` environment variable to the pod spec, e.g.:
> 
> ```yaml
> env:
>   - name: MODEL_PATH
>     value: "/models/my-model"
> ```
> 
> If this pod is man

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 4. c012 (crashloop, easy)
**Symptom:** Training pod c012-crash repeatedly restarts before becoming ready.

**GROUND TRUTH** — localization: `pod/c012-crash`; mechanism: CUDA_VISIBLE_DEVICES is mis-set for the workload; scope: single container crash loop

**AGENT DIAGNOSIS:**
> This pod doesn't use Volcano (no PodGroup). The picture is clear. Here's the diagnosis:
> 
> ---
> 
> ## Diagnosis: pod/c012-crash — CrashLoopBackOff
> 
> ### Root Cause
> 
> The pod's container command is a shell check on `$CUDA_VISIBLE_DEVICES`:
> 
> ```sh
> test "$CUDA_VISIBLE_DEVICES" = all || { echo 'cuda devices masked'; exit 43; }
> ```
> 
> The pod **does not set the `CUDA_VISIBLE_DEVICES` environment variable** — no `env`, no `envFrom`, no GPU resource request (`resources` is empty `{}`). Since the variable is unset, the test evaluates as `"" != "all"`, the script prints `'cuda devices masked'` and exits with code 43, which kubelet interprets as a container failure and restarts immediately.
> 
> ### Evidence
> 
> | Source | Detail |
> |---|---|
> | Pod spec command | `sh -c 'test "$CUDA_VISIBLE_DEVICES" = all \|\| { echo "cuda devices masked"; exit 43; }'` |
> | Pod env | **Empty** — `"env": null` |
> | Pod resources | **Empty** — `"resources": {}` (no GPU requested) |
> | Container logs (current & previous) | `cuda devices masked` |
> | Exit code | 43 (custom error, matches the `exit 43` in the script) |
> | Restarts | 182 times over 15h |
> 
> ### Impact & Scope
> 
> - The pod **never becomes Ready** — it has been in CrashLoopBackOff for 15 hours.
> - Only this pod is affected; it runs on CPU node `cpu-10-208-55-85` (no GPU capacity, but the pod also requests no GPU).
> 
> ### Confidence
> 
> **High** — the root cause is directly visible in the container command and pod spec. No other factors involved.
> 
> ### Safe Remediation
> 
> To fix this, the pod spec need

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 5. c021 (config, easy)
**Symptom:** Pod c021-config is stuck during container configuration or volume setup.

**GROUND TRUTH** — localization: `pod/c021-config`; mechanism: ConfigMap missing-model-config/key bucket is absent; scope: single pod configuration dependency

**AGENT DIAGNOSIS:**
> The diagnosis is clear. Here's the full analysis:
> 
> ---
> 
> ## Diagnosis: Pod `c021-config` — `CreateContainerConfigError`
> 
> ### Root Cause
> 
> The pod references a ConfigMap `missing-model-config` that does not exist in the namespace `siclaw-eval-yye-20260602`.
> 
> In the pod spec, the environment variable `MODEL_BUCKET` is defined via:
> ```yaml
> env:
>   - name: MODEL_BUCKET
>     valueFrom:
>       configMapKeyRef:
>         key: bucket
>         name: missing-model-config    # <-- this ConfigMap doesn't exist
> ```
> 
> The Kubelet tries to resolve this ConfigMap before starting the container. Since it can't be found, the container never starts — it's stuck in `CreateContainerConfigError` with the message: **`configmap "missing-model-config" not found`**.
> 
> ### Evidence
> 
> - **Pod status**: `CreateContainerConfigError` (phase: `Pending`)
> - **Container state**: `state.waiting.reason: CreateContainerConfigError`, `state.waiting.message: configmap "missing-model-config" not found`
> - **Events**: No Warning events — the error is surfaced directly in the container status, not as a separate event (the repeated `Pulled` events confirm the image is local, so pull is fine).
> - The pod has been stuck for **15 hours**.
> 
> ### Impact / Scope
> 
> - Only this single pod (`c021-config`) is affected.
> - The pod was scheduled successfully on node `cpu-10-208-55-85` and the container image `busybox:1.36` is present. Everything else is healthy — the pod is purely blocked by the missing ConfigMap reference.
> 
> ### Confidence
> 
> **High** — the error message, the 

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 6. c022 (config, easy)
**Symptom:** Pod c022-config is stuck during container configuration or volume setup.

**GROUND TRUTH** — localization: `pod/c022-config`; mechanism: Secret missing-registry-secret/key token is absent; scope: single pod configuration dependency

**AGENT DIAGNOSIS:**
> The diagnosis is clear.
> 
> ## Case c022 — Diagnosis Complete
> 
> **Root Cause:** The pod references a Secret `missing-registry-secret` (via `env.valueFrom.secretKeyRef`) that does not exist in the namespace. This prevents the container from being created.
> 
> **Evidence:**
> - Pod status: `CreateContainerConfigError`
> - Container `trainer` state: `Waiting` with reason `CreateContainerConfigError` and message `secret "missing-registry-secret" not found`
> - The environment variable `REGISTRY_TOKEN` is defined with `valueFrom.secretKeyRef.name: missing-registry-secret` — confirming the pod's env var depends on this secret
> - `kubectl get secret missing-registry-secret -n siclaw-eval-yye-20260602` returns **NotFound**
> - The image (`busybox:1.36`) is already pulled and present on the node — the issue is purely the missing secret, not the image
> 
> **Impact/Scope:** Single pod `c022-config` in namespace `siclaw-eval-yye-20260602`. The pod has been stuck for 15 hours since creation. No other workloads appear affected.
> 
> **Confidence:** High — the error message explicitly identifies the missing secret.
> 
> **Safe Remediation (suggestion, not action):**
> 1. **Create the secret** in the namespace: `kubectl create secret generic missing-registry-secret --from-literal=token=<actual-token> -n siclaw-eval-yye-20260602` — the pod should automatically recover after the secret is created.
> 2. **Alternatively**, if the `REGISTRY_TOKEN` env var is not needed, edit the pod spec to remove the env entry and delete/recreate the pod.

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 7. c040 (scheduling-gpu, easy)
**Symptom:** GPU or training pod c040-pending remains Pending / unscheduled.

**GROUND TRUTH** — localization: `pod/c040-pending`; mechanism: required anti-affinity conflicts with broad existing eval labels; scope: single workload scheduling constraint

**AGENT DIAGNOSIS:**
> The pod `c040-pending` is currently in **Running** state, not Pending. It has been successfully scheduled on node `hpe-node144` and is actively running with 15 restarts recorded. The last 16 events show normal container lifecycle operations (created, started, pulled) without any scheduling errors or resource constraints indicated.
> 
> **Evidence**:
> - `Status: Running` with active container execution.
> - No `FailedScheduling` events or taint/node-selector mismatches.
> - Resource requests (20m CPU, 32Mi memory) are well within typical node capacity.
> - Node labels and taints were not explicitly restricted in the pod spec.
> 
> **Scope/Impact**: 
> The pod is now operational. Historical restarts (15x) suggest the container exits after `sleep 3600` completes, triggering kubelet restarts. This is expected behavior for the current spec.
> 
> **Confidence**: High (based on live pod status and event history).
> 
> **Remediation**:
> - If the goal is to keep the container running indefinitely, replace `sleep 3600` with a persistent process (e.g., `tail -f /dev/null`).
> - If the Pending state was observed earlier, verify node availability and resource constraints at the time using historical metrics (outside current read-only scope).

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 8. c031 (scheduling-gpu, easy)
**Symptom:** GPU or training pod c031-pending remains Pending / unscheduled.

**GROUND TRUTH** — localization: `pod/c031-pending`; mechanism: nodeSelector asks for unavailable GPU type h100-pcie-80gb; scope: single workload scheduling constraint

**AGENT DIAGNOSIS:**
> All evidence is clear. Here's the diagnosis:
> 
> ---
> 
> ## Diagnosis: Pod `c031-pending` stuck Pending
> 
> ### Root Cause: Node selector mismatch — no node has `scitix.ai/gpu-type=h100-pcie-80gb`
> 
> The pod has:
> 
> ```yaml
> nodeSelector:
>   scitix.ai/gpu-type: h100-pcie-80gb
> ```
> 
> But the cluster's GPU node label is `scitix.ai/gpu-type=h100nvlink80` — not `h100-pcie-80gb`. The 368 nodes in the cluster are:
> - **Fake/KWOK nodes** (119) — tainted `kwok.x-k8s.io/node: fake`, unschedulable
> - **Unreachable nodes** (233) — tainted `node.kubernetes.io/unreachable`
> - **Real nodes** that are Ready: `gpu-10-208-55-159` (scitix.ai/gpu-type=h100nvlink80) and `hpe-node144` (scitix.ai/gpu-type=h100nvlink80), plus `cpu-10-208-55-85` and `cpu-10-208-55-86` (CPU-only, no gpu-type label)
> - **Control-plane node** (1) and **nodecheck-tainted node** (1) — also filtered out
> 
> The scheduler message confirms: **"5 node(s) didn't match Pod's node affinity/selector"** — those 5 include the 2 real GPU nodes and up to 3 others, none of which carry `h100-pcie-80gb`.
> 
> ### Evidence
> 1. Pod events: `FailedScheduling` — `0/368 nodes are available: ... 5 node(s) didn't match Pod's node affinity/selector`
> 2. Pod spec: `nodeSelector: {scitix.ai/gpu-type: h100-pcie-80gb}`
> 3. Real GPU nodes (`gpu-10-208-55-159`, `hpe-node144`) have `scitix.ai/gpu-type=h100nvlink80`
> 
> ### Additional note
> The pod uses `schedulerName: default-scheduler` rather than Volcano's scheduler. On this cluster this doesn't appear to be a problem (other pods also use default-scheduler), but the node se

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 9. c046 (storage, easy)
**Symptom:** Training pod c046-storage cannot start because its dataset PVC c046-data is not bound.

**GROUND TRUTH** — localization: `pvc/c046-data`; mechanism: PVC requests nonexistent storageClass missing-storageclass; scope: pod blocked by unbound PVC

**AGENT DIAGNOSIS:**
> ```诊断
> Root Cause: 
> - PVC c046-data references non-existent StorageClass "missing-storageclass"
> 
> Evidence:
> - PVC spec.storageClassName: "missing-storageclass"
> - No StorageClass with this name exists in the cluster (kubectl get storageclass returns empty)
> 
> Impact:
> - Pod c046-storage cannot start due to unbound PVC
> - Storage provisioning blocked for this workload
> 
> Confidence: High (direct configuration mismatch)
> 
> Remediation:
> 1. Create StorageClass "missing-storageclass" with appropriate provisioner parameters
> 2. OR update PVC to use an existing StorageClass (e.g. standard, fast, etc.)
> 3. Ensure StorageClass parameters match required access modes (ReadWriteOnce) and storage capacity (1Gi)
> ```

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 10. c047 (storage, easy)
**Symptom:** Training pod c047-storage cannot start because its dataset PVC c047-data is not bound.

**GROUND TRUTH** — localization: `pvc/c047-data`; mechanism: PVC requests nonexistent storageClass gpu-local-ssd-missing; scope: pod blocked by unbound PVC

**AGENT DIAGNOSIS:**
> ```
> Root Cause: 
> - The PVC c047-data references a non-existent StorageClass "gpu-local-ssd-missing". 
> - No matching StorageClass exists in the cluster (confirmed by kubectl get storageclass).
> 
> Evidence:
> - PVC status: Pending with "ProvisioningFailed" events showing "storageclass.storage.k8s.io not found".
> - kubectl get storageclass confirms no StorageClass named "gpu-local-ssd-missing" or "gpu-local-ssd" exists.
> 
> Scope/Impact:
> - Affects pod c047-storage in namespace siclaw-eval-yye-20260602.
> - Prevents PVC binding and pod startup due to missing storage provisioning configuration.
> 
> Confidence: High (directly confirmed by PVC events and StorageClass query).
> 
> Remediation:
> 1. Create the missing StorageClass "gpu-local-ssd-missing" with appropriate provisioner/config.
> 2. OR update PVC c047-data to use an existing StorageClass (e.g., verify correct name and update spec.storageClassName).
> 3. Ensure storage provisioner for the class is properly deployed and operational.
> ```

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 11. c056 (service-readiness, medium)
**Symptom:** Internal service c056-svc for workload c056-app is unavailable to clients.

**GROUND TRUTH** — localization: `deployment/c056-app`; mechanism: readiness probe points to a missing health endpoint, so endpoints are not ready; scope: one service path in the eval namespace

**AGENT DIAGNOSIS:**
> ```mermaid
> flowchart LR
>     A[Service c056-svc] --> B[Pod c056-app-5b6f4b457c-dqfh6]
>     B --> C[Readiness Probe Failure]
>     C --> D[HTTP 404 on /missing-healthz]
>     D --> E[Pod Not Ready]
>     E --> F[Service Endpoints Unavailable]
>     
>     classDef rootCause fill:#ff4757;
>     classDef evidence fill:#2ecc71;
>     classDef impact fill:#f1c40f;
>     
>     D -->|Root Cause| G[Incorrect readiness probe path]
>     B -->|Evidence| H[Pod IP 172.16.36.194 running busybox httpd]
>     E -->|Impact| I[Service cannot route traffic to backend]
>     
>     G --> J[Confidence: High]
>     J --> K[100% of probe failures match 404 pattern]
>     
>     L[Remediation] --> M[Update readinessProbe path to /index.html]
> ```

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 12. c057 (service-readiness, medium)
**Symptom:** Internal service c057-svc for workload c057-app is unavailable to clients.

**GROUND TRUTH** — localization: `service/c057-svc`; mechanism: Service selector does not match the backing pod labels, so endpoints are empty; scope: one service path in the eval namespace

**AGENT DIAGNOSIS:**
> **Diagnosis:**
> 
> - **Root Cause:** Mismatch between service selector and deployment labels.  
>   The service `c057-svc` uses selector `app=c057-app-typo`, but the deployment `c057-app` labels pods with `app=c057-app`. This typo prevents the service from binding to any pods.
> 
> - **Evidence:**  
>   - Deployment `c057-app` has label selector `app=c057-app` and 1 ready pod.  
>   - Service `c057-svc` has selector `app=c057-app-typo` (mismatched).  
>   - No endpoints exist for the service (`kubectl get endpoints c057-svc` would show `<none>`).
> 
> - **Impact/Scope:**  
>   The service is unreachable cluster-internal and externally (if exposed). All clients relying on `c057-svc` are affected.
> 
> - **Confidence:** High (selector mismatch is a direct and common cause of service unavailability).
> 
> - **Remediation:**  
>   Update the service `c057-svc` to use selector `app=c057-app` to match the deployment's pod labels. Example:
>   ```yaml
>   spec:
>     selector:
>       app: c057-app  # Corrected from "c057-app-typo"
>   ```

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 13. c069 (network-dns, medium)
**Symptom:** Client pod c069-client cannot resolve or reach service c069-server-svc even though the server pod exists.

**GROUND TRUTH** — localization: `networkpolicy/c069-deny-ingress`; mechanism: NetworkPolicy selects the server and denies all ingress from the client; scope: traffic involving this case's client/server pods

**AGENT DIAGNOSIS:**
> ```json
> {
>   "rootCause": "DNS resolution failure in the client pod due to missing search domain configuration for the service's namespace.",
>   "evidence": [
>     "nslookup c069-server-svc in the client pod returned NXDOMAIN",
>     "Full FQDN c069-server-svc.siclaw-eval-yye-20260602.svc.cluster.local resolves correctly",
>     "/etc/resolv.conf in the client pod shows search domains missing the namespace-specific suffix"
>   ],
>   "scope": "Affects all services in the siclaw-eval-yye-20260602 namespace requiring DNS-based discovery",
>   "confidence": 95,
>   "remediation": "Ensure client applications use fully qualified domain names (FQDNs) including namespace or configure DNS search domains to include <namespace>.svc.cluster.local"
> }
> ```

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 14. c072 (network-dns, medium)
**Symptom:** Client pod c072-client cannot resolve or reach service c072-server-svc even though the server pod exists.

**GROUND TRUTH** — localization: `networkpolicy/c072-deny-ingress`; mechanism: NetworkPolicy selects the server and denies all ingress from the client; scope: traffic involving this case's client/server pods

**AGENT DIAGNOSIS:**
> <think>
> Okay, let me try to figure out what's going on here. The user's client pod can't resolve the server service, but when they use the FQDN, it works. The DNS lookup showed that the short name isn't resolving, but the search domains in the resolv.conf include the namespace and cluster domains. The search line in resolv.conf should append those domains to the short name.
> 
> Wait, the options line says ndots:5. That means that if a name has fewer than 5 dots, it will be tried with the search domains. But in the nslookup output, even when using the FQDN, it's resolving. Hmm, maybe the problem is that the service name is being treated as a fully qualified domain name (FQDN) even when it's not. Let me check the DNS configuration again.
> 
> The search domains are set to siclaw-eval-yye-20260602.svc.cluster.local, svc.cluster.local, and cluster.local. When the client pod tries to resolve "c072-server-svc", the resolver should append each of these domains in order. But the nslookup output shows that it's trying "c072-server-svc.cluster.local" and "c072-server-svc.svc.cluster.local" but not the namespace-specific one. Wait, the search domains include the namespace, so it should try "c072-server-svc.siclaw-eval-yye-20260602.svc.cluster.local" first. But in the nslookup output, that's the one that works. However, the user's command was just "nslookup c072-server-svc", which should trigger the search domains.
> 
> Wait, the nslookup output shows that when the user ran "nslookup c072-server-svc", it tried the FQDN but got NXDOMAIN. However, when they explicitly used the FQDN, i

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 15. c079 (controller, medium)
**Symptom:** Controller-managed workload c079-deploy is not serving traffic or not progressing.

**GROUND TRUTH** — localization: `deployment/c079-deploy`; mechanism: Deployment pods run but readiness probe targets port 9090 instead of 8080; scope: controller object and its owned resources

**AGENT DIAGNOSIS:**
> <think>
> Okay, let's see. The user is having an issue with their Kubernetes deployment, c079-deploy, not serving traffic or progressing. So far, I've checked the deployment status, which shows that there's 1 desired replica but 0 available. The pod is running but not ready. I tried to get the logs, but there were no outputs, which is odd.
> 
> Hmm, maybe the container isn't producing any logs, or the application isn't starting at all. Let me check the pod's events again. The describe output didn't show any events, which is unusual. If the pod is running but not ready, there should be some events indicating why. Wait, maybe the pod is stuck in a CrashLoopBackOff, but the status is showing Running. That doesn't make sense. Let me check the pod's status again.
> 
> Wait, the pod's status is Running, but the readiness is 0/1. That could mean the container is running but not passing the readiness probe. Let me check the deployment's YAML for the readiness probe configuration. If the probe is misconfigured, the pod might not be marked as ready. But since I can't access the cluster_info, I need to infer based on available info.
> 
> Alternatively, maybe the application inside the container is not listening on the expected port. If the container is running but the application isn't bound to the correct port, the readiness probe would fail. Let me check the container's ports. The pod's YAML should show the container ports. If the application is using a different port than what's specified, that could be the issue.
> 
> Another possibility is that the pod is scheduled on a node that

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 16. c080 (controller, medium)
**Symptom:** Controller-managed workload c080-deploy is not serving traffic or not progressing.

**GROUND TRUTH** — localization: `deployment/c080-deploy`; mechanism: HPA cannot compute CPU utilization because the target container has no CPU request; scope: controller object and its owned resources

**AGENT DIAGNOSIS:**
> The workload is not serving traffic due to the absence of a Kubernetes Service resource that routes traffic to the deployment's pods. The deployment's pod is running (1/1 replicas available), but no Service exists in the namespace to expose it. This explains why the HorizontalPodAutoscaler (c080-hpa) has no metrics to act on.
> 
> **Root Cause**: Missing Service resource to expose the deployment.
> **Evidence**:
> - `kubectl get services -n siclaw-eval-yye-20260602 -l app=c080-deploy` returned no resources.
> - The deployment's pod (c080-deploy-66ccc578b5-9pgnq) exists and is Running but has no associated Service.
> 
> **Impact**: No external/internal traffic can reach the workload. HPA cannot collect metrics without traffic.
> 
> **Remediation**: Create a Service in the namespace with a selector matching `app=c080-deploy` to expose the deployment. Example:
> ```yaml
> apiVersion: v1
> kind: Service
> metadata:
>   name: c080-svc
>   namespace: siclaw-eval-yye-20260602
> spec:
>   selector:
>     app: c080-deploy
>   ports:
>     - protocol: TCP
>       port: 80
>       targetPort: 1
> ```

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 17. c086 (volcano-gpu, hard)
**Symptom:** Volcano GPU training pod c086-vcpod remains pending with PodGroup c086-pg.

**GROUND TRUTH** — localization: `podgroup/c086-pg`; mechanism: Volcano PodGroup has minMember=2 but only one grouped pod exists; scope: Volcano podgroup / grouped pod

**AGENT DIAGNOSIS:**
> **Diagnosis: Volcano PodGroup Scheduling Failure**
> 
> **Root Cause:**  
> The PodGroup `c086-pg` requires 2 pods to be scheduled, but nodes with GPU resources are tainted with `scitix.ai/nodecheck` and `kwok.x-k8s.io/node: fake` (NoSchedule effect). The target pod `c086-vcpod` lacks tolerations for these taints, preventing scheduling.
> 
> **Concrete Evidence:**  
> 1. Pod `c086-vcpod` has no node selectors and only tolerates `node.kubernetes.io/not-ready`/`unreachable`.
> 2. GPU-qualified nodes (e.g., `gpu-10-208-55-159`, `fake-node-*`) have blocking taints:
>    - `scitix.ai/nodecheck:NoSchedule`
>    - `kwok.x-k8s.io/node: fake:NoSchedule`
> 3. PodGroup `c086-pg` has `MinMember: 2`, requiring all pods to be scheduled before activation.
> 
> **Impact/Scope:**  
> - Affects GPU training workloads in `siclaw-eval-yye-20260602`
> - Blocks 100% of Volcano jobs requiring these nodes
> - Cluster-wide taint policy conflict
> 
> **Confidence:** High (95%) - Direct taint/pod spec mismatch with matching FailedScheduling patterns
> 
> **Safe Remediation:**  
> Add tolerations to `c086-vcpod`'s spec:
> ```yaml
> tolerations:
> - key: "scitix.ai/nodecheck"
>   operator: "Exists"
>   effect: "NoSchedule"
> - key: "kwok.x-k8s.io/node"
>   value: "fake"
>   operator: "Equal"
>   effect: "NoSchedule"
> ```
> 
> This allows the pod to schedule on tainted GPU nodes while maintaining existing tolerations. Verify with `kubectl describe pod c086-vcpod` after update.

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 18. c087 (volcano-gpu, hard)
**Symptom:** Volcano GPU training pod c087-vcpod remains pending with PodGroup c087-pg.

**GROUND TRUTH** — localization: `podgroup/c087-pg`; mechanism: Volcano PodGroup references a nonexistent queue; scope: Volcano podgroup / grouped pod

**AGENT DIAGNOSIS:**
> ```
> Root cause:
> 1. PodGroup references non-existent Volcano queue "siclaw-missing-queue" (actual available queues: default, root)
> 2. No scheduling events recorded for the pod (events: <none>)
> 
> Evidence:
> - PodGroup spec.queue: "siclaw-missing-queue" (not present in kubectl get queues output)
> - kubectl get queues.scheduling.volcano.sh shows only "default" and "root" queues exist
> - Pod remains in Pending state without any scheduling events
> 
> Scope/impact:
> - Affects single PodGroup/pod (c087-pg/c087-vcpod)
> - Likely prevents all pods in this PodGroup from scheduling until queue is corrected
> 
> Confidence: High (queue mismatch is a known Volcano scheduling requirement)
> 
> Remediation:
> 1. Update PodGroup spec.queue to an existing queue (e.g., "default")
> 2. Verify queue has sufficient GPU resources allocated
> 3. Ensure queue weight configuration allows scheduling for this workload
> ```

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 19. c094 (compound, hard)
**Symptom:** Compound incident c094: a GPU-related service or training workflow has multiple symptoms. Diagnose all root causes, not just the first anomaly.

**GROUND TRUTH** — localization: `deployment/c094-compound-app, service/c094-compound-svc`; mechanism: Service selector is wrong and the deployment readiness probe also points to a missing path; scope: multi-resource compound failure in the eval namespace

**AGENT DIAGNOSIS:**
> **Final Diagnosis**
> 
> **Root Causes:**
> 1. **Non-GPU-Enabled Image**: The deployment uses `busybox:1.36`, which lacks GPU support required for the workload.
> 2. **Misconfigured Readiness Probe**: The probe checks for `/missing` instead of the actual `/www/index.html` file created by the container.
> 3. **Service Selector Typo**: The service selector `app=c094-compound-app-typo` does not match the pod's label `app=c094-compound-app`, causing zero endpoints.
> 4. **CPU Node Scheduling**: The pod is scheduled on a CPU-only node (`cpu-10-208-55-85`) with no GPU resources, conflicting with the GPU workload requirement.
> 
> **Evidence:**
> - Deployment uses `busybox:1.36` with no GPU resource requests.
> - Readiness probe fails repeatedly due to missing `/missing` file.
> - Service selector mismatch confirmed by empty endpoints.
> - Node has no GPU allocatable resources (`nvidia.com/gpu: 0`).
> 
> **Impact/Scope:**
> - Deployment remains in `Progressing: False` state.
> - Service is unreachable due to zero endpoints.
> - Workload cannot utilize GPU resources as intended.
> 
> **Confidence:** High (directly observable via deployment spec, pod events, service endpoints, and node resources).
> 
> **Remediation:**
> 1. **Update Deployment Image**: Replace `busybox:

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---

## 20. c097 (compound, hard)
**Symptom:** Compound incident c097: a GPU-related service or training workflow has multiple symptoms. Diagnose all root causes, not just the first anomaly.

**GROUND TRUTH** — localization: `pod/c097-compound-client, networkpolicy/c097-compound-deny-egress`; mechanism: Client has invalid DNS config and a NetworkPolicy denying all egress; scope: multi-resource compound failure in the eval namespace

**AGENT DIAGNOSIS:**
> **Diagnosis: GPU-Related Compound Incident (Case c097)**
> 
> **Root Causes:**
> 1. **CPU Node Scheduling**  
>    - Pod `c097-compound-client` is scheduled on a CPU node (`cpu-10-208-55-86`) with **no GPU resources available**.  
>    - **Evidence**: Node description confirms absence of GPU resources (`rdma/hca_shared_devices_all: 0`), and the pod lacks GPU-specific resource requests/limits.
> 
> 2. **Egress Network Policy Block**  
>    - NetworkPolicy `c097-compound-deny-egress` **denies all egress traffic** for `app=c097-compound-client`, isolating the pod from external/internal services.  
>    - **Evidence**: Policy explicitly blocks egress (`Allowing egress traffic: <none>`), confirmed by `kubectl describe networkpolicy`.
> 
> 3. **High Pod Restart Count**  
>    - Pod has **18 restarts** due to container lifecycle (`sleep 3600`), but the policy and resource misalignment prevent proper GPU workflow execution.  
>    - **Evidence**: Pod events show normal container lifecycle but no GPU-related errors.
> 
> **Impact:**  
> - GPU-dependent workflows fail due to resource unavailability and network isolation.  
> - Application cannot access required services (e.g., model repositories, monitoring, or distributed training components).  
> 
> **Confidence:** High (directly observable via `kubectl describe node`, `kubectl describe pod`, and `kubectl describe networkpolicy`).  
> 
> **Safe Remediation:**  
> 1. **Fix Scheduling**: Add GPU node selectors/affinity to the pod spec to ensure it runs on GPU nodes.  
> 2. **

- **localization**: Did the diagnosis correctly identify the faulty resource (the same pod/deployment/service/node as the ground truth)?  →  [ ]
- **mechanism**: Did it explain the real root-cause mechanism (not just the surface symptom), matching the ground truth?  →  [ ]
- **scope**: Did it correctly state the blast radius / scope (single resource vs service path vs compound)?  →  [ ]
- **evidence**: Did it cite concrete observed evidence (events, describe, logs, YAML) that actually supports the conclusion?  →  [ ]
- **remediation**: Did it propose a fix that would actually address the root cause and is safe?  →  [ ]

---
