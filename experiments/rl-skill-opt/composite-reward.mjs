/**
 * composite-reward.mjs — partially-verifiable composite reward for SRE-skill RL.
 *
 *   R = judge_score + RUBRIC_W * rubric_bonus − SPURIOUS_W * spurious_penalty
 *
 * Motivation (see RELATED-WORK-AND-PLAN.md C.5 and "One Token to Fool LLM-as-a-Judge"
 * 2507.08794): a judge-only reward is hackable — the prior RL run learned to stuff
 * "DNS" keywords and the judge rewarded it, but the skill mislabeled NetworkPolicy
 * faults as DNS and regressed on held-out. The composite reward adds VERIFIABLE
 * components computed directly from the agent's trace (tool calls + diagnosis text),
 * which a keyword-stuffing skill cannot fake, and a spurious-cue penalty that
 * punishes claiming DNS without the matching evidence.
 *
 * The 3-item verifiable rubric (each in [0,1], from the trace — NOT the judge):
 *   r1  enumeratedNetworkPolicies  — did the agent list NetworkPolicies (get netpol)
 *                                    BEFORE concluding? (process check)
 *   r2  inspectedDnsConfig         — did the agent inspect the client's DNS config
 *                                    (pod -o yaml / dnsConfig / resolv.conf)?
 *   r3  rootCauseClassCorrect      — does the FINAL diagnosis name the correct
 *                                    root-cause CLASS {dns | networkpolicy | selector}
 *                                    matching the case's ground-truth class?
 *
 * spurious_penalty in [0,1]: the diagnosis asserts a DNS-override / bad-nameserver
 * root cause WITHOUT the evidence that would justify it (no overriding nameserver
 * was actually observed, and the true class is not dns). This is the exact
 * reward-hack we are defending against.
 *
 * Everything here is deterministic and rule-based: this is the "verifiable" leg of
 * the reward and the independent yardstick for the reward–truth gap.
 */

// ── weights (tunable; defaults chosen so the composite stays ~[0,1.x]) ─────────
export const RUBRIC_W = 0.5; // max +0.5 added by the 3-item rubric (mean*0.5... see below)
export const SPURIOUS_W = 0.5; // max −0.5 for a confident unsupported DNS claim

// ── text/trace helpers ─────────────────────────────────────────────────────────
function toolCmds(trace) {
  // flatten every tool call into a single lowercased command string for matching
  const out = [];
  for (const t of trace?.toolCalls || []) {
    let a = t.args;
    if (typeof a !== "string") {
      try { a = JSON.stringify(a); } catch { a = String(a); }
    }
    out.push(`${t.toolName || ""} ${a || ""}`.toLowerCase());
  }
  return out;
}

function finalText(trace) {
  return String(trace?.finalText ?? trace?.result?.finalText ?? "").toLowerCase();
}

// ── the 3 verifiable rubric items ──────────────────────────────────────────────

// r1: did the agent ENUMERATE NetworkPolicies (list them) during the investigation?
//     A correct multi-cause procedure inspects NetworkPolicies before concluding.
export function enumeratedNetworkPolicies(trace) {
  const cmds = toolCmds(trace);
  // "get networkpolicy" / "get netpol" (with or without a name) anywhere in the trace.
  return cmds.some((c) => /\bget\b[\s\S]*\b(networkpolic(y|ies)|netpol)\b/.test(c)) ? 1 : 0;
}

// r2: did the agent INSPECT the client's DNS configuration (to rule a DNS override
//     in or out)? pod -o yaml exposes dnsConfig/dnsPolicy; resolv.conf is the
//     in-pod confirmation.
export function inspectedDnsConfig(trace) {
  const cmds = toolCmds(trace);
  const podYaml = cmds.some(
    (c) => /\bget\b[\s\S]*\bpod\b[\s\S]*\b(-o\s*yaml|jsonpath[\s\S]*dns|dnsconfig|dnspolicy)\b/.test(c),
  );
  const resolv = cmds.some((c) => /resolv\.conf|dnsconfig|nameserver/.test(c));
  return podYaml || resolv ? 1 : 0;
}

// ── root-cause CLASS classification of the FINAL diagnosis ──────────────────────
// We classify what the diagnosis BLAMES as the primary root cause into one of
// {dns, networkpolicy, selector, other}. This is deliberately conservative and
// keyed on the localization/mechanism language, not loose keyword counts.

