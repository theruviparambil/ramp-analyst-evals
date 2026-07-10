/**
 * Binary LLM judge for answer faithfulness.
 *
 * A judge is only trustworthy once you've measured it. This is the SAME
 * discipline as the methodology hub, veriva-eval: there, a judge is validated
 * against human labels with inter-rater agreement (Cohen's / Fleiss' κ), never
 * raw accuracy (which lies on imbalanced label sets). Here the judge is
 * deliberately kept to the ADDITIONAL tier and to BINARY criteria: pass/fail
 * converges faster and is what you'd hand a κ-validation pass. The κ pipeline
 * itself lives in veriva-eval; this file is where its output would attach:
 * https://github.com/theruviparambil/veriva-eval
 *
 * Provider-agnostic: the judge takes an injected LLMClient, so tests drive it
 * with a scripted client and the live eval uses the real provider.
 */

import type { LLMClient } from "../agent/types.js";

const JUDGE_SYSTEM = `You are an impartial evaluator for a finance analyst agent. You are given a
QUESTION, the GROUND-TRUTH the agent should have reached, the agent's ANSWER,
and a single binary CRITERION. Decide whether the answer meets the criterion.

Return STRICT JSON and nothing else:
{"pass": true or false, "reason": "one or two sentences citing specifics"}

Rules:
- Judge only the stated criterion. Ignore style unless the criterion is about it.
- "pass" is true only if the answer clearly and correctly meets the criterion.
- If the answer states a materially wrong number, that is a fail.
- Be terse and specific in "reason".`;

export interface JudgeInput {
  question: string;
  /** A compact statement of the ground-truth / expected answer. */
  expected: string;
  answer: string;
  /** The single binary criterion to evaluate. */
  criterion: string;
}

export interface JudgeVerdict {
  pass: boolean | null;
  reason: string;
  error?: string;
}

export async function judgeBinary(input: JudgeInput, client: LLMClient): Promise<JudgeVerdict> {
  const user = [
    `QUESTION:\n${input.question}`,
    `GROUND-TRUTH:\n${input.expected}`,
    `AGENT ANSWER:\n${input.answer}`,
    `CRITERION:\n${input.criterion}`,
  ].join("\n\n");
  try {
    const turn = await client.chat(
      [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: user },
      ],
      [],
    );
    return parseVerdict(turn.text);
  } catch (err) {
    return { pass: null, reason: "", error: err instanceof Error ? err.message : String(err) };
  }
}

export function parseVerdict(text: string): JudgeVerdict {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return { pass: null, reason: "", error: `unparseable judge reply: ${text.slice(0, 120)}` };
  try {
    const obj = JSON.parse(match[0]) as { pass?: unknown; reason?: unknown };
    if (typeof obj.pass !== "boolean") return { pass: null, reason: "", error: "judge reply missing boolean 'pass'" };
    return { pass: obj.pass, reason: typeof obj.reason === "string" ? obj.reason : "" };
  } catch {
    return { pass: null, reason: "", error: `invalid judge JSON: ${match[0].slice(0, 120)}` };
  }
}
