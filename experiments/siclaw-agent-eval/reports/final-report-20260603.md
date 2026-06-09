# Siclaw Kubernetes/GPU Agent Evaluation Report

Date: 2026-06-03

## Method

本实验参考 SREGym 和 AIOpsLAB 的评测思想：在真实可观测的 Kubernetes 环境中注入故障，给 agent 一个症状级 incident prompt，让 agent 通过集群工具自主收集证据，并按定位、根因机理、影响范围、证据质量、修复建议进行判分。故障以原因而不是症状为 oracle，包含单点故障、噪声资源和多层复合故障。

## Environment

- Target cluster: cks-test
- Namespace: siclaw-eval-yye-20260602
- Model provider: Scitix OpenAI-compatible chat completions
- Model run note: the run started on `deepseek-ai/DeepSeek-V4-Flash`; after repeated US East 503s, the continuation and residual retries were switched to `Qwen/Qwen3-32B` via `https://api-ap.scitix.ai/model-api`. The six hard cases that failed the original checklist were then rerun with `claude-sonnet-4-6` via Scitix Anthropic Messages.
- Guard note: low-cost runs used case-local observation, no `cluster_info`, concise diagnosis, and a four-tool-call budget for residual retries. The Claude hard-case rerun used a more thorough read-only case-local guard without the four-tool-call limit.
- Case count: 100
- Harness: experiments/siclaw-agent-eval/eval-harness.mjs
- Logs: experiments/siclaw-agent-eval/logs

## Overall Result

- Completed cases: 100/100
- Passed cases by checklist: 90/100
- Pass rate: 90.0%
- Average checklist score: 0.818

## Category Summary

| Category | Cases | Completed | Passed | Pass Rate | Avg Score | Avg Tool Calls | Avg Duration |
|---|---:|---:|---:|---:|---:|---:|---:|
| image-pull | 10 | 10 | 9 | 90.0% | 0.843 | 8.1 | 21.9s |
| crashloop | 10 | 10 | 10 | 100.0% | 0.938 | 7.3 | 26.3s |
| config | 10 | 10 | 10 | 100.0% | 0.895 | 6.3 | 21.7s |
| scheduling-gpu | 15 | 15 | 12 | 80.0% | 0.808 | 7.7 | 48.0s |
| storage | 10 | 10 | 10 | 100.0% | 0.863 | 2.5 | 30.9s |
| service-readiness | 12 | 12 | 12 | 100.0% | 0.758 | 6.0 | 62.0s |
| network-dns | 10 | 10 | 7 | 70.0% | 0.780 | 8.4 | 95.6s |
| controller | 8 | 8 | 7 | 87.5% | 0.726 | 5.6 | 64.7s |
| volcano-gpu | 8 | 8 | 8 | 100.0% | 0.833 | 12.5 | 77.6s |
| compound | 7 | 7 | 5 | 71.4% | 0.703 | 11.6 | 73.3s |

## Per-Case Results

