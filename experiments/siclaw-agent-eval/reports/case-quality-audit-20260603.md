# Siclaw Failed-Case Quality Audit

Date: 2026-06-03

Scope: audit the 10 cases that still failed the strict automatic checklist after the 100-case Siclaw evaluation and the Claude Sonnet 4.6 hard-case rerun.

## External Benchmark Construction Norms

The relevant open SRE/AIOps benchmarks converge on the same basic case contract:

1. **A case should be a controlled incident, not only a prompt.** SREGym emphasizes live cloud-native environments, fault injectors, realistic noise, and failure modes such as metastable and correlated failures.
2. **A case needs task, context, and oracle.** AIOpsLab frames benchmark problems around the incident-management task level: detection, localization, RCA, and mitigation. The oracle should identify exact fault location, fault type/mechanism, and expected recovery state.
3. **Functional faults are better RCA cases than pure symptoms.** AIOpsLab distinguishes symptomatic faults, which are mostly suitable for detection/localization, from functional faults that have deeper root causes and therefore support RCA/mitigation evaluation.
4. **The injected fault must be observable.** ITBench requires scenario faults to create noticeable effects visible through observability data; ops-lite/PACEBench-style releases go further by keeping injection manifests, causal graphs, environment/result snapshots, labels, and a detector that confirms end-to-end observability before admitting a case.
5. **Noise must be intentional and represented in the oracle.** Realistic noise is good, but accidental confounders should not invalidate the unique ground truth. If multiple blockers are observable, the oracle should separate primary root causes, secondary contributors, and benign/non-root anomalies.
6. **Evaluation should not depend on one brittle string.** AIOpsLab allows top-k style localization for some tasks and evaluates mitigation by final system state when several fixes are valid. For free-form agent outputs, localization, mechanism, evidence, scope, and remediation should be scored separately.
7. **Trajectories matter.** AIOpsLab records agent actions and system states; SREGym/ITBench-style live tasks rely on bounded agent-environment interaction. Tool traces should be part of failure analysis, not just the final paragraph.

Sources reviewed: SREGym, AIOpsLab, ITBench, SREBench, and ops-lite/PACEBench-style RCA datasets.

## Overall Verdict

The failed results are **not mostly caused by bad cases**. The strict score underestimates several successful or near-successful diagnoses because the final answer omitted an exact `kind/name` string even when the mechanism and evidence were correct.

However, there are two real case-quality concerns:

- `c069` and `c072` have a meaningful oracle/symptom/evidence ambiguity: the prompt says “cannot resolve or reach”, the expected signals include DNS config, and the trace shows DNS lookup behavior that can reasonably pull the agent toward DNS. The oracle, however, accepts only a NetworkPolicy ingress-deny root cause.
- `c041`, `c042`, and `c045` are marked `noise:false`, but the real scheduler events include many unrelated taints/unreachable/fake-node constraints. The selector root cause is valid, but the environment introduces confounders that the oracle does not explicitly model.

The hard compound failures `c095` and `c100` are good cases. Claude found the intended compound mechanisms; strict failure is mainly an answer-format/localization scoring problem.

## Failed Case Audit

