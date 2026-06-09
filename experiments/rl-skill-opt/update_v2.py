#!/usr/bin/env python3
"""
update_v2.py — GRPO-upgraded skill-proposer update (H100 pod).

Fixes the RAFT mode-collapse from v1 (LoRA loss -> 0.0004, ~744-char clones) with
four changes grounded in RELATED-WORK-AND-PLAN.md C.2/C.5:

  1. GROUP ADVANTAGE (GRPO, 2402.03300): advantage_i = (reward_i - group_mean) /
     (group_std + eps). We SFT-imitate candidates weighted by POSITIVE advantage
     (mass on the better-than-average ones), instead of imitating one global winner.
  2. PARETO-KEEP TOP-2 PER INSTANCE: keep not just the global best but the best
     candidate on EACH training case (de-duplicated), so the policy imitates a
     DIVERSE set covering different fault sub-types — directly fights tunnel-vision.
  3. CONTENT-COVERAGE IMITATION, NOT SURFACE STRING: we up-weight candidates whose
     coverage vector is richer (mentions networkpolicy AND dnsconfig AND
     endpoints/selector AND ordered checks), and we add an explicit coverage bonus
     to the advantage so the policy learns to COVER all causes rather than memorize
     one phrasing.
  4. ENTROPY FLOOR: add a small token-entropy regularizer (-beta * H) with a NEGATIVE
     beta i.e. we ADD an entropy bonus to the loss objective (maximize entropy of the
     policy on the generated tokens) to keep the output distribution from collapsing.
     Combined with a higher LR cap and fewer epochs to avoid over-fitting one template.

scored.json schema (from the orchestrator), each candidate has:
  {idx, skill, reward, advantage, judgeReward, perCase:{caseId->composite}, coverage}

Usage (pod): same flags as update.py plus --entropy-beta, --max-keep, --coverage-bonus.
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from proposer_v2 import SYSTEM, build_user_prompt, coverage_vector  # noqa: E402


def coverage_score(cov):
    if not cov:
        return 0.0
    keys = ["networkpolicy", "dnsconfig", "endpoints_selector", "ordered_checks"]
    return sum(1.0 for k in keys if cov.get(k)) / len(keys)


def select_pareto(cands, train_cases, max_keep):
    """Keep the global best by reward + the best candidate on each individual case."""
    kept = {}
    # global best
    gb = max(cands, key=lambda c: c.get("reward", 0.0))
    kept[gb["idx"]] = gb
    # per-instance best (Pareto coverage of sub-types)
    for cid in train_cases:
        best = None
        for c in cands:
            v = (c.get("perCase") or {}).get(cid, c.get("reward", 0.0))
            if best is None or v > (best.get("perCase") or {}).get(cid, best.get("reward", 0.0)):
                best = c
        if best is not None:
            kept[best["idx"]] = best
    out = list(kept.values())
    # cap to max_keep by reward, but always keep variety: sort by reward desc
    out.sort(key=lambda c: c.get("reward", 0.0), reverse=True)
    return out[:max_keep] if max_keep > 0 else out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-3B-Instruct")
    ap.add_argument("--in-adapter", default=None)
    ap.add_argument("--scored-file", required=True)
    ap.add_argument("--category", required=True)
    ap.add_argument("--examples-file", required=True)
    ap.add_argument("--prior-skill", default=None)
    ap.add_argument("--out-adapter", required=True)
    ap.add_argument("--train-cases", default="", help="comma ids for per-instance Pareto keep")
    ap.add_argument("--max-keep", type=int, default=3)
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--max-len", type=int, default=2048)
    ap.add_argument("--entropy-beta", type=float, default=0.01, help="entropy BONUS coeff (anti-collapse)")
    ap.add_argument("--coverage-bonus", type=float, default=0.3, help="add coverage to advantage")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    import torch
    import torch.nn.functional as F
    from transformers import AutoModelForCausalLM, AutoTokenizer, set_seed
    from peft import LoraConfig, PeftModel, get_peft_model

    set_seed(args.seed)
    train_cases = [s.strip() for s in args.train_cases.split(",") if s.strip()]
    with open(args.scored_file) as f:
        scored = json.load(f)
    cands = scored["candidates"]
    with open(args.examples_file) as f:
        examples = json.load(f)
    prior = None
    if args.prior_skill and os.path.exists(args.prior_skill):
        with open(args.prior_skill) as f:
            prior = f.read()

    # ── GROUP ADVANTAGE (GRPO) ──
    rewards = [c.get("reward", 0.0) for c in cands]
    n = len(rewards)
    mean_r = sum(rewards) / max(1, n)
    var_r = sum((r - mean_r) ** 2 for r in rewards) / max(1, n)
    std_r = var_r ** 0.5
    for c in cands:
        base_adv = (c.get("reward", 0.0) - mean_r) / (std_r + 1e-4)
        cov = c.get("coverage") or coverage_vector(c.get("skill", ""))
        c["_adv"] = base_adv + args.coverage_bonus * coverage_score(cov)
        c["_cov"] = coverage_score(cov)

    # ── PARETO-KEEP (global best + per-instance best), then keep only adv>0 (+ best) ──
    kept = select_pareto(cands, train_cases, args.max_keep)
    pos = [c for c in kept if c["_adv"] > 0] or [max(kept, key=lambda c: c.get("reward", 0.0))]
    print(f"[update_v2] group mean={mean_r:.3f} std={std_r:.3f}; kept {len(kept)} (pareto), "
          f"imitating {len(pos)} with adv>0: rewards={[round(c.get('reward',0),3) for c in pos]} "
          f"covs={[round(c['_cov'],2) for c in pos]}", flush=True)

    # ── build SFT examples weighted by (positive) advantage ──
    user = build_user_prompt(args.category, examples, prior)
    tok = AutoTokenizer.from_pretrained(args.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    sft = []
    for c in pos:
        skill = (c.get("skill") or "").strip()
        if not skill:
            continue
        reps = max(1, min(4, 1 + int(round(c["_adv"] * 2))))  # advantage -> #repeats
        prompt_msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
        prompt_ids = tok.apply_chat_template(prompt_msgs, tokenize=True, add_generation_prompt=True)
        full_msgs = prompt_msgs + [{"role": "assistant", "content": skill}]
        full_ids = tok.apply_chat_template(full_msgs, tokenize=True, add_generation_prompt=False)[:args.max_len]
        labels = list(full_ids)
        plen = min(len(prompt_ids), len(full_ids))
        for i in range(plen):
            labels[i] = -100
        for _ in range(reps):
            sft.append({"input_ids": full_ids, "labels": labels})
    if not sft:
        raise SystemExit("[update_v2] no SFT examples after filtering")
    print(f"[update_v2] {len(sft)} SFT sequences (advantage-weighted)", flush=True)

    base = AutoModelForCausalLM.from_pretrained(args.model, torch_dtype=torch.bfloat16, device_map="cuda:0")
    if args.in_adapter and os.path.isdir(args.in_adapter):
        model = PeftModel.from_pretrained(base, args.in_adapter, is_trainable=True)
        print(f"[update_v2] continuing adapter {args.in_adapter}", flush=True)
    else:
        lora = LoraConfig(r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=0.05, bias="none",
                          task_type="CAUSAL_LM",
                          target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
        model = get_peft_model(base, lora)
    model.train()
    model.print_trainable_parameters()

    from torch.utils.data import DataLoader

    def collate(batch):
        maxlen = max(len(b["input_ids"]) for b in batch)
        pad = tok.pad_token_id
        input_ids, labels, attn = [], [], []
        for b in batch:
            ids, lab = b["input_ids"], b["labels"]
            k = maxlen - len(ids)
            input_ids.append(ids + [pad] * k)
            labels.append(lab + [-100] * k)
            attn.append([1] * len(ids) + [0] * k)
        return torch.tensor(input_ids), torch.tensor(labels), torch.tensor(attn)

    dl = DataLoader(sft, batch_size=1, shuffle=True, collate_fn=collate)
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr)

    t0 = time.time()
    losses, ce_losses, entropies = [], [], []
    step = 0
    for ep in range(args.epochs):
        for input_ids, labels, attn in dl:
            input_ids, labels, attn = input_ids.to(model.device), labels.to(model.device), attn.to(model.device)
            out = model(input_ids=input_ids, attention_mask=attn, labels=labels)
            ce = out.loss
            # ── ENTROPY FLOOR: maximize entropy on the assistant (label!=-100) tokens ──
            logits = out.logits[:, :-1, :]
            tgt = labels[:, 1:]
            mask = (tgt != -100)
            if mask.any():
                logp = F.log_softmax(logits, dim=-1)
                p = logp.exp()
                tok_ent = -(p * logp).sum(-1)  # [B, T-1]
                ent = (tok_ent * mask).sum() / mask.sum()
            else:
                ent = torch.tensor(0.0, device=model.device)
            loss = ce - args.entropy_beta * ent  # subtract entropy bonus (maximize H)
            loss.backward()
            torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
            opt.step()
            opt.zero_grad()
            step += 1
            losses.append(float(loss.item())); ce_losses.append(float(ce.item())); entropies.append(float(ent.item()))
            print(f"[update_v2] ep{ep} step{step} loss={loss.item():.4f} ce={ce.item():.4f} H={ent.item():.4f}", flush=True)

    os.makedirs(args.out_adapter, exist_ok=True)
    model.save_pretrained(args.out_adapter)
    tok.save_pretrained(args.out_adapter)
    summary = {
        "model": args.model, "in_adapter": args.in_adapter, "out_adapter": args.out_adapter,
        "n_candidates": n, "n_kept_pareto": len(kept), "n_imitated": len(pos),
        "group_mean": round(mean_r, 4), "group_std": round(std_r, 4),
        "kept_rewards": [c.get("reward") for c in pos], "kept_covs": [round(c["_cov"], 3) for c in pos],
        "entropy_beta": args.entropy_beta, "coverage_bonus": args.coverage_bonus,
        "epochs": args.epochs, "lr": args.lr,
        "final_loss": round(losses[-1], 4) if losses else None,
        "final_ce": round(ce_losses[-1], 4) if ce_losses else None,
        "mean_entropy": round(sum(entropies) / len(entropies), 4) if entropies else None,
        "seconds": round(time.time() - t0, 1),
    }
    with open(os.path.join(os.path.dirname(args.out_adapter), "update_summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print(f"[update_v2] DONE -> {args.out_adapter} in {time.time()-t0:.0f}s "
          f"final_loss={summary['final_loss']} ce={summary['final_ce']} H={summary['mean_entropy']}", flush=True)


if __name__ == "__main__":
    main()
