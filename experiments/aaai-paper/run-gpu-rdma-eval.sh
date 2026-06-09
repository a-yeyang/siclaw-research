#!/bin/bash
# Run GPU/RDMA fault diagnosis evaluation using Siclaw agent + Claude Sonnet 4.6
set -euo pipefail

cd /Users/yye/project/siclaw

export KUBECONFIG=.siclaw/credentials/cks-test.kubeconfig
NS="siclaw-eval-gpu-rdma"
CASES_JSON="experiments/aaai-paper/gpu-rdma-cases.json"
LOGS_DIR="experiments/aaai-paper/gpu-rdma-logs"
GUARD="thorough"

# Use Scitix Anthropic API for Claude Sonnet 4.6
export SICLAW_EVAL_GUARD="$GUARD"
export OPENAI_API_BASE="https://api.scitix.ai/model-api/v1"
export OPENAI_API_KEY="${SCITIX_API_KEY}"

mkdir -p "$LOGS_DIR"

# Generate prompts for each case
node -e "
const cases = JSON.parse(require('fs').readFileSync('$CASES_JSON', 'utf8'));
for (const c of cases) {
  const telemetryNote = [
    'Telemetry data for this case is stored in ConfigMaps in the same namespace.',
    'Use: kubectl get cm -n ${NS} -l siclaw.ai/eval-case=' + c.id + ' to find them.',
    'Read each ConfigMap with: kubectl get cm <name> -n ${NS} -o yaml',
    'Pod annotations may also contain crash reason and diagnostic hints.',
  ].join('\n');

  const prompt = [
    'You are Siclaw under evaluation as a read-only SRE diagnostic agent.',
    '',
    'Incident:',
    c.symptom,
    '',
    'Target cluster: cks-test',
    'Namespace: ${NS}',
    'Primary target resource(s): ' + c.targets.join(', '),
    'Case id: ' + c.id,
    '',
    'Important context:',
    telemetryNote,
    '',
    'Rules:',
    '- Do not modify, delete, restart, scale, patch, or create cluster resources.',
    '- This is a GPU/RDMA infrastructure fault scenario. Check ConfigMaps in the namespace for simulated telemetry (dmesg, nvidia-smi, ibstat, NCCL logs, perftest, ethtool counters).',
    '- Check pod annotations for crash reasons and hints.',
    '- Return a concise final diagnosis with: root cause(s), concrete evidence, impact/scope, confidence, and safe remediation suggestion.',
  ].join('\n');

  const promptDir = '$LOGS_DIR/' + c.id;
  require('fs').mkdirSync(promptDir, { recursive: true });
  require('fs').writeFileSync(promptDir + '/prompt.txt', prompt);
  console.log('Generated prompt for ' + c.id + ': ' + c.title);
}
"

echo ""
echo "=== Running ${#cases[@]:-10} cases with eval harness ==="
echo ""

# Run each case
for CASE_DIR in "$LOGS_DIR"/g*; do
  CASE_ID=$(basename "$CASE_DIR")
  PROMPT_FILE="$CASE_DIR/prompt.txt"
  OUTPUT_FILE="$CASE_DIR/result.json"

  if [ -f "$OUTPUT_FILE" ]; then
    echo "SKIP $CASE_ID (already has result.json)"
    continue
  fi

  echo "RUN $CASE_ID..."
  timeout 300 node experiments/siclaw-agent-eval/eval-harness.mjs \
    --case-id "$CASE_ID" \
    --prompt-file "$PROMPT_FILE" \
    --output-file "$OUTPUT_FILE" \
    --timeout-ms 240000 \
    --cluster cks-test \
    --namespace "$NS" \
    --kubeconfig "$KUBECONFIG" \
    --guard thorough \
    2>"$CASE_DIR/runner.stderr.log" || echo "FAILED $CASE_ID (see $CASE_DIR/runner.stderr.log)"
  echo ""
done

echo "=== ALL CASES COMPLETE ==="
echo "Results in: $LOGS_DIR/"
