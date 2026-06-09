#!/bin/bash
# Run all AAAI paper experiments
cd /Users/yye/project/siclaw

echo "=== Running Security Red-Team Tests ==="
npx vitest run experiments/aaai-paper/security-redteam.test.ts 2>&1

echo ""
echo "=== Running Security Ablation Tests ==="
npx vitest run experiments/aaai-paper/security-ablation.test.ts 2>&1

echo ""
echo "=== Running Deep Analysis ==="
node experiments/aaai-paper/analyze-for-paper.mjs 2>&1

echo ""
echo "=== ALL EXPERIMENTS COMPLETE ==="