| Case | Strict failure pattern | Case-quality verdict | Recommended change |
| --- | --- | --- | --- |
| `c009` | Mechanism/evidence/remediation all high; localization scored 0 because final answer did not print `pod/c009-image` exactly. | Valid case. Minor risk: `private.invalid.local` can look like both bad registry and missing secret, but events support missing imagePullSecret. | Keep case. Add final-answer schema requiring `Faulty resources: [...]`, or let judge map “the pod” to the provided target when evidence is target-scoped. |
| `c041` | Correctly found unavailable GPU selector; also listed taints from scheduler event. Localization exact string missing. | Mostly valid, but environment noise leaks into a `noise:false` scheduling case. | Either mark as noisy, or isolate scheduler cases to a smaller/known node pool, or add oracle allowance for taint confounders while requiring the selector as primary root cause. |
| `c042` | Correctly found selector label with no matching nodes. Localization exact string missing. | Valid. Same scheduler-noise caveat as `c041`, but less harmful because answer stayed on the intended root cause. | Keep, but update judge/localization schema and noise metadata. |
| `c045` | Correctly found impossible arch selector; also listed taints. Localization exact string missing. | Mostly valid, with same accidental scheduler-noise issue. | Keep primary oracle, but add expected scheduler evidence text and tolerated extra findings. |
| `c069` | Agent diagnosed DNS/search-domain issue from `nslookup`; oracle requires `networkpolicy/c069-deny-ingress`. | Case-quality concern. Symptom and evidence are not uniquely aligned to NetworkPolicy. | Split DNS and NetworkPolicy scenarios. For NetworkPolicy cases, prompt should say “FQDN resolves and endpoints exist, but TCP/HTTP connection fails”; expected signals should require policy spec plus reachability test, not generic DNS. |
| `c072` | Same pattern as `c069`; output wandered into DNS reasoning and even leaked `<think>` text. | Case-quality concern plus model output-format issue. | Same fix as `c069`. Add explicit curl/nc evidence against service IP/FQDN and make DNS a control signal, not a competing symptom. |
| `c073` | Mechanism/evidence/remediation high; localization exact `pod/c073-client` missing. Tool budget stopped before `/etc/resolv.conf`. | Valid case, but four-tool budget can block the decisive DNS-config check. | Keep. If evaluating medium RCA rather than triage, allow one more tool call or include DNS config in expected minimal action path. |
| `c082` | Localized `deployment/c082-deploy`; diagnosed invalid image; mechanism/scope low because answer did not spell out ReplicaSet/controller-owned resources. | Valid case. Judge/checklist is too narrow. | Keep. Judge should accept “Deployment image causes owned pod ImagePullBackOff” as equivalent to “new ReplicaSet pods cannot pull image”. Remove unrelated expected signals such as HPA/Ingress unless they are actually part of the case. |
| `c095` | Claude found unavailable GPU nodeSelector and missing ConfigMap, but did not print exact `pod/c095-compound-gpu`; added QoS as non-blocking operational risk. | Good hard compound case. Failure is strict localization/judge issue, not bad case construction. | Keep. Require final `Faulty resources` field; oracle should distinguish blocking root causes from non-root operational risks. |
| `c100` | Claude found nonexistent scheduler profile and bad NCCL env; did not print exact `pod/c100-compound-runtime`; added missing GPU request as extra. | Good hard compound case. Mostly judge/output schema issue. | Keep. Decide whether “missing GPU resource request” is an intended third root cause or tolerated extra; encode it explicitly. |

## Recommended Case-Spec Upgrade

For future 100-case or 1,000-case evaluation, use this schema:

```json
{
  "id": "cXXX",
  "difficulty": "easy|medium|hard",
  "category": "scheduling-gpu|network|image-pull|controller|compound",
  "noise": {
    "intentional": true,
    "allowed_confounders": ["cluster-wide taints", "unrelated unhealthy nodes"]
  },
  "targets_agent_visible": ["pod/foo", "service/bar"],
  "oracle": {
    "primary_root_causes": [
      {
        "resource": "networkpolicy/foo-deny-ingress",
        "mechanism": "ingress policy selects server and denies client",
        "phase": "runtime_connectivity",
        "must_have_evidence": ["FQDN resolves", "endpoints exist", "TCP/HTTP blocked", "policy selects server"]
      }
    ],
    "secondary_root_causes": [],
    "tolerated_extra_findings": ["cluster taints mentioned as scheduler background"],
    "non_root_anomalies": ["normal NXDOMAIN attempts from search-list expansion"]
  },
  "success_criteria": {
    "localization": "top1|top3|all_roots",
    "mechanism": "semantic",
    "evidence": "must cite target-scoped observable signals",
    "mitigation": "safe recommendation or verified state transition"
  }
}
```

## Concrete Next Actions

1. Update the experiment prompt to require a machine-readable final block:

```text
Faulty resources:
- kind/name
Primary root causes:
- ...
Secondary/non-blocking findings:
- ...
```

2. Repair or split `c069` and `c072` before citing them as strict failures.
3. Re-label `c041`, `c042`, `c045` as noisy or isolate them from cluster-wide scheduler confounders.
4. Adjust strict scoring so exact resource naming is a dimension, not an automatic case-level failure when mechanism/evidence/remediation are strong.
5. For compound GPU cases, score “all intended roots found” separately from “extra plausible risks mentioned”.

## Bottom Line

Only `c069` and `c072` look clearly under-specified against current open SRE benchmark norms. `c041`, `c042`, and `c045` need noise/oracle cleanup. The remaining failures are primarily judge strictness or answer-format failures rather than flawed case construction.
