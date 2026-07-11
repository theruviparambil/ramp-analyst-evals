/**
 * Judge-agreement receipt.
 *
 * The committed run (out/results.jsonl) scored `add.faithful` with the
 * cross-family Claude Sonnet 4.6 judge. This re-scores the SAME committed
 * answers with a second, same-family gpt-4.1 judge and reports how often the
 * two agree. It is a light cross-judge check, NOT a kappa validation: the full
 * inter-rater-agreement method (Cohen's / Fleiss' kappa against human labels)
 * lives in the companion repo, veriva-eval.
 *
 *   JUDGE_TRANSPORT=openai JUDGE_MODEL=gpt-4.1 npm run judge-agreement
 *
 * Writes out/judge-agreement.json. Needs an OpenAI key.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GOLDEN } from "../src/eval/golden.js";
import { createJudgeClient } from "../src/agent/provider.js";
import { judgeBinary } from "../src/eval/judge.js";

const RESULTS = resolve("out/results.jsonl");
const OUT = resolve("out/judge-agreement.json");

function faithfulCriterion(qid: string): string | null {
  const q = GOLDEN.find((g) => g.id === qid);
  if (!q) return null;
  const c = q.criteria.find((cr) => cr.id === "add.faithful");
  if (!c) return null;
  return c.judgeCriterion ?? c.description;
}

async function main() {
  process.env.JUDGE_TRANSPORT = process.env.JUDGE_TRANSPORT ?? "openai";
  process.env.JUDGE_MODEL = process.env.JUDGE_MODEL ?? "gpt-4.1";
  const judge = createJudgeClient({ maxTokens: 500 });
  if (!judge) {
    throw new Error("no judge client: set OPENAI_API_KEY (or JUDGE_API_KEY) and JUDGE_MODEL");
  }

  const rows = readFileSync(RESULTS, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const perQuestion = [];
  let agree = 0;
  let compared = 0;

  for (const row of rows) {
    const qid = row.id as string;
    const committed = (row.results as Array<Record<string, unknown>>).find((r) => r.id === "add.faithful");
    if (!committed || typeof committed.pass !== "boolean") continue; // judge criterion only
    const claudePass = committed.pass as boolean;
    const criterion = faithfulCriterion(qid);
    if (!criterion) continue;

    const verdict = await judgeBinary(
      { question: row.question, expected: row.expected, answer: row.finalAnswer, criterion },
      judge,
    );
    if (verdict.pass === null) {
      perQuestion.push({ id: qid, claude_pass: claudePass, gpt41_pass: null, agree: null, note: verdict.error });
      continue;
    }
    const a = verdict.pass === claudePass;
    compared += 1;
    if (a) agree += 1;
    perQuestion.push({ id: qid, claude_pass: claudePass, gpt41_pass: verdict.pass, agree: a });
    process.stdout.write(`${qid}: claude=${claudePass} gpt41=${verdict.pass} ${a ? "AGREE" : "DIFFER"}\n`);
  }

  const summary = {
    criterion: "add.faithful",
    committed_judge: "bedrock:us.anthropic.claude-sonnet-4-6",
    second_judge: process.env.JUDGE_MODEL,
    note: "Light cross-judge agreement check on the committed answers, not a kappa validation. The committed add.faithful verdicts are Claude's; this re-scores the same answers with gpt-4.1. Full kappa inter-rater validation lives in veriva-eval.",
    agree,
    compared,
    perQuestion,
  };
  writeFileSync(OUT, JSON.stringify(summary, null, 2) + "\n", "utf8");
  process.stdout.write(`\nAgreement: ${agree}/${compared} on add.faithful. Wrote ${OUT}\n`);
}

main().catch((e) => {
  process.stderr.write(String(e) + "\n");
  process.exit(1);
});
