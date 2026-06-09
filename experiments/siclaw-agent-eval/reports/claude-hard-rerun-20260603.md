# Claude Hard-Case Rerun Report

Date: 2026-06-03

## Purpose

The original 100-case Siclaw evaluation completed all cases, but six hard
cases failed the automatic SREGym-style checklist. After the API budget was
increased, these six failed hard cases were rerun with `claude-sonnet-4-6`
through Scitix Anthropic Messages.

## Rerun Configuration

- Provider endpoint: `https://api.scitix.ai/model-api`
- API type: `anthropic-messages`
- Model: `claude-sonnet-4-6`
- Target cluster: `cks-test`
- Namespace: `siclaw-eval-yye-20260602`
- Harness guard: thorough read-only case-local diagnosis
- Timeout: 300 seconds per case
- Concurrency: 1
- Retries: 1
- Baseline logs preserved under:
  `experiments/siclaw-agent-eval/logs/baseline-before-claude-hard-rerun`

## Result Summary

- Rerun attempted: 6 hard failed cases
- Rerun completed: 6/6
- Automatic checklist passed after rerun: 4/6
- Overall 100-case checklist result after rerun: 90/100
- Overall average checklist score after rerun: 0.818

## Per-Case Comparison

| Case | Category | Failure Type | Baseline Score | Claude Score | Claude Auto Pass | Notes |
|---|---|---|---:|---:|---|---|
| c089 | volcano-gpu | wrong GPU type selector | 0.589 | 0.915 | yes | Correctly localized Volcano job and unavailable `a100-missing` GPU selector. |
| c091 | volcano-gpu | min resources too high | 0.519 | 0.924 | yes | Correctly identified unschedulably high CPU request / Volcano resource pressure. |
| c093 | volcano-gpu | gang plus image pull | 0.382 | 0.905 | yes | Correctly traced Volcano-owned pod to invalid image pull. |
| c095 | compound | GPU selector plus missing config | 0.335 | 0.504 | no | Root causes were correctly diagnosed, but the final answer did not name the exact target resource `pod/c095-compound-gpu`; strict localization scored 0. |
| c099 | compound | bad image plus HPA no requests | 0.458 | 0.881 | yes | Correctly identified both image pull and HPA CPU-request failure. |
| c100 | compound | scheduler profile plus NCCL env | 0.486 | 0.567 | no | Root causes were correctly diagnosed, but the final answer did not name exact target resource `pod/c100-compound-runtime`; strict localization scored 0. |

## Manual Review Notes

`c095` and `c100` are important examples where the automatic checklist is
conservative. Claude identified the expected fault mechanisms:

- `c095`: unavailable GPU nodeSelector plus missing ConfigMap dependency.
- `c100`: nonexistent scheduler profile plus bad NCCL interface command.

However, the final answer used case-level and generic pod wording rather than
the exact oracle localization strings. Under the strict automatic rubric, this
is a localization failure even when the root-cause mechanism is correct.

For paper-quality reporting, keep both numbers:

- Automatic strict checklist: 90/100 after Claude rerun.
- Human-reviewed mechanism correctness on the six rerun hard cases: 6/6 found
  the expected fault mechanism, with 2/6 missing exact resource-name
  localization in the final answer.

## Artifacts

- Updated total report:
  `experiments/siclaw-agent-eval/reports/final-report-20260603.md`
- Updated judgments:
  `experiments/siclaw-agent-eval/reports/judgments-20260603.json`
- Per-case reports:
  `experiments/siclaw-agent-eval/reports/per-case`
- Raw rerun logs:
  `experiments/siclaw-agent-eval/logs/c089`
  `experiments/siclaw-agent-eval/logs/c091`
  `experiments/siclaw-agent-eval/logs/c093`
  `experiments/siclaw-agent-eval/logs/c095`
  `experiments/siclaw-agent-eval/logs/c099`
  `experiments/siclaw-agent-eval/logs/c100`
