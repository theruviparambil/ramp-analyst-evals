/**
 * Report formatting: the console table and the Markdown transcript the README
 * quotes from. Kept separate from the runner so the shapes are easy to test.
 */

import type { Trajectory } from "../agent/types.js";
import type { EvalSummary, QuestionScore } from "./rubric.js";

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const mark = (b: boolean): string => (b ? "PASS" : "FAIL");

export function renderTable(scores: QuestionScore[], summary: EvalSummary): string {
  const rows = scores.map((s) => {
    const req = `${s.requiredPassed}/${s.requiredTotal}`;
    const add = `${s.additionalPassed}/${s.additionalEvaluated}`;
    return `  ${s.id.padEnd(22)}  required ${req.padEnd(6)} ${mark(s.requiredPass).padEnd(5)}  additional ${add}`;
  });
  return [
    "Per-question results:",
    ...rows,
    "",
    `REQUIRED tier pass rate:   ${pct(summary.requiredTierPassRate)}  (${summary.requiredTierPassed}/${summary.total} questions, all required criteria met)`,
    `ADDITIONAL tier pass rate: ${pct(summary.additionalTierPassRate)}  (${summary.additionalTierPassed}/${summary.total} questions, all additional criteria met)`,
  ].join("\n");
}

export function renderCriterionBreakdown(summary: EvalSummary): string {
  const sorted = [...summary.criterionPassRates].sort((a, b) => (a.tier === b.tier ? a.id.localeCompare(b.id) : a.tier === "required" ? -1 : 1));
  const lines = sorted.map((c) => {
    const tag = c.tier === "required" ? "[REQ]" : "[ADD]";
    const nat = c.nature === "invariant" ? "(inv)" : "(obs)";
    return `  ${tag} ${nat} ${c.id.padEnd(26)} ${String(c.passed).padStart(2)}/${String(c.evaluated).padStart(2)}  ${pct(c.rate)}`;
  });
  return ["Per-criterion pass rates  [inv]=surface-enforced invariant  [obs]=observed agent behavior:", ...lines].join("\n");
}

export function renderTranscript(question: string, trajectory: Trajectory, finalAnswer: string): string {
  const out: string[] = [];
  out.push(`### ${question}`, "");
  for (const s of trajectory.steps) {
    out.push(`**${s.index + 1}. \`${s.name}\`**: _${s.rationale}_`);
    if (s.name === "execute_analyst_query" && typeof s.args?.sql === "string") {
      out.push("```sql", s.args.sql.trim(), "```");
    }
    const summary = compactResult(s.resultSummary);
    out.push("```json", summary, "```", "");
  }
  out.push("**Answer:**", "", finalAnswer, "");
  return out.join("\n");
}

function compactResult(result: unknown): string {
  const json = JSON.stringify(result, null, 2) ?? "null";
  return json.length > 900 ? `${json.slice(0, 900)}\n… (truncated)` : json;
}
