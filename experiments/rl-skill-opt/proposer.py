#!/usr/bin/env python3
"""
proposer.py — the skill-proposer POLICY (runs on the H100 pod).

Loads Qwen2.5-3B-Instruct (optionally with a LoRA adapter from a previous
round) and GENERATES K candidate diagnostic skills for a target fault category.
Each skill is a focused SOP the real Siclaw agent can follow. The prompt
contains only the category description + 1–2 example incident SYMPTOMS — NO
ground truth, NO target resource names — so the policy must learn to write a
generally-useful procedure, not memorize answers.

Output: a JSON file [{ "idx": i, "skill": "<text>" }, ...] that the local
orchestrator pulls back and scores with reward.mjs (real Siclaw + real judge).

Usage (inside the pod):
  python proposer.py \
    --model Qwen/Qwen2.5-3B-Instruct \
    [--adapter /workspace/out/skillprop/adapter] \
    --category network-dns \
    --examples-file /workspace/rl/examples.json \
    --k 4 --out /workspace/out/skillprop/round0/candidates.json \
    [--temperature 0.9 --max-new-tokens 700 --seed 0]
"""
import argparse
import json
import os
import re
import sys
import time


SYSTEM = (
    "You are an expert Site Reliability Engineer who writes concise, reusable "
    "diagnostic playbooks (skills) for an automated Kubernetes diagnosis agent. "
    "A skill is a focused standard operating procedure (SOP): when this class of "
    "incident appears, it tells the agent exactly which resources to inspect, in "
    "what order, how to distinguish the real root cause from downstream symptoms, "
    "and what a correct diagnosis must contain. The agent is READ-ONLY (it can "
    "run kubectl get/describe/logs but must not mutate the cluster)."
)


def build_user_prompt(category, examples):
    ex_lines = []
    for i, ex in enumerate(examples, 1):
        ex_lines.append(f"  Example incident {i}: {ex}")
    examples_block = "\n".join(ex_lines) if ex_lines else "  (no examples provided)"
    return f"""Write ONE diagnostic skill for the fault category: "{category}".

Some representative incident symptoms in this category (these are just the
user-facing symptom reports the agent will receive — they do NOT tell you the
answer; the agent must investigate the live cluster to find it):
{examples_block}

Requirements for the skill you write:
- Be a GENERAL procedure for this category, not a fix for one specific incident.
  Do NOT invent or assume specific resource names, namespaces, image tags, or IPs.
- Tell the agent the PRECISE order of read-only checks (which `kubectl get/describe`
  on which kinds) that reveal the root cause for this category.
- Tell the agent how to separate the true root cause from misleading downstream
  symptoms (e.g. a pod restarting is usually a symptom, not the cause).
- State what a correct final diagnosis must name: the faulting resource
  (kind/name), the concrete mechanism (the specific mutated detail), the scope,
  the supporting evidence, and a safe remediation that actually fixes that cause.
- Keep it focused and actionable (roughly 150–400 words). No preamble, no
  markdown headers like "# Skill" — just the SOP text itself.

Output ONLY the skill text. Begin now:"""


def clean_skill(text):
    t = text.strip()
    # strip any reasoning blocks some models emit
    t = re.sub(r"<think>.*?</think>", "", t, flags=re.S | re.I)
    t = re.sub(r"<thinking>.*?</thinking>", "", t, flags=re.S | re.I)
    # strip leading code fences if the model wrapped the answer
    t = re.sub(r"^```[a-zA-Z]*\n", "", t.strip())
    t = re.sub(r"\n```$", "", t.strip())
    return t.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-3B-Instruct")
    ap.add_argument("--adapter", default=None, help="LoRA adapter dir from a prior round")
    ap.add_argument("--category", required=True)
    ap.add_argument("--examples-file", required=True, help="JSON list of example symptom strings")
    ap.add_argument("--k", type=int, default=4)
    ap.add_argument("--out", required=True)
    ap.add_argument("--temperature", type=float, default=0.9)
    ap.add_argument("--top-p", type=float, default=0.95)
    ap.add_argument("--max-new-tokens", type=int, default=700)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, set_seed

    set_seed(args.seed)
    t0 = time.time()
    print(f"[proposer] loading {args.model} adapter={args.adapter}", flush=True)
    tok = AutoTokenizer.from_pretrained(args.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        args.model, torch_dtype=torch.bfloat16, device_map="cuda:0"
    )
    if args.adapter and os.path.isdir(args.adapter):
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, args.adapter)
        print(f"[proposer] loaded adapter {args.adapter}", flush=True)
    model.eval()

    with open(args.examples_file) as f:
        examples = json.load(f)
    user = build_user_prompt(args.category, examples)
    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
    prompt_text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    enc = tok(prompt_text, return_tensors="pt").to(model.device)

    candidates = []
    for i in range(args.k):
        with torch.no_grad():
            out = model.generate(
                **enc,
                do_sample=True,
                temperature=args.temperature,
                top_p=args.top_p,
                max_new_tokens=args.max_new_tokens,
                pad_token_id=tok.pad_token_id,
            )
        gen = out[0][enc["input_ids"].shape[1]:]
        text = clean_skill(tok.decode(gen, skip_special_tokens=True))
        candidates.append({"idx": i, "skill": text, "chars": len(text)})
        print(f"[proposer] candidate {i}: {len(text)} chars", flush=True)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        json.dump({
            "category": args.category,
            "model": args.model,
            "adapter": args.adapter,
            "k": args.k,
            "temperature": args.temperature,
            "seconds": round(time.time() - t0, 1),
            "candidates": candidates,
        }, f, ensure_ascii=False, indent=2)
    print(f"[proposer] wrote {len(candidates)} candidates -> {args.out} in {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
