#!/usr/bin/env python3
"""
update.py — RL update of the skill-proposer policy (RAFT / ReST on the H100 pod).

RAFT (Reward-rAnked Fine-Tuning) / ReST: of the K candidate skills the proposer
produced this round, keep the ones whose REAL reward (mean Siclaw judge score on
the category, from reward.mjs) is highest, and SFT (LoRA) the policy to imitate
those high-reward skills. This makes high-scoring skills more likely next round.
It is robust under a small number of slow, real rollouts — exactly our regime —
and avoids the instability of online policy-gradient with tiny batches.

We additionally support a soft reward weighting: each kept (prompt -> skill)
example is weighted by its advantage over the round's mean reward, so a clearly
better skill pulls the policy harder than a marginal one. (REINFORCE-flavoured
RAFT.)

The adapter is loaded from --in-adapter (previous round) if given, trained
further, and saved to --out-adapter, so improvement accumulates across rounds.

Usage (inside the pod):
  python update.py \
    --model Qwen/Qwen2.5-3B-Instruct \
    [--in-adapter /workspace/out/skillprop/round0/adapter] \
    --scored-file /workspace/out/skillprop/round0/scored.json \
    --category network-dns --examples-file /workspace/rl/examples.json \
    --out-adapter /workspace/out/skillprop/round1/adapter \
    [--top-frac 0.5 --epochs 3 --lr 1e-4 --min-keep 1]

scored.json schema (written by the orchestrator):
  { "candidates": [ {"idx":0, "skill":"...", "reward":0.83, "advantage":0.23}, ... ] }
"""
import argparse
import json
import os
import sys
import time

