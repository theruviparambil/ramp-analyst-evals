/**
 * `npm run eval`: run the agent over the golden set, score every answer against
 * the two-tier rubric, print the results, write out/ artifacts, and exit
 * non-zero if the REQUIRED tier drops below the bar (the eval gate).
 *
 *   npm run eval                    # all questions, real agent
 *   npm run demo                    # first 6 questions (cheaper), for the README
 *   npm run eval -- --samples=5     # variance control: mean + range over 5 runs
 *   EVAL_REQUIRED_BAR=0.9 npm run eval
 *
 * Two gates, kept distinct on purpose:
 *   - the OFFLINE unit tests (`npm test`) run keyless in CI (.github/workflows).
 *   - this EVAL gate needs a key, because it has to generate real trajectories.
 *
 * The judge is a SEPARATE model (see createJudgeClient / JUDGE_MODEL) and only
 * scores the non-gating ADDITIONAL tier, so a wobbly or same-family judge never
 * moves the gated number.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { harnessProvenance } from "./provenance.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runAgent } from "../agent/agent.js";
import { createJudgeClient, createProviderClient, judgeSharesFamilyWithAgent, resolveAgentModel, resolveTimeoutMs, type ProviderClient } from "../agent/provider.js";
import { selectBackend } from "../ramp/backend.js";
import { GOLDEN } from "./golden.js";
import { agentPrompt, type GoldenQuestion } from "./spec.js";
import { loadDotenv } from "./env.js";
import { renderCriterionBreakdown, renderTable, renderTranscript } from "./report.js";
import { passesGate, scoreQuestion, summarize, type EvalSummary, type QuestionScore } from "./rubric.js";
import type { LLMClient } from "../agent/types.js";

interface Args {
  limit: number;
  outDir: string;
  force: boolean;
  tag: string;
  requiredBar: number;
  noJudge: boolean;
  samples: number;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const has = (k: string): boolean => argv.includes(`--${k}`);
  return {
    limit: get("limit") ? Number.parseInt(get("limit")!, 10) : GOLDEN.length,
    outDir: get("out") ?? "out",
    force: argv.includes("--force"),
    tag: get("tag") ?? "eval",
    requiredBar: process.env.EVAL_REQUIRED_BAR ? Number.parseFloat(process.env.EVAL_REQUIRED_BAR) : 0.9,
    noJudge: has("no-judge"),
    samples: get("samples") ? Math.max(1, Number.parseInt(get("samples")!, 10)) : 1,
  };
}

interface Sample {
  scores: QuestionScore[];
  summary: EvalSummary;
  transcripts: string[];
}

async function runSample(agent: LLMClient, judge: LLMClient | undefined, questions: GoldenQuestion[], quiet: boolean): Promise<Sample> {
  const scores: QuestionScore[] = [];
  const transcripts: string[] = [];
  for (const q of questions) {
    if (!quiet) process.stdout.write(`• ${q.id} … `);
    const surface = selectBackend(); // fresh docs-handshake session per question
    const t0 = Date.now();
    try {
      const { trajectory, finalAnswer } = await runAgent(agentPrompt(q), { client: agent, surface });
      const score = await scoreQuestion(q, finalAnswer, trajectory, { judge });
      scores.push(score);
      transcripts.push(renderTranscript(q.question, trajectory, finalAnswer));
      if (!quiet) console.log(`required ${score.requiredPassed}/${score.requiredTotal} ${score.requiredPass ? "PASS" : "FAIL"}, additional ${score.additionalPassed}/${score.additionalEvaluated}  (${trajectory.steps.length} calls, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      // A throw means we never got an answer to grade: infrastructure, not a
      // wrong answer. Flag it as an infra error so summarize() excludes it from
      // the pass-rate denominator instead of scoring it as a capability failure.
      const message = err instanceof Error ? err.message : String(err);
      if (!quiet) console.log(`INFRA ERROR (excluded from scoring): ${message}`);
      scores.push({
        id: q.id, question: q.question, expected: q.expected, finalAnswer: `INFRA_ERROR: ${message}`,
        results: [], requiredTotal: 0, requiredPassed: 0, requiredPass: false,
        additionalTotal: 0, additionalEvaluated: 0, additionalPassed: 0, additionalPass: false,
        steps: 0, hitStepCap: false, infraError: true, errorMessage: message,
      });
    }
  }
  return { scores, summary: summarize(scores), transcripts };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);

/**
 * Refuse to silently overwrite someone else's receipt.
 *
 * The default outDir is `out`, and `out/` holds a COMMITTED result set. Before
 * this guard, `npm run demo` (6 questions, tag=demo) wrote straight over the
 * published 12-question run: a clone-and-try would show the repo's headline
 * numbers replaced by a partial demo, in the working tree, with no warning.
 *
 * Re-running the SAME configuration still overwrites, which is the normal case.
 * Only a differing model, tag, or question count is treated as a collision.
 */
