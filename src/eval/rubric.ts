/**
 * The two-tier rubric scorer.
 *
 * Runs every criterion for a question and rolls the results up into a REQUIRED
 * pass (all required criteria pass) and an ADDITIONAL pass (all evaluated
 * additional criteria pass). Deterministic criteria run in-process; judge
 * criteria go to the injected LLM judge, or are skipped (pass = null) when no
 * judge is available, so the deterministic REQUIRED tier, and the CI gate that
 * rides on it, never depends on a model being reachable.
 */

import type { LLMClient, Trajectory } from "../agent/types.js";
import type { CheckContext } from "./checkers.js";
import { judgeBinary } from "./judge.js";
import type { Criterion, GoldenQuestion } from "./spec.js";

export interface CriterionResult {
  id: string;
  tier: "required" | "additional";
  nature: "invariant" | "observed";
  kind: "deterministic" | "judge";
  /** true/false, or null when a judge criterion was skipped (no judge available). */
  pass: boolean | null;
  detail: string;
}

export interface QuestionScore {
  id: string;
  question: string;
  expected: string;
  finalAnswer: string;
  results: CriterionResult[];
  requiredTotal: number;
  requiredPassed: number;
  requiredPass: boolean;
  additionalTotal: number;
  additionalEvaluated: number;
  additionalPassed: number;
  additionalPass: boolean;
  steps: number;
  hitStepCap: boolean;
  /** Infrastructure failure (timeout / abort / 5xx after retries): NOT a wrong
   * answer. Excluded from pass-rate denominators so slow models aren't penalized. */
  infraError?: boolean;
  errorMessage?: string;
}

export interface ScoreOptions {
  judge?: LLMClient;
}

export async function scoreQuestion(
  question: GoldenQuestion,
  finalAnswer: string,
  trajectory: Trajectory,
  opts: ScoreOptions = {},
): Promise<QuestionScore> {
  const ctx: CheckContext = { question: question.question, finalAnswer, trajectory };
  const results: CriterionResult[] = [];

  for (const c of question.criteria) {
    results.push(await evaluate(c, ctx, question, finalAnswer, opts.judge));
  }

  const required = results.filter((r) => r.tier === "required");
  const additional = results.filter((r) => r.tier === "additional");
  const requiredPassed = required.filter((r) => r.pass === true).length;
  const additionalEvaluated = additional.filter((r) => r.pass !== null);
  const additionalPassed = additionalEvaluated.filter((r) => r.pass === true).length;

  return {
    id: question.id,
    question: question.question,
    expected: question.expected,
    finalAnswer,
    results,
    requiredTotal: required.length,
    requiredPassed,
    requiredPass: requiredPassed === required.length,
    additionalTotal: additional.length,
    additionalEvaluated: additionalEvaluated.length,
    additionalPassed,
    additionalPass: additionalEvaluated.length > 0 ? additionalPassed === additionalEvaluated.length : true,
    steps: trajectory.steps.length,
    hitStepCap: trajectory.hitStepCap,
  };
}

async function evaluate(
  c: Criterion,
  ctx: CheckContext,
  question: GoldenQuestion,
  finalAnswer: string,
  judge?: LLMClient,
): Promise<CriterionResult> {
  if (c.kind === "deterministic" && c.run) {
    const outcome = c.run(ctx);
    return { id: c.id, tier: c.tier, nature: c.nature, kind: c.kind, pass: outcome.pass, detail: outcome.detail };
  }
  // Judge criterion.
  if (!judge) {
    return { id: c.id, tier: c.tier, nature: c.nature, kind: "judge", pass: null, detail: "skipped (no judge available)" };
  }
  const verdict = await judgeBinary(
    { question: question.question, expected: question.expected, answer: finalAnswer, criterion: c.judgeCriterion ?? c.description },
    judge,
  );
  if (verdict.pass === null) {
    return { id: c.id, tier: c.tier, nature: c.nature, kind: "judge", pass: null, detail: `judge error: ${verdict.error ?? "unknown"}` };
  }
  return { id: c.id, tier: c.tier, nature: c.nature, kind: "judge", pass: verdict.pass, detail: verdict.reason };
}

// ─── Aggregation across the whole set ─────────────────────────────────────────

export interface EvalSummary {
  /** Scored questions (infra errors excluded). */
  total: number;
  /** Questions dropped for an infra error (timeout/abort/5xx): reported, not scored. */
  errored: number;
  requiredTierPassRate: number;
  additionalTierPassRate: number;
  requiredTierPassed: number;
  additionalTierPassed: number;
  /** Per-criterion pass rate across questions (evaluated only). */
  criterionPassRates: Array<{ id: string; tier: string; nature: string; evaluated: number; passed: number; rate: number }>;
}

export function summarize(allScores: QuestionScore[]): EvalSummary {
  // Infra errors are not capability failures: drop them from the denominator.
  const errored = allScores.filter((s) => s.infraError).length;
  const scores = allScores.filter((s) => !s.infraError);
  const total = scores.length;
  const requiredTierPassed = scores.filter((s) => s.requiredPass).length;
  const additionalTierPassed = scores.filter((s) => s.additionalPass).length;

  const byCriterion = new Map<string, { tier: string; nature: string; evaluated: number; passed: number }>();
  for (const s of scores) {
    for (const r of s.results) {
      const rec = byCriterion.get(r.id) ?? { tier: r.tier, nature: r.nature, evaluated: 0, passed: 0 };
      if (r.pass !== null) {
        rec.evaluated += 1;
        if (r.pass) rec.passed += 1;
      }
      byCriterion.set(r.id, rec);
    }
  }
  const criterionPassRates = [...byCriterion.entries()].map(([id, rec]) => ({
    id,
    tier: rec.tier,
    nature: rec.nature,
    evaluated: rec.evaluated,
    passed: rec.passed,
    rate: rec.evaluated ? rec.passed / rec.evaluated : 1,
  }));

  return {
    total,
    errored,
    requiredTierPassRate: total ? requiredTierPassed / total : 1,
    additionalTierPassRate: total ? additionalTierPassed / total : 1,
    requiredTierPassed,
    additionalTierPassed,
    criterionPassRates,
  };
}

/** The CI gate: the REQUIRED tier must clear the bar. ADDITIONAL is headroom, never gated. */
export function passesGate(summary: EvalSummary, bar: number): boolean {
  return summary.requiredTierPassRate >= bar;
}
