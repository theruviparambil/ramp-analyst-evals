/**
 * `npm run eval` — run the agent over the golden set, score every answer against
 * the two-tier rubric, print the results, write out/ artifacts, and exit
 * non-zero if the REQUIRED tier drops below the bar (the CI gate).
 *
 *   npm run eval                  # all questions, real agent, CI gate on
 *   npm run demo                  # first 6 questions (cheaper), for the README
 *   npm run eval -- --limit=3     # first 3
 *   EVAL_REQUIRED_BAR=0.9 npm run eval
 *
 * The agent needs one API key (OPENROUTER / OPENAI / ANTHROPIC). The scoring is
 * deterministic; the LLM judge only adds ADDITIONAL-tier signal and is skipped
 * cleanly if unavailable.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgent } from "../agent/agent.js";
import { createProviderClient, resolveAgentModel } from "../agent/provider.js";
import { selectBackend } from "../ramp/backend.js";
import { GOLDEN } from "./golden.js";
import { loadDotenv } from "./env.js";
import { renderCriterionBreakdown, renderTable, renderTranscript } from "./report.js";
import { passesGate, scoreQuestion, summarize, type QuestionScore } from "./rubric.js";

interface Args {
  limit: number;
  outDir: string;
  tag: string;
  requiredBar: number;
  noJudge: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const has = (k: string): boolean => argv.includes(`--${k}`);
  return {
    limit: get("limit") ? Number.parseInt(get("limit")!, 10) : GOLDEN.length,
    outDir: get("out") ?? "out",
    tag: get("tag") ?? "eval",
    requiredBar: process.env.EVAL_REQUIRED_BAR ? Number.parseFloat(process.env.EVAL_REQUIRED_BAR) : 0.9,
    noJudge: has("no-judge"),
  };
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
  const judge = args.noJudge ? undefined : createProviderClient({ maxTokens: 500 });
  const questions = GOLDEN.slice(0, args.limit);

  console.log(`ramp-analyst-evals — ${questions.length} question(s), model ${agent.label}, RAMP_MODE=${process.env.RAMP_MODE ?? "fixture"}\n`);

  const scores: QuestionScore[] = [];
  const transcripts: string[] = [];
  const startedAt = new Date().toISOString();

  for (const q of questions) {
    process.stdout.write(`• ${q.id} … `);
    const surface = selectBackend(); // fresh docs-handshake session per question
    const t0 = Date.now();
    try {
      const { trajectory, finalAnswer } = await runAgent(q.question, { client: agent, surface });
      const score = await scoreQuestion(q, finalAnswer, trajectory, { judge });
      scores.push(score);
      transcripts.push(renderTranscript(q.question, trajectory, finalAnswer));
      console.log(`required ${score.requiredPassed}/${score.requiredTotal} ${score.requiredPass ? "PASS" : "FAIL"}, additional ${score.additionalPassed}/${score.additionalEvaluated}  (${trajectory.steps.length} tool calls, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      console.log(`ERROR: ${(err as Error).message}`);
      scores.push({
        id: q.id, question: q.question, expected: q.expected, finalAnswer: `ERROR: ${(err as Error).message}`,
        results: [], requiredTotal: 0, requiredPassed: 0, requiredPass: false,
        additionalTotal: 0, additionalEvaluated: 0, additionalPassed: 0, additionalPass: false,
        steps: 0, hitStepCap: false,
      });
    }
  }

  const summary = summarize(scores);
  console.log("\n" + renderTable(scores, summary) + "\n");
  console.log(renderCriterionBreakdown(summary) + "\n");

  await mkdir(args.outDir, { recursive: true });
  const meta = { startedAt, finishedAt: new Date().toISOString(), model: agent.label, tag: args.tag, requiredBar: args.requiredBar, ...summary };
  await writeFile(resolve(args.outDir, "results.jsonl"), scores.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
  await writeFile(resolve(args.outDir, "summary.json"), JSON.stringify(meta, null, 2), "utf8");
  await writeFile(resolve(args.outDir, "transcripts.md"), transcripts.join("\n---\n\n"), "utf8");
  console.log(`Artifacts written to ${args.outDir}/ (results.jsonl, summary.json, transcripts.md)`);

  if (!passesGate(summary, args.requiredBar)) {
    console.error(`\nCI GATE: REQUIRED tier ${(summary.requiredTierPassRate * 100).toFixed(0)}% < bar ${(args.requiredBar * 100).toFixed(0)}% — failing.`);
    process.exit(1);
  }
  console.log(`\nCI GATE: REQUIRED tier ${(summary.requiredTierPassRate * 100).toFixed(0)}% ≥ bar ${(args.requiredBar * 100).toFixed(0)}% — pass.`);
}

main().catch((err) => {
  console.error(`eval: ${(err as Error).message}`);
  process.exit(1);
});
