/**
 * The rubric vocabulary.
 *
 * Two tiers, echoing Hebbia's framing: REQUIRED criteria are the agent's SLAs
 * (get the number right, stay read-only, ground it in a real tool call). A
 * required-only pass is acceptable. ADDITIONAL criteria are headroom — the
 * advanced behaviors (cite the SQL, catch the vendor variant, flag the anomaly,
 * format money correctly, take a clean reasoning path). Every criterion is
 * BINARY: pass or fail. Binary converges faster for judges and is what a κ
 * validation pass expects.
 */

import type { CheckContext, CheckOutcome } from "./checkers.js";

export type Tier = "required" | "additional";

export interface Criterion {
  id: string;
  tier: Tier;
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
  /** Compact expected-answer statement — shown to the judge and printed in reports. */
  expected: string;
  criteria: Criterion[];
}

export function det(id: string, tier: Tier, description: string, run: (ctx: CheckContext) => CheckOutcome): Criterion {
  return { id, tier, description, kind: "deterministic", run };
}

export function judged(id: string, tier: Tier, description: string, judgeCriterion: string): Criterion {
  return { id, tier, description, kind: "judge", judgeCriterion };
}