| Case | Category | Difficulty | Status | Passed | Score | Tool Calls | Duration | Report |
|---|---|---|---|---:|---:|---:|---:|---|
| c001 | image-pull | easy | completed | yes | 0.929 | 8 | 21.9s | [detail](per-case/c001.md) |
| c002 | image-pull | easy | completed | yes | 0.925 | 8 | 22.3s | [detail](per-case/c002.md) |
| c003 | image-pull | easy | completed | yes | 0.847 | 8 | 28.9s | [detail](per-case/c003.md) |
| c004 | image-pull | easy | completed | yes | 0.887 | 7 | 21.4s | [detail](per-case/c004.md) |
| c005 | image-pull | easy | completed | yes | 0.828 | 8 | 24.1s | [detail](per-case/c005.md) |
| c006 | image-pull | easy | completed | yes | 0.857 | 9 | 28.3s | [detail](per-case/c006.md) |
| c007 | image-pull | easy | completed | yes | 0.887 | 5 | 10.2s | [detail](per-case/c007.md) |
| c008 | image-pull | easy | completed | yes | 0.880 | 8 | 21.7s | [detail](per-case/c008.md) |
| c009 | image-pull | easy | completed | no | 0.587 | 9 | 14.9s | [detail](per-case/c009.md) |
| c010 | image-pull | easy | completed | yes | 0.805 | 11 | 25.5s | [detail](per-case/c010.md) |
| c011 | crashloop | easy | completed | yes | 0.943 | 8 | 12.8s | [detail](per-case/c011.md) |
| c012 | crashloop | easy | completed | yes | 0.970 | 11 | 30.6s | [detail](per-case/c012.md) |
| c013 | crashloop | easy | completed | yes | 0.890 | 5 | 19.5s | [detail](per-case/c013.md) |
| c014 | crashloop | easy | completed | yes | 0.948 | 5 | 13.3s | [detail](per-case/c014.md) |
| c015 | crashloop | easy | completed | yes | 0.955 | 7 | 39.8s | [detail](per-case/c015.md) |
| c016 | crashloop | easy | completed | yes | 0.941 | 7 | 38.8s | [detail](per-case/c016.md) |
| c017 | crashloop | easy | completed | yes | 0.944 | 6 | 29.7s | [detail](per-case/c017.md) |
| c018 | crashloop | easy | completed | yes | 0.933 | 9 | 27.0s | [detail](per-case/c018.md) |
| c019 | crashloop | easy | completed | yes | 0.957 | 8 | 23.8s | [detail](per-case/c019.md) |
| c020 | crashloop | easy | completed | yes | 0.902 | 7 | 27.6s | [detail](per-case/c020.md) |
| c021 | config | easy | completed | yes | 0.922 | 5 | 27.8s | [detail](per-case/c021.md) |
| c022 | config | easy | completed | yes | 0.863 | 7 | 13.0s | [detail](per-case/c022.md) |
| c023 | config | easy | completed | yes | 0.910 | 6 | 21.0s | [detail](per-case/c023.md) |
| c024 | config | easy | completed | yes | 0.887 | 7 | 23.5s | [detail](per-case/c024.md) |
| c025 | config | easy | completed | yes | 0.940 | 6 | 16.5s | [detail](per-case/c025.md) |
| c026 | config | easy | completed | yes | 0.880 | 7 | 22.4s | [detail](per-case/c026.md) |
| c027 | config | easy | completed | yes | 0.857 | 7 | 20.1s | [detail](per-case/c027.md) |
| c028 | config | easy | completed | yes | 0.893 | 6 | 15.5s | [detail](per-case/c028.md) |
| c029 | config | easy | completed | yes | 0.875 | 6 | 44.6s | [detail](per-case/c029.md) |
| c030 | config | easy | completed | yes | 0.919 | 6 | 12.5s | [detail](per-case/c030.md) |
| c031 | scheduling-gpu | easy | completed | yes | 0.947 | 25 | 75.5s | [detail](per-case/c031.md) |
| c032 | scheduling-gpu | easy | completed | yes | 0.974 | 14 | 32.3s | [detail](per-case/c032.md) |
| c033 | scheduling-gpu | easy | completed | yes | 0.857 | 3 | 23.5s | [detail](per-case/c033.md) |
| c034 | scheduling-gpu | easy | completed | yes | 0.792 | 6 | 26.7s | [detail](per-case/c034.md) |
| c035 | scheduling-gpu | easy | completed | yes | 0.970 | 12 | 80.6s | [detail](per-case/c035.md) |
| c036 | scheduling-gpu | easy | completed | yes | 0.831 | 21 | 111.0s | [detail](per-case/c036.md) |
| c037 | scheduling-gpu | easy | completed | yes | 0.905 | 3 | 20.9s | [detail](per-case/c037.md) |
| c038 | scheduling-gpu | easy | completed | yes | 0.782 | 2 | 30.3s | [detail](per-case/c038.md) |
| c039 | scheduling-gpu | easy | completed | yes | 0.822 | 3 | 45.8s | [detail](per-case/c039.md) |
| c040 | scheduling-gpu | easy | completed | yes | 0.799 | 1 | 26.9s | [detail](per-case/c040.md) |
| c041 | scheduling-gpu | easy | completed | no | 0.544 | 4 | 68.0s | [detail](per-case/c041.md) |
| c042 | scheduling-gpu | easy | completed | no | 0.605 | 3 | 49.4s | [detail](per-case/c042.md) |
| c043 | scheduling-gpu | easy | completed | yes | 0.871 | 6 | 25.0s | [detail](per-case/c043.md) |
| c044 | scheduling-gpu | easy | completed | yes | 0.940 | 8 | 56.5s | [detail](per-case/c044.md) |
| c045 | scheduling-gpu | easy | completed | no | 0.474 | 4 | 47.6s | [detail](per-case/c045.md) |
| c046 | storage | easy | completed | yes | 0.912 | 2 | 26.0s | [detail](per-case/c046.md) |
| c047 | storage | easy | completed | yes | 0.820 | 3 | 34.3s | [detail](per-case/c047.md) |
| c048 | storage | easy | completed | yes | 0.937 | 3 | 33.1s | [detail](per-case/c048.md) |
| c049 | storage | easy | completed | yes | 0.792 | 3 | 35.0s | [detail](per-case/c049.md) |
| c050 | storage | easy | completed | yes | 0.897 | 2 | 28.7s | [detail](per-case/c050.md) |
| c051 | storage | easy | completed | yes | 0.891 | 2 | 24.3s | [detail](per-case/c051.md) |
| c052 | storage | easy | completed | yes | 0.883 | 3 | 41.4s | [detail](per-case/c052.md) |
| c053 | storage | easy | completed | yes | 0.918 | 2 | 23.4s | [detail](per-case/c053.md) |
| c054 | storage | easy | completed | yes | 0.787 | 2 | 25.5s | [detail](per-case/c054.md) |
| c055 | storage | easy | completed | yes | 0.792 | 3 | 36.7s | [detail](per-case/c055.md) |
| c056 | service-readiness | medium | completed | yes | 0.817 | 3 | 37.5s | [detail](per-case/c056.md) |
| c057 | service-readiness | medium | completed | yes | 0.770 | 4 | 62.3s | [detail](per-case/c057.md) |
| c058 | service-readiness | medium | completed | yes | 0.730 | 9 | 78.0s | [detail](per-case/c058.md) |
| c059 | service-readiness | medium | completed | yes | 0.759 | 5 | 51.5s | [detail](per-case/c059.md) |
| c060 | service-readiness | medium | completed | yes | 0.731 | 3 | 38.6s | [detail](per-case/c060.md) |
| c061 | service-readiness | medium | completed | yes | 0.629 | 7 | 72.8s | [detail](per-case/c061.md) |
| c062 | service-readiness | hard | completed | yes | 0.826 | 7 | 63.6s | [detail](per-case/c062.md) |
| c063 | service-readiness | hard | completed | yes | 0.751 | 4 | 46.7s | [detail](per-case/c063.md) |
| c064 | service-readiness | hard | completed | yes | 0.677 | 14 | 154.8s | [detail](per-case/c064.md) |
| c065 | service-readiness | hard | completed | yes | 0.817 | 5 | 46.7s | [detail](per-case/c065.md) |
| c066 | service-readiness | hard | completed | yes | 0.794 | 4 | 37.7s | [detail](per-case/c066.md) |
| c067 | service-readiness | hard | completed | yes | 0.798 | 7 | 54.4s | [detail](per-case/c067.md) |
| c068 | network-dns | medium | completed | yes | 0.931 | 12 | 155.0s | [detail](per-case/c068.md) |
| c069 | network-dns | medium | completed | no | 0.432 | 8 | 113.8s | [detail](per-case/c069.md) |
| c070 | network-dns | medium | completed | yes | 0.832 | 16 | 150.8s | [detail](per-case/c070.md) |
| c071 | network-dns | medium | completed | yes | 0.917 | 5 | 51.5s | [detail](per-case/c071.md) |
| c072 | network-dns | medium | completed | no | 0.445 | 8 | 93.8s | [detail](per-case/c072.md) |
| c073 | network-dns | medium | completed | no | 0.649 | 4 | 62.3s | [detail](per-case/c073.md) |
| c074 | network-dns | medium | completed | yes | 0.903 | 5 | 46.1s | [detail](per-case/c074.md) |
| c075 | network-dns | medium | completed | yes | 0.907 | 10 | 105.8s | [detail](per-case/c075.md) |
| c076 | network-dns | medium | completed | yes | 0.880 | 9 | 99.7s | [detail](per-case/c076.md) |
| c077 | network-dns | medium | completed | yes | 0.903 | 7 | 77.2s | [detail](per-case/c077.md) |
| c078 | controller | medium | completed | yes | 0.698 | 4 | 34.0s | [detail](per-case/c078.md) |
| c079 | controller | medium | completed | yes | 0.768 | 6 | 77.1s | [detail](per-case/c079.md) |
| c080 | controller | medium | completed | yes | 0.716 | 4 | 55.0s | [detail](per-case/c080.md) |
| c081 | controller | medium | completed | yes | 0.870 | 8 | 97.5s | [detail](per-case/c081.md) |
| c082 | controller | medium | completed | no | 0.597 | 4 | 39.9s | [detail](per-case/c082.md) |
| c083 | controller | medium | completed | yes | 0.632 | 4 | 43.8s | [detail](per-case/c083.md) |
| c084 | controller | medium | completed | yes | 0.723 | 10 | 92.7s | [detail](per-case/c084.md) |
| c085 | controller | medium | completed | yes | 0.808 | 5 | 77.8s | [detail](per-case/c085.md) |
| c086 | volcano-gpu | hard | completed | yes | 0.866 | 10 | 118.7s | [detail](per-case/c086.md) |
| c087 | volcano-gpu | hard | completed | yes | 0.868 | 6 | 56.5s | [detail](per-case/c087.md) |
| c088 | volcano-gpu | hard | completed | yes | 0.773 | 8 | 76.5s | [detail](per-case/c088.md) |
| c089 | volcano-gpu | hard | completed | yes | 0.915 | 16 | 83.0s | [detail](per-case/c089.md) |
| c090 | volcano-gpu | hard | completed | yes | 0.788 | 4 | 44.5s | [detail](per-case/c090.md) |
| c091 | volcano-gpu | hard | completed | yes | 0.924 | 23 | 77.6s | [detail](per-case/c091.md) |
| c092 | volcano-gpu | hard | completed | yes | 0.622 | 4 | 51.2s | [detail](per-case/c092.md) |
| c093 | volcano-gpu | hard | completed | yes | 0.905 | 29 | 113.2s | [detail](per-case/c093.md) |
| c094 | compound | hard | completed | yes | 0.676 | 4 | 53.0s | [detail](per-case/c094.md) |
| c095 | compound | hard | completed | no | 0.504 | 12 | 50.9s | [detail](per-case/c095.md) |
| c096 | compound | hard | completed | yes | 0.833 | 3 | 40.9s | [detail](per-case/c096.md) |
| c097 | compound | hard | completed | yes | 0.813 | 4 | 73.6s | [detail](per-case/c097.md) |
| c098 | compound | hard | completed | yes | 0.649 | 10 | 95.4s | [detail](per-case/c098.md) |
| c099 | compound | hard | completed | yes | 0.881 | 19 | 75.6s | [detail](per-case/c099.md) |
| c100 | compound | hard | completed | no | 0.567 | 29 | 123.9s | [detail](per-case/c100.md) |

## Scoring Checklist

- Localization: 是否定位到 oracle 中的 pod/service/deployment/pvc/podgroup 等目标资源。
- Mechanism: 是否解释了故障机理，而不是只复述症状。
- Scope: 是否说明单资源、服务路径、调度链路或复合故障影响范围。
- Evidence: 是否引用事件、yaml、日志、endpoint、scheduler/Volcano 状态等证据。
- Remediation: 是否给出低风险、与根因匹配的修复建议。

## Notes

- 自动判分是关键词和 oracle 匹配的保守近似；最终科研结论建议对低分和复合故障样本做人工复核。
- 本轮遵守只读诊断规则；prompt 明确禁止修改、删除、重启、扩缩容或创建集群资源。
- 评测资源均限定在 siclaw-eval-yye-20260602 命名空间内。
