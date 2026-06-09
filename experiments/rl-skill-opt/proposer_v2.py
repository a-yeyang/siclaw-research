#!/usr/bin/env python3
"""
proposer_v2.py — upgraded skill-proposer policy for GRPO-skill (H100 pod).

Upgrades over proposer.py (for the AAAI v2 run):
  * Optional BEHAVIORAL PRIOR: --prior-skill seeds an in-context exemplar of a good
    SOP (e.g. the hand-crafted skill) so the cold policy starts near a sensible
    region instead of DNS-tunnel-vision. The prior is shown as a *style* exemplar,
    NOT copied (the policy must still write its own general SOP).
  * Higher default sampling temperature + records per-candidate generation
    DIVERSITY: mean pairwise normalized edit distance and token-level entropy of the
    batch, written to the candidates file. These feed the collapse diagnostics
    (entropy / Pass@k / candidate-diversity) the paper sells.
  * Records a content-coverage vector per candidate (does the SOP MENTION
    {networkpolicy, dnsconfig, endpoints/selector, ordered-checks}) so the updater
    can imitate CONTENT/coverage rather than the surface string.

Output JSON adds: candidates[i].coverage, plus batch-level diversity {mean_edit,
token_entropy}.

Usage (pod):
  python proposer_v2.py --model Qwen/Qwen2.5-3B-Instruct [--adapter DIR] \
    --category network-dns --examples-file examples.json \
    [--prior-skill prior.txt] --k 4 --out round0/candidates.json \
    [--temperature 1.05 --top-p 0.97 --max-new-tokens 700 --seed 0]
"""
import argparse
import json
import math
import os
import re
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


def build_user_prompt(category, examples, prior_skill=None):
    ex_lines = [f"  Example incident {i}: {ex}" for i, ex in enumerate(examples, 1)]
    examples_block = "\n".join(ex_lines) if ex_lines else "  (no examples provided)"
    prior_block = ""
    if prior_skill:
        prior_block = (
            "\nHere is an EXAMPLE of the STYLE and THOROUGHNESS expected (a good SOP for a "
            "related situation). Do NOT copy it; write your own general SOP for THIS category, "
            "but match this level of specificity and breadth — enumerate ALL plausible causes "
            "and the order to rule each in/out, do not fixate on a single cause:\n"
            '"""\n' + prior_skill.strip()[:1600] + '\n"""\n'
        )
    return f"""Write ONE diagnostic skill for the fault category: "{category}".

Some representative incident symptoms in this category (these are just the
user-facing symptom reports the agent will receive — they do NOT tell you the
answer; the agent must investigate the live cluster to find it):
{examples_block}
{prior_block}
Requirements for the skill you write:
- Be a GENERAL procedure for this category, not a fix for one specific incident.
  Do NOT invent or assume specific resource names, namespaces, image tags, or IPs.
- Tell the agent the PRECISE order of read-only checks (which `kubectl get/describe`
  on which kinds) that reveal the root cause for this category.
- Enumerate EVERY plausible cause for this category and how to tell them apart; do
  NOT tunnel-vision on one cause. Separate true root cause from downstream symptoms.
- State what a correct final diagnosis must name: the faulting resource
  (kind/name), the concrete mechanism, the scope, the supporting evidence, and a
  safe remediation that actually fixes that cause.
- Keep it focused and actionable (roughly 150-400 words). No preamble, no
  markdown headers like "# Skill" — just the SOP text itself.

Output ONLY the skill text. Begin now:"""


def clean_skill(text):
    t = text.strip()
    t = re.sub(r"<think>.*?</think>", "", t, flags=re.S | re.I)
    t = re.sub(r"<thinking>.*?</thinking>", "", t, flags=re.S | re.I)
    t = re.sub(r"^```[a-zA-Z]*\n", "", t.strip())
    t = re.sub(r"\n```$", "", t.strip())
    return t.strip()


