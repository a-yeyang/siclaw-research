/**
 * score-skill.mjs — shared helper: evaluate ONE skill text against the real
 * environment (real Siclaw agent + real judge + composite reward) on a case set.
 * Used by all the skill-optimizer baselines so every method is scored identically
 * and the rollout budget is comparable.
 *
 * Returns the parsed reward.json (full breakdown: scalar reward, judge, composite,
 * per-case judge scores, per-case composite, tokens). One call = N real rollouts.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const CODEX_NODE = "/Users/yye/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";
const NODE = fs.existsSync(CODEX_NODE) ? CODEX_NODE : process.execPath;
const REWARD = "experiments/rl-skill-opt/reward.mjs";

/**
 * @param {object} o
 * @param {string} o.skillText      skill SOP text ("" => no-skill baseline)
 * @param {string[]} o.cases        case ids
 * @param {string} o.provider       brain provider dir (gpt/kimi/...)
 * @param {string} o.runDir         where to write traces+judgments+reward.json
 * @param {string} [o.casesFile]    custom cases.json (e.g. audit set)
 * @param {string} [o.promptDir]    custom prompt dir (e.g. audit prompts)
 * @param {string} [o.baselineJudge] baseline judgments.json for advantage
 * @param {boolean}[o.composite]    use composite reward as the scalar (default true)
 * @param {string} [o.concurrency]  default "3"
 * @param {string} [o.timeoutMs]    default "240000"
 * @param {boolean}[o.reuse]        reuse complete traces in runDir
 * @returns {Promise<object>} the full reward.json object
 */
export function scoreSkill(o) {
  const {
    skillText, cases, provider, runDir, casesFile, promptDir,
    baselineJudge, composite = true, concurrency = "3", timeoutMs = "240000", reuse = false,
  } = o;
  return new Promise((resolve, reject) => {
    fs.mkdirSync(runDir, { recursive: true });
    let skillFile = "";
    if (skillText && skillText.trim()) {
      skillFile = path.join(runDir, "skill.txt");
      fs.writeFileSync(skillFile, skillText);
    }
    const argv = [
      REWARD, "--cases", cases.join(","), "--provider", provider,
      "--run-dir", runDir, "--concurrency", concurrency, "--timeout-ms", timeoutMs,
    ];
    if (skillFile) argv.push("--skill-file", skillFile);
    if (casesFile) argv.push("--cases-file", casesFile);
    if (promptDir) argv.push("--prompt-dir", promptDir);
    if (baselineJudge) argv.push("--baseline-judge", baselineJudge);
    if (composite) argv.push("--composite");
    if (reuse) argv.push("--reuse");
    const child = spawn(NODE, argv, { cwd: process.cwd(), env: { ...process.env, PATH: `${path.dirname(NODE)}:${process.env.PATH}` } });
    child.stdout.on("data", (d) => process.stderr.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`reward.mjs exit ${code} (runDir=${runDir})`));
      try {
        resolve(JSON.parse(fs.readFileSync(path.join(runDir, "reward.json"), "utf8")));
      } catch (e) {
        reject(new Error(`could not read reward.json: ${e.message}`));
      }
    });
  });
}
