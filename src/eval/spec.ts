/**
 * The rubric vocabulary.
 *
 * Two tiers, echoing Hebbia's framing: REQUIRED criteria are the agent's SLAs
 * (get the number right, stay read-only, ground it in a real tool call). A
 * required-only pass is acceptable. ADDITIONAL criteria are headroom: the
 * advanced behaviors (cite the SQL, catch the vendor variant, flag the anomaly,
 * format money correctly, take a clean reasoning path). Every criterion is
 * BINARY: pass or fail. Binary converges faster for judges and is what a κ
 * validation pass expects.
 */

import type { CheckContext, CheckOutcome } from "./checkers.js";

export type Tier = "required" | "additional";

/**
 * INVARIANT vs OBSERVED: an honesty distinction.
 *
 * Some checks CANNOT fail when the surface is behaving, because the tool surface
 * enforces them (the docs handshake is refused otherwise; write tools aren't
 * even exposed). Calling those "the agent did well" is misleading: they're
 * guarantees of the harness, not evidence about the model. We tag them
 * "invariant" and report them apart from "observed" behavior, which a lazy or
 * wrong agent genuinely can fail.
 */
export type Nature = "invariant" | "observed";

export interface Criterion {
  id: string;
  tier: Tier;
  nature: Nature;
  description: string;
  kind: "deterministic" | "judge";
  /** Deterministic evaluation over the answer + trajectory. */
  run?: (ctx: CheckContext) => CheckOutcome;
  /** A single binary criterion string handed to the LLM judge. */
  judgeCriterion?: string;
}

export interface GoldenQuestion {
  id: string;
  question: string;
  /** Compact expected-answer statement, shown to the judge and printed in reports. */
  expected: string;
  /** Instructions appended to the question telling the agent what JSON to emit. */
  answerInstructions: string;
  criteria: Criterion[];
}

/** The prompt actually sent to the agent: the question plus the answer-format contract. */
export function agentPrompt(q: GoldenQuestion): string {
  return `${q.question}\n\n${q.answerInstructions}`;
}

export function det(id: string, tier: Tier, description: string, run: (ctx: CheckContext) => CheckOutcome, nature: Nature = "observed"): Criterion {
  return { id, tier, nature, description, kind: "deterministic", run };
}

export function judged(id: string, tier: Tier, description: string, judgeCriterion: string, nature: Nature = "observed"): Criterion {
  return { id, tier, nature, description, kind: "judge", judgeCriterion };
}