def coverage_vector(skill):
    """Does the SOP MENTION each key concept? (content-coverage, not surface string)"""
    s = skill.lower()
    return {
        "networkpolicy": bool(re.search(r"networkpolic|netpol|egress|ingress", s)),
        "dnsconfig": bool(re.search(r"dnsconfig|dnspolicy|resolv\.conf|nameserver|dns config", s)),
        "endpoints_selector": bool(re.search(r"endpoint|selector|label", s)),
        "ordered_checks": bool(re.search(r"\b(first|then|order|step|1\.|2\.)\b", s)),
    }


def norm_edit_distance(a, b):
    # token-level Levenshtein normalized by max length (cheap diversity proxy)
    at, bt = a.split(), b.split()
    n, m = len(at), len(bt)
    if n == 0 and m == 0:
        return 0.0
    dp = list(range(m + 1))
    for i in range(1, n + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, m + 1):
            cur = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (at[i - 1] != bt[j - 1]))
            prev = cur
    return dp[m] / max(n, m, 1)


def batch_diversity(skills):
    if len(skills) < 2:
        return {"mean_edit": 0.0, "token_entropy": 0.0}
    dists = []
    for i in range(len(skills)):
        for j in range(i + 1, len(skills)):
            dists.append(norm_edit_distance(skills[i], skills[j]))
    mean_edit = sum(dists) / len(dists)
    # token entropy over the pooled vocabulary (Shannon, base 2)
    from collections import Counter
    toks = []
    for s in skills:
        toks += s.lower().split()
    c = Counter(toks)
    tot = sum(c.values()) or 1
    ent = -sum((v / tot) * math.log2(v / tot) for v in c.values())
    return {"mean_edit": round(mean_edit, 4), "token_entropy": round(ent, 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-3B-Instruct")
    ap.add_argument("--adapter", default=None)
    ap.add_argument("--category", required=True)
    ap.add_argument("--examples-file", required=True)
    ap.add_argument("--prior-skill", default=None, help="behavioural-prior exemplar SOP")
    ap.add_argument("--k", type=int, default=4)
    ap.add_argument("--out", required=True)
    ap.add_argument("--temperature", type=float, default=1.05)
    ap.add_argument("--top-p", type=float, default=0.97)
    ap.add_argument("--max-new-tokens", type=int, default=700)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, set_seed

    set_seed(args.seed)
    t0 = time.time()
    print(f"[proposer_v2] loading {args.model} adapter={args.adapter} prior={args.prior_skill}", flush=True)
    tok = AutoTokenizer.from_pretrained(args.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(args.model, torch_dtype=torch.bfloat16, device_map="cuda:0")
    if args.adapter and os.path.isdir(args.adapter):
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, args.adapter)
        print(f"[proposer_v2] loaded adapter {args.adapter}", flush=True)
    model.eval()

    with open(args.examples_file) as f:
        examples = json.load(f)
    prior = None
    if args.prior_skill and os.path.exists(args.prior_skill):
        with open(args.prior_skill) as f:
            prior = f.read()

    user = build_user_prompt(args.category, examples, prior)
    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
    prompt_text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    enc = tok(prompt_text, return_tensors="pt").to(model.device)

    candidates = []
    for i in range(args.k):
        with torch.no_grad():
            out = model.generate(
                **enc, do_sample=True, temperature=args.temperature, top_p=args.top_p,
                max_new_tokens=args.max_new_tokens, pad_token_id=tok.pad_token_id,
            )
        gen = out[0][enc["input_ids"].shape[1]:]
        text = clean_skill(tok.decode(gen, skip_special_tokens=True))
        candidates.append({"idx": i, "skill": text, "chars": len(text), "coverage": coverage_vector(text)})
        print(f"[proposer_v2] candidate {i}: {len(text)} chars coverage={candidates[-1]['coverage']}", flush=True)

    div = batch_diversity([c["skill"] for c in candidates])
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        json.dump({
            "category": args.category, "model": args.model, "adapter": args.adapter,
            "prior_skill": args.prior_skill, "k": args.k, "temperature": args.temperature,
            "diversity": div, "seconds": round(time.time() - t0, 1), "candidates": candidates,
        }, f, ensure_ascii=False, indent=2)
    print(f"[proposer_v2] wrote {len(candidates)} candidates -> {args.out} "
          f"diversity={div} in {time.time()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
