/**
 * Deterministic checkers — the part of the rubric a machine can settle without
 * a judge. Each returns a binary pass plus a short detail string for the report.
 * These back the REQUIRED tier (the agent's SLAs), so the CI gate is fully
 * deterministic and does not depend on an LLM judge.
 */

import { extractAmountsCents } from "../money.js";
import type { Trajectory } from "../agent/types.js";

export interface CheckContext {
  question: string;
  finalAnswer: string;
  trajectory: Trajectory;
}

export interface CheckOutcome {
  pass: boolean;
  detail: string;
}

const money = (cents: number): string => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The final answer states a dollar figure matching `expectedCents` within tolerance. */
export function answerContainsAmount(
  ctx: CheckContext,
  expectedCents: number,
  opts: { tolCents?: number; tolFrac?: number } = {},
): CheckOutcome {
  const tol = Math.max(opts.tolCents ?? 0, Math.abs(expectedCents) * (opts.tolFrac ?? 0));
  const found = extractAmountsCents(ctx.finalAnswer);
  const hit = found.find((c) => Math.abs(c - expectedCents) <= tol);
  return hit !== undefined
    ? { pass: true, detail: `states ${money(hit)} (expected ${money(expectedCents)})` }
    : { pass: false, detail: `expected ${money(expectedCents)}; answer had ${found.length ? found.map(money).join(", ") : "no dollar figure"}` };
}

/** A whole number (e.g. a count) appears in the answer. */
export function answerContainsNumber(ctx: CheckContext, expected: number): CheckOutcome {
  const nums = (ctx.finalAnswer.match(/\b\d[\d,]*\b/g) ?? []).map((s) => Number.parseInt(s.replace(/,/g, ""), 10));
  return nums.includes(expected)
    ? { pass: true, detail: `states ${expected}` }
    : { pass: false, detail: `expected ${expected}; not found` };
}

/** The answer mentions every term (case-insensitive substring). */
export function answerMentionsAll(ctx: CheckContext, terms: string[]): CheckOutcome {
  const hay = ctx.finalAnswer.toLowerCase();
  const missing = terms.filter((t) => !hay.includes(t.toLowerCase()));
  return missing.length === 0
    ? { pass: true, detail: `mentions ${terms.join(", ")}` }
    : { pass: false, detail: `missing: ${missing.join(", ")}` };
}

/** The answer mentions at least one of the terms. */
export function answerMentionsAny(ctx: CheckContext, terms: string[]): CheckOutcome {
  const hay = ctx.finalAnswer.toLowerCase();
  const hit = terms.find((t) => hay.includes(t.toLowerCase()));
  return hit
    ? { pass: true, detail: `mentions "${hit}"` }
    : { pass: false, detail: `none of: ${terms.join(", ")}` };
}

/** READ-ONLY invariant: no write tool was called anywhere in the trajectory. */
export function readOnly(ctx: CheckContext): CheckOutcome {
  const writes = ctx.trajectory.steps.filter((s) => s.kind === "write");
  return writes.length === 0
    ? { pass: true, detail: "no write tool called" }
    : { pass: false, detail: `write tools called: ${writes.map((s) => s.name).join(", ")}` };
}

/** The answer is grounded in an actual successful call to `toolName`. */
export function groundedIn(ctx: CheckContext, toolName: string): CheckOutcome {
  const ok = ctx.trajectory.steps.some((s) => s.name === toolName && s.ok);
  return ok
    ? { pass: true, detail: `used ${toolName}` }
    : { pass: false, detail: `no successful ${toolName} call` };
}

/** Every tool call carried a non-empty rationale (a Ramp requirement). */
export function everyCallHasRationale(ctx: CheckContext): CheckOutcome {
  const missing = ctx.trajectory.steps.filter((s) => !s.rationale || s.rationale.trim().length === 0);
  return missing.length === 0
    ? { pass: true, detail: `all ${ctx.trajectory.steps.length} calls had a rationale` }
    : { pass: false, detail: `${missing.length} call(s) missing rationale: ${missing.map((s) => s.name).join(", ")}` };
}

/** Money in the answer is Ramp-formatted: comma-grouped, two decimals. */
export function moneyFormatted(ctx: CheckContext): CheckOutcome {
  // Stop the token at the cents so trailing sentence punctuation isn't captured.
  const tokens = ctx.finalAnswer.match(/-?\$\d[\d,]*(?:\.\d+)?/g) ?? [];
  if (tokens.length === 0) return { pass: false, detail: "no dollar figure to format" };
  const wellFormed = /^-?\$\d{1,3}(,\d{3})*\.\d{2}$/;
  const bad = tokens.filter((t) => !wellFormed.test(t));
  return bad.length === 0
    ? { pass: true, detail: `all ${tokens.length} amount(s) well-formed` }
    : { pass: false, detail: `malformed: ${bad.join(", ")}` };
}

/** The answer explains its method — references the SQL / query / analyst table it used. */
export function citedMethod(ctx: CheckContext): CheckOutcome {
  const hay = ctx.finalAnswer.toLowerCase();
  const cues = ["sql", "query", "queried", "select ", "analyst.", "spend_facts", "group by", "sum("];
  const hit = cues.find((c) => hay.includes(c));
  return hit
    ? { pass: true, detail: `references method ("${hit.trim()}")` }
    : { pass: false, detail: "answer does not cite the query/method used" };
}

/** Utility for trajectory-based checks that need the executed SQL of each query. */
export function executedQueries(trajectory: Trajectory): Array<{ index: number; sql: string; ok: boolean; status: string }> {
  return trajectory.steps
    .filter((s) => s.name === "execute_analyst_query")
    .map((s) => ({
      index: s.index,
      sql: typeof s.args?.sql === "string" ? s.args.sql : "",
      ok: s.ok,
      status: (s.resultSummary as { status?: string } | null)?.status ?? (s.ok ? "success" : "error"),
    }));
}