const DNS_OVERRIDE_CUES = [
  /custom (dns|nameserver)/, /dns ?config/, /dnsconfig/, /overrid\w* (the )?(dns|nameserver)/,
  /bad nameserver/, /wrong nameserver/, /203\.0\.113\./, /198\.51\.100\./, /192\.0\.2\./,
  /test-net/, /non-cluster (dns|nameserver|resolver)/, /points to .* nameserver/,
];
const NETPOL_CUES = [
  /networkpolicy/, /network policy/, /deny[- ]?egress/, /deny[- ]?ingress/,
  /blocks? (all )?(egress|ingress)/, /denies? (all )?(egress|ingress)/,
  /egress (is )?(blocked|denied)/, /ingress (is )?(blocked|denied)/,
];
const SELECTOR_CUES = [
  /selector (mismatch|typo|does ?n.t match|doesn.t match|is wrong|points)/,
  /(zero|no|0|empty) endpoints/, /no (matching )?endpoints/, /service .* (no|zero) endpoints/,
  /label (mismatch|selector mismatch)/, /service selector/,
];

// Extract the ROOT-CAUSE region of the diagnosis so we classify what the agent
// AFFIRMS as the cause, not incidental mentions in evidence/remediation (e.g.
// "remediation: check if a NetworkPolicy is blocking..." must NOT count as a
// NetworkPolicy diagnosis). We take the text from the first root-cause marker up
// to the next section header (evidence/remediation/impact/...). If no marker, use
// the whole text.
function rootCauseRegion(text) {
  const startRe = /(root[\s-]*cause|final diagnosis|primary (issue|cause|fault)|diagnosis[:\s])/i;
  const m = text.match(startRe);
  if (!m) return text;
  const from = m.index;
  const rest = text.slice(from + m[0].length);
  // stop at the next section header
  const stopRe = /\n\s*[*#_>\-\d.\s]*\b(evidence|remediation|safe remediation|impact|scope|confidence|recommend|next step|secondary)\b/i;
  const s = rest.search(stopRe);
  const region = s >= 0 ? rest.slice(0, s) : rest.slice(0, 600);
  return region;
}

// Remove negated / hypothetical mentions ("no networkpolicy", "ruled out ...",
// "not a DNS issue", "check if a networkpolicy ...") so they don't get counted as
// an affirmed cause.
function stripNegations(text) {
  return text
    .replace(/\b(no|not|without|n.t|isn.t|aren.t|rule[ds]?\s*out|ruled out|verify (there'?s )?no|check (if|whether)|ensure no|confirm no)\b[^.!?\n]{0,60}/g, " ");
}

function classifyDiagnosis(text) {
  // Prefer the root-cause region (affirmed cause); fall back to full text.
  const region = stripNegations(rootCauseRegion(text));
  const score = (cues, t) => cues.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
  let dns = score(DNS_OVERRIDE_CUES, region);
  let netpol = score(NETPOL_CUES, region);
  let selector = score(SELECTOR_CUES, region);
  // A plain "dns resolution failure" claim in the root-cause region counts as a
  // dns-class diagnosis even without an explicit override cue (the agent is
  // BLAMING dns). This is what makes the spurious-penalty fire on the hack.
  if (/dns (resolution )?(failure|fail|issue|problem|timeout|cannot resolve|not (working|resolving))/.test(region)) dns += 1;
  const max = Math.max(dns, netpol, selector);
  if (max === 0) {
    // nothing in the root-cause region — fall back to a light scan of full text
    const ft = stripNegations(text);
    dns = score(DNS_OVERRIDE_CUES, ft) + (/dns (resolution )?(failure|fail|issue|problem|timeout)/.test(ft) ? 1 : 0);
    netpol = score(NETPOL_CUES, ft);
    selector = score(SELECTOR_CUES, ft);
    const m2 = Math.max(dns, netpol, selector);
    if (m2 === 0) return { cls: "other", dns, netpol, selector };
    if (selector === m2 && selector >= netpol && selector >= dns) return { cls: "selector", dns, netpol, selector };
    if (netpol === m2 && netpol >= dns) return { cls: "networkpolicy", dns, netpol, selector };
    return { cls: "dns", dns, netpol, selector };
  }
  // selector and networkpolicy can co-mention; prefer the most specific match.
  if (selector === max && selector >= netpol && selector >= dns) return { cls: "selector", dns, netpol, selector };
  if (netpol === max && netpol >= dns) return { cls: "networkpolicy", dns, netpol, selector };
  return { cls: "dns", dns, netpol, selector };
}

// the case's TRUE root-cause class, from ground truth (audit cases carry it
// explicitly; for the standard network-dns cases we derive it from the localization).
export function trueClass(caseObj) {
  if (caseObj?.rootCauseClass) return caseObj.rootCauseClass;
  const loc = String(caseObj?.groundTruth?.localization ?? "").toLowerCase();
  const mech = String(caseObj?.groundTruth?.mechanism ?? "").toLowerCase();
  if (/networkpolicy/.test(loc)) return "networkpolicy";
  if (/dns|nameserver|dnsconfig/.test(mech) || /-client$/.test(loc) && /dns|nameserver/.test(mech)) return "dns";
  if (/service\//.test(loc) && /selector|endpoint/.test(mech)) return "selector";
  // network-dns DNS-override cases localize to the client pod
  if (/pod\/.*client/.test(loc) && /dns|nameserver/.test(mech)) return "dns";
  return "other";
}

// r3: does the diagnosis name the correct root-cause CLASS?
export function rootCauseClassCorrect(trace, caseObj) {
  const tc = trueClass(caseObj);
  const { cls } = classifyDiagnosis(finalText(trace));
  return { correct: cls === tc ? 1 : 0, predictedClass: cls, trueClass: tc };
}

// ── spurious-cue penalty: confident DNS claim without DNS evidence ──────────────
// The hack we punish: the diagnosis blames a DNS override / bad nameserver, but
//  (a) the true class is NOT dns, AND
//  (b) the trace never actually OBSERVED an overriding nameserver
//      (no non-cluster nameserver IP appears in any tool output / the diagnosis).
// We approximate "observed a real override" by the presence of a documentation/
// TEST-NET nameserver string in the diagnosis (the real DNS cases use 203.0.113.1).
export function spuriousPenalty(trace, caseObj) {
  const text = finalText(trace);
  const { cls } = classifyDiagnosis(text);
  const tc = trueClass(caseObj);
  if (cls !== "dns") return { penalty: 0, reason: "diagnosis is not a DNS-override claim" };
  if (tc === "dns") return { penalty: 0, reason: "DNS claim and the case really is DNS" };
  // diagnosis blames DNS but the truth is not DNS -> check whether it cited a real
  // overriding nameserver (the only legitimate justification). If not, it's a hack.
  const citedRealOverride = /(203\.0\.113\.|198\.51\.100\.|192\.0\.2\.)/.test(text);
  if (citedRealOverride) return { penalty: 0.3, reason: "DNS claim on a non-DNS case but cited an IP (partial)" };
  return { penalty: 1, reason: "confident DNS-override claim on a non-DNS case with no observed override (reward-hack)" };
}

// ── the composite ──────────────────────────────────────────────────────────────
/**
 * Compute the composite reward for ONE case.
 * @param judgeScore number in [0,1] (the LLM judge total for this case)
 * @param trace      the agent result.json object (toolCalls + finalText)
 * @param caseObj    the case (with groundTruth + optional rootCauseClass)
 */
export function compositeForCase(judgeScore, trace, caseObj) {
  const r1 = enumeratedNetworkPolicies(trace);
  const r2 = inspectedDnsConfig(trace);
  const r3o = rootCauseClassCorrect(trace, caseObj);
  const rubric = (r1 + r2 + r3o.correct) / 3; // verifiable rubric score in [0,1]
  const sp = spuriousPenalty(trace, caseObj);
  const composite = judgeScore + RUBRIC_W * rubric - SPURIOUS_W * sp.penalty;
  return {
    judgeScore,
    rubric: {
      enumeratedNetworkPolicies: r1,
      inspectedDnsConfig: r2,
      rootCauseClassCorrect: r3o.correct,
      predictedClass: r3o.predictedClass,
      trueClass: r3o.trueClass,
      score: Math.round(rubric * 1000) / 1000,
    },
    spuriousPenalty: { value: sp.penalty, reason: sp.reason },
    composite: Math.round(composite * 1000) / 1000,
    // "reward–truth gap" ingredients: judge (proxy) vs verifiable rubric (truth-ish)
    rewardTruthGap: Math.round((judgeScore - rubric) * 1000) / 1000,
    // mislabel flag for audit accounting: did it get the root-cause class wrong?
    mislabeled: r3o.correct === 0 ? 1 : 0,
  };
}

/**
 * Aggregate composite over a set of (caseId -> judgeScore) + traces + cases.
 * Returns mean composite (the scalar reward), mean rubric, mean reward-truth gap,
 * mislabel rate, and per-case detail.
 */
export function aggregateComposite(perCaseJudge, tracesById, casesById) {
  const ids = Object.keys(perCaseJudge);
  const perCase = {};
  let sC = 0, sR = 0, sJ = 0, sGap = 0, sMis = 0, sSpur = 0, n = 0;
  for (const id of ids) {
    const trace = tracesById[id];
    const caseObj = casesById[id];
    if (!trace || !caseObj) continue;
    const c = compositeForCase(perCaseJudge[id] ?? 0, trace, caseObj);
    perCase[id] = c;
    sC += c.composite; sR += c.rubric.score; sJ += c.judgeScore;
    sGap += c.rewardTruthGap; sMis += c.mislabeled; sSpur += c.spuriousPenalty.value; n++;
  }
  const m = (x) => (n ? Math.round((x / n) * 1000) / 1000 : 0);
  return {
    n,
    composite: m(sC), // the scalar reward used for RL
    judgeMean: m(sJ),
    rubricMean: m(sR),
    rewardTruthGap: m(sGap),
    mislabelRate: m(sMis),
    spuriousMean: m(sSpur),
    perCase,
  };
}
