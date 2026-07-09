import { describe, expect, it } from "vitest";
import { passesGate, summarize, type QuestionScore } from "./rubric.js";

function qs(id: string, requiredPass: boolean, additionalPass = true): QuestionScore {
  return {
    id, question: "", expected: "", finalAnswer: "",
    results: [], requiredTotal: 3, requiredPassed: requiredPass ? 3 : 2, requiredPass,
    additionalTotal: 4, additionalEvaluated: 4, additionalPassed: additionalPass ? 4 : 2, additionalPass,
    steps: 3, hitStepCap: false,
  };
}

describe("CI gate", () => {
  it("passes when the REQUIRED tier clears the bar", () => {
    const summary = summarize([qs("a", true), qs("b", true), qs("c", true)]);
    expect(summary.requiredTierPassRate).toBe(1);
    expect(passesGate(summary, 0.9)).toBe(true);
  });

  it("fails when the REQUIRED tier drops below the bar", () => {
    const summary = summarize([qs("a", true), qs("b", true), qs("c", false), qs("d", false)]); // 50%
    expect(summary.requiredTierPassRate).toBe(0.5);
    expect(passesGate(summary, 0.9)).toBe(false);
  });

  it("does NOT gate on the ADDITIONAL tier (headroom, not a bar)", () => {
    // Every required passes but additional is weak; the gate still passes.
    const summary = summarize([qs("a", true, false), qs("b", true, false)]);
    expect(summary.requiredTierPassRate).toBe(1);
    expect(summary.additionalTierPassRate).toBe(0);
    expect(passesGate(summary, 1.0)).toBe(true);
  });
});