/**
 * Write the run artifacts. Extracted and exported because this runs AFTER every
 * API call has been paid for: a throw here discards the whole run, and it was
 * previously the only part of the pipeline with no test at all.
 *
 * results.jsonl carries EVERY sample, stamped with a 1-based `sample` index, so
 * per-question variance stays auditable. transcripts.md is the last sample only,
 * which the console line states rather than leaving the reader to assume.
 */
export async function writeArtifacts(
  outDir: string,
  meta: unknown,
  samples: Array<{ scores: QuestionScore[] }>,
  transcripts: string[],
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const stamped = samples.flatMap((smp, i) => smp.scores.map((sc) => ({ sample: i + 1, ...sc })));
  await writeFile(resolve(outDir, "results.jsonl"), stamped.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  await writeFile(resolve(outDir, "summary.json"), JSON.stringify(meta, null, 2), "utf8");
  await writeFile(resolve(outDir, "transcripts.md"), transcripts.join("\n---\n\n"), "utf8");
}

export interface PriorReceipt {
  model?: unknown;
  tag?: unknown;
  questions?: unknown;
}

/**
 * How an incoming run differs from the receipt already sitting in outDir.
 * Empty means "same configuration", which is a normal re-run and may overwrite.
 * Fields absent from the prior file are not treated as differences: an older
 * receipt predating a field should not block a legitimate re-run.
 */
export function receiptCollision(prior: PriorReceipt, model: string, tag: string, questionCount: number): string[] {
  return [
    prior.model !== undefined && prior.model !== model ? `model ${String(prior.model)} -> ${model}` : null,
    prior.tag !== undefined && prior.tag !== tag ? `tag ${String(prior.tag)} -> ${tag}` : null,
    prior.questions !== undefined && prior.questions !== questionCount ? `questions ${String(prior.questions)} -> ${questionCount}` : null,
  ].filter((x): x is string => x !== null);
}

async function guardExistingReceipt(args: Args, model: string, questionCount: number): Promise<void> {
  if (args.force) return;
  let prior: PriorReceipt;
  try {
    prior = JSON.parse(await readFile(resolve(args.outDir, "summary.json"), "utf8")) as PriorReceipt;
  } catch {
    return; // nothing there, or unreadable: nothing to protect
  }
  const differs = receiptCollision(prior, model, args.tag, questionCount);
  if (differs.length === 0) return;
  console.error(`Refusing to overwrite ${args.outDir}/summary.json: it holds a different run (${differs.join("; ")}).`);
  console.error(`Write elsewhere with --out=<dir>, or pass --force to replace it.`);
  process.exit(2);
}

async function main(): Promise<void> {
  loadDotenv();
  const args = parseArgs(process.argv.slice(2));

  const resolved = resolveAgentModel();
  if (!resolved) {
    console.error("No LLM key set. Provide OPENROUTER_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY (see .env.example).");
    console.error("The offline test suite runs without a key: `npm test`.");
    process.exit(2);
  }

  const agent = createProviderClient();
  const judge: ProviderClient | undefined = args.noJudge ? undefined : createJudgeClient({ maxTokens: 500 }) ?? undefined;
  const questions = GOLDEN.slice(0, args.limit);

  console.log(`ramp-analyst-evals: ${questions.length} question(s) x ${args.samples} sample(s), RAMP_MODE=${process.env.RAMP_MODE ?? "fixture"}`);
  console.log(`  agent: ${agent.label}`);
  if (judge) {
    const shared = judgeSharesFamilyWithAgent();
    console.log(`  judge: ${judge.label}  [${shared ? "SAME provider family as agent: self-preference risk; additional tier is non-gating" : "cross-family / independent provider"}]`);
    if (shared) console.log(`         (set JUDGE_TRANSPORT=bedrock + AWS_BEARER_TOKEN_BEDROCK for a cross-family Claude judge)`);
  } else {
    console.log(`  judge: disabled`);
  }
  console.log("");

  const samples: Sample[] = [];
  for (let i = 0; i < args.samples; i++) {
    if (args.samples > 1) console.log(`[ sample ${i + 1}/${args.samples} ]`);
    samples.push(await runSample(agent, judge, questions, false));
  }

  // Aggregate. The deterministic REQUIRED tier is reported as a single mean; the
  // model-dependent ADDITIONAL tier is reported as mean + range (variance control).
  // A sample where nothing scored contributes null, not 1. Averaging it in as a
  // perfect score is how a run whose questions all infra-errored reported 100%.
  const reqRates = samples
    .map((s) => s.summary.requiredTierPassRate)
    .filter((x): x is number => x !== null);
  const addRates = samples
    .map((s) => s.summary.additionalTierPassRate)
    .filter((x): x is number => x !== null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const meanRequired = mean(reqRates);
  const meanAdditional = mean(addRates);
  const allScores = samples.flatMap((s) => s.scores);
  const mergedSummary = summarize(allScores);

  // Per-question pass frequency across samples, over VALID (non-infra-error) runs.
  const last = samples[samples.length - 1]!;
  const perQuestion = questions.map((q) => {
    const runs = samples.map((s) => s.scores.find((x) => x.id === q.id)!);
    const valid = runs.filter((r) => !r.infraError);
    return { id: q.id, samples: valid.length, errored: runs.length - valid.length, requiredPass: valid.filter((r) => r.requiredPass).length, additionalPass: valid.filter((r) => r.additionalPass).length };
  });
  const erroredTotal = mergedSummary.errored;

  if (args.samples > 1) {
    console.log("Per-question pass frequency (over valid samples):");
    for (const p of perQuestion) console.log(`  ${p.id.padEnd(24)} required ${p.requiredPass}/${p.samples}   additional ${p.additionalPass}/${p.samples}${p.errored ? `   (${p.errored} infra-error, excluded)` : ""}`);
    console.log("");
    console.log("Across samples:");
    const range = (xs: number[]) =>
      xs.length ? `(range ${pct(Math.min(...xs))}–${pct(Math.max(...xs))} over ${args.samples})` : "(no scored samples)";
    console.log(`  REQUIRED tier:   ${pct(meanRequired)} mean  ${range(reqRates)}`);
    console.log(`  ADDITIONAL tier: ${pct(meanAdditional)} mean  ${range(addRates)}`);
    console.log(`  Infra errors excluded: ${erroredTotal} of ${samples.length * questions.length} runs${erroredTotal ? ". Raise AGENT_TIMEOUT_MS and re-run for a clean result" : ""}\n`);
  } else {
    console.log("\n" + renderTable(last.scores, last.summary) + "\n");
    if (erroredTotal) console.log(`Infra errors excluded: ${erroredTotal}\n`);
  }
  console.log(renderCriterionBreakdown(mergedSummary) + "\n");

  // Agent and judge can be different vendors with different prices, so cost is
  // tracked separately (AGENT_PRICE_* vs JUDGE_PRICE_*, $ per 1M in/out).
  const cost = (u: { promptTokens: number; completionTokens: number }, inK: string, outK: string): number | null => {
    const pin = Number.parseFloat(process.env[inK] ?? "");
    const pout = Number.parseFloat(process.env[outK] ?? "");
    return Number.isFinite(pin) && Number.isFinite(pout) ? (u.promptTokens / 1e6) * pin + (u.completionTokens / 1e6) * pout : null;
  };
  const agentCost = cost(agent.usage, "AGENT_PRICE_IN", "AGENT_PRICE_OUT");
  const judgeCost = judge ? cost(judge.usage, "JUDGE_PRICE_IN", "JUDGE_PRICE_OUT") : null;
  const totalCost = agentCost !== null || judgeCost !== null ? (agentCost ?? 0) + (judgeCost ?? 0) : null;
  const fmtUsd = (c: number | null) => (c !== null ? `$${c.toFixed(2)}` : "n/a");

  console.log(`Usage (all samples):`);
  console.log(`  agent ${agent.label}: ${agent.usage.calls} calls, ${agent.usage.promptTokens.toLocaleString()} + ${agent.usage.completionTokens.toLocaleString()} tokens  ≈ ${fmtUsd(agentCost)}`);
  if (judge) console.log(`  judge ${judge.label}: ${judge.usage.calls} calls, ${judge.usage.promptTokens.toLocaleString()} + ${judge.usage.completionTokens.toLocaleString()} tokens  ≈ ${fmtUsd(judgeCost)}`);
  console.log(`  total ≈ ${fmtUsd(totalCost)}`);

  await mkdir(args.outDir, { recursive: true });
  await guardExistingReceipt(args, agent.label, questions.length);
  const meta = {
    startedAt: new Date().toISOString(), model: agent.label, judge: judge?.label ?? null, judgeSharesFamily: judge ? judgeSharesFamilyWithAgent() : null,
    // Two runs are comparable only if harness.gradingHash matches. See provenance.ts.
    harness: harnessProvenance(),
    tag: args.tag, requiredBar: args.requiredBar, samples: args.samples, questions: questions.length,
    infraErrorsExcluded: erroredTotal, agentTimeoutMs: resolveTimeoutMs("AGENT_TIMEOUT_MS", 240_000),
    requiredTier: { mean: meanRequired, min: Math.min(...reqRates), max: Math.max(...reqRates), perSample: reqRates },
    additionalTier: { mean: meanAdditional, min: Math.min(...addRates), max: Math.max(...addRates), perSample: addRates },
    perQuestion,
    usage: {
      agent: { ...agent.usage, estCostUsd: agentCost },
      judge: judge ? { ...judge.usage, estCostUsd: judgeCost } : null,
      totalCostUsd: totalCost,
    },
    criterionPassRates: mergedSummary.criterionPassRates,
  };
  // Every sample, not just the last. A 5-sample run that persists one sample's
  // per-question detail cannot answer the question you paid five samples to ask:
  // WHICH questions moved. The `sample` field is 1-based to match the console log.
  await writeArtifacts(args.outDir, meta, samples, last.transcripts);
  console.log(`Artifacts written to ${args.outDir}/ (results.jsonl: all ${args.samples} sample(s); summary.json; transcripts.md: sample ${args.samples} only)`);

  if (!passesGate({ ...mergedSummary, requiredTierPassRate: meanRequired }, args.requiredBar)) {
    const why =
      meanRequired === null
        ? `nothing was scored (${erroredTotal} infra ${erroredTotal === 1 ? "error" : "errors"})`
        : `REQUIRED tier ${pct(meanRequired)} < bar ${pct(args.requiredBar)}`;
    console.error(`\nEVAL GATE: ${why}. Failing.`);
    process.exit(1);
  }
  console.log(`\nEVAL GATE: REQUIRED tier ${pct(meanRequired)} ≥ bar ${pct(args.requiredBar)}. Pass.`);
}

/**
 * Run main() only when this file IS the entrypoint. Without the guard, importing
 * anything from this module (a test, another script) launches a full eval run.
 * argv[1] is compared as a file URL so it matches however tsx resolved the path.
 */
const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error(`eval: ${(err as Error).message}`);
    process.exit(1);
  });
}