# reuse the EXACT prompt the proposer used, so SFT targets match the policy's input
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from proposer import SYSTEM, build_user_prompt  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-3B-Instruct")
    ap.add_argument("--in-adapter", default=None)
    ap.add_argument("--scored-file", required=True)
    ap.add_argument("--category", required=True)
    ap.add_argument("--examples-file", required=True)
    ap.add_argument("--out-adapter", required=True)
    ap.add_argument("--top-frac", type=float, default=0.5, help="keep this fraction (by reward)")
    ap.add_argument("--min-keep", type=int, default=1)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--max-len", type=int, default=2048)
    ap.add_argument("--weight-by-advantage", action="store_true", default=True)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, set_seed
    from peft import LoraConfig, PeftModel, get_peft_model

    set_seed(args.seed)
    with open(args.scored_file) as f:
        scored = json.load(f)
    cands = scored["candidates"]
    with open(args.examples_file) as f:
        examples = json.load(f)

    # ── RAFT selection: rank by reward, keep top fraction ──
    cands = sorted(cands, key=lambda c: c.get("reward", 0.0), reverse=True)
    n_keep = max(args.min_keep, round(args.top_frac * len(cands)))
    n_keep = min(n_keep, len(cands))
    mean_r = sum(c.get("reward", 0.0) for c in cands) / max(1, len(cands))
    kept = cands[:n_keep]
    # only imitate skills that are at or above the round mean (don't reinforce a
    # below-average skill just because top_frac let it through)
    kept = [c for c in kept if c.get("reward", 0.0) >= mean_r - 1e-9] or cands[:1]
    print(f"[update] round mean reward={mean_r:.3f}  keeping {len(kept)}/{len(cands)}: "
          f"{[round(c.get('reward',0),3) for c in kept]}", flush=True)

    # ── build SFT examples: (system+user prompt) -> kept skill ──
    user = build_user_prompt(args.category, examples)
    tok = AutoTokenizer.from_pretrained(args.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    sft = []
    for c in kept:
        skill = c["skill"].strip()
        if not skill:
            continue
        # weight: advantage over mean, floored at a small positive so every kept
        # example contributes at least once.
        adv = c.get("advantage")
        if adv is None:
            adv = c.get("reward", 0.0) - mean_r
        reps = 1
        if args.weight_by_advantage:
            reps = max(1, min(4, 1 + int(round(max(0.0, adv) * 6))))
        prompt_msgs = [{"role": "system", "content": SYSTEM},
                       {"role": "user", "content": user}]
        prompt_ids = tok.apply_chat_template(prompt_msgs, tokenize=True,
                                             add_generation_prompt=True)
        full_msgs = prompt_msgs + [{"role": "assistant", "content": skill}]
        full_ids = tok.apply_chat_template(full_msgs, tokenize=True,
                                           add_generation_prompt=False)
        full_ids = full_ids[:args.max_len]
        labels = list(full_ids)
        # mask the prompt portion so loss is only on the skill (assistant) tokens
        plen = min(len(prompt_ids), len(full_ids))
        for i in range(plen):
            labels[i] = -100
        for _ in range(reps):
            sft.append({"input_ids": full_ids, "labels": labels})
    if not sft:
        raise SystemExit("[update] no SFT examples after filtering (all skills empty?)")
    print(f"[update] {len(sft)} SFT sequences (after advantage weighting)", flush=True)

    # ── model + LoRA ──
    base = AutoModelForCausalLM.from_pretrained(
        args.model, torch_dtype=torch.bfloat16, device_map="cuda:0"
    )
    if args.in_adapter and os.path.isdir(args.in_adapter):
        # continue training the existing adapter (accumulate across rounds)
        model = PeftModel.from_pretrained(base, args.in_adapter, is_trainable=True)
        print(f"[update] continuing adapter {args.in_adapter}", flush=True)
    else:
        lora = LoraConfig(
            r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=0.05, bias="none",
            task_type="CAUSAL_LM",
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                            "gate_proj", "up_proj", "down_proj"],
        )
        model = get_peft_model(base, lora)
    model.train()
    model.print_trainable_parameters()

    # ── manual SFT loop (tiny dataset; avoid Trainer overhead) ──
    from torch.utils.data import DataLoader

    def collate(batch):
        maxlen = max(len(b["input_ids"]) for b in batch)
        input_ids, labels, attn = [], [], []
        pad = tok.pad_token_id
        for b in batch:
            ids = b["input_ids"]; lab = b["labels"]
            padn = maxlen - len(ids)
            input_ids.append(ids + [pad] * padn)
            labels.append(lab + [-100] * padn)
            attn.append([1] * len(ids) + [0] * padn)
        return (torch.tensor(input_ids), torch.tensor(labels), torch.tensor(attn))

    dl = DataLoader(sft, batch_size=1, shuffle=True, collate_fn=collate)
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr)

    t0 = time.time()
    step = 0
    losses = []
    for ep in range(args.epochs):
        for input_ids, labels, attn in dl:
            input_ids = input_ids.to(model.device)
            labels = labels.to(model.device)
            attn = attn.to(model.device)
            out = model(input_ids=input_ids, attention_mask=attn, labels=labels)
            loss = out.loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(
                [p for p in model.parameters() if p.requires_grad], 1.0)
            opt.step()
            opt.zero_grad()
            step += 1
            losses.append(float(loss.item()))
            print(f"[update] ep{ep} step{step} loss={loss.item():.4f}", flush=True)

    os.makedirs(args.out_adapter, exist_ok=True)
    model.save_pretrained(args.out_adapter)
    tok.save_pretrained(args.out_adapter)
    summary = {
        "model": args.model, "in_adapter": args.in_adapter,
        "out_adapter": args.out_adapter, "n_candidates": len(cands),
        "n_kept": len(kept), "kept_rewards": [c.get("reward") for c in kept],
        "mean_reward": round(mean_r, 4), "n_sft": len(sft),
        "epochs": args.epochs, "lr": args.lr,
        "final_loss": round(losses[-1], 4) if losses else None,
        "seconds": round(time.time() - t0, 1),
    }
    with open(os.path.join(os.path.dirname(args.out_adapter), "update_summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print(f"[update] DONE -> {args.out_adapter} in {time.time()-t0:.0f}s "
          f"final_loss={summary['final_loss']}", flush=True)


if __name__ == "__main__":
    main()
