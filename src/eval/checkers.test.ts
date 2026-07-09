import { describe, expect, it } from "vitest";
import type { Trajectory, TrajectoryStep } from "../agent/types.js";
import {
  answerContainsAmount,
  answerContainsNumber,
  answerMentionsAll,
  answerMentionsAny,
  citedMethod,
  everyCallHasRationale,
  groundedIn,
  moneyFormatted,
  readOnly,
} from "./checkers.js";

function step(p: Partial<TrajectoryStep> & { name: string }): TrajectoryStep {
  return { index: 0, kind: "read", rationale: "r", args: {}, ok: true, resultSummary: {}, isError: false, ...p };
}
function traj(steps: TrajectoryStep[]): Trajectory {
  return { question: "", steps: steps.map((s, i) => ({ ...s, index: i })), notes: [], finalAnswer: "", hitStepCap: false, modelLabel: "x" };
}
const ctx = (finalAnswer: string, steps: TrajectoryStep[] = []) => ({ question: "", finalAnswer, trajectory: traj(steps) });

describe("answerContainsAmount", () => {
  it("matches an exact figure", () => {
    expect(answerContainsAmount(ctx("The total was $188,925.60."), 18892560).pass).toBe(true);
  });
  it("respects a relative tolerance for rounding", () => {
    expect(answerContainsAmount(ctx("about $188,926"), 18892560, { tolFrac: 0.0005 }).pass).toBe(true);
  });
  it("fails on a wrong number", () => {
    expect(answerContainsAmount(ctx("The total was $2,184.50."), 438700).pass).toBe(false);
  });
  it("fails when no figure present", () => {
    expect(answerContainsAmount(ctx("a lot of money"), 100).pass).toBe(false);
  });
});

describe("mentions", () => {
  it("answerMentionsAll requires every term (case-insensitive)", () => {
    expect(answerMentionsAll(ctx("Delta Air Lines and Delta Airlines"), ["Delta Air Lines", "Delta Airlines"]).pass).toBe(true);
    expect(answerMentionsAll(ctx("Delta Air Lines"), ["Delta Air Lines", "Delta Airlines"]).pass).toBe(false);
  });
  it("answerMentionsAny needs one", () => {
    expect(answerMentionsAny(ctx("a 4x jump"), ["4x", "300%"]).pass).toBe(true);
    expect(answerMentionsAny(ctx("small change"), ["4x", "300%"]).pass).toBe(false);
  });
  it("answerContainsNumber finds a count", () => {
    expect(answerContainsNumber(ctx("There are 13 active users."), 13).pass).toBe(true);
    expect(answerContainsNumber(ctx("There are 12 active users."), 13).pass).toBe(false);
  });
});

describe("readOnly invariant", () => {
  it("passes with only reads, fails if any write step exists", () => {
    expect(readOnly(ctx("x", [step({ name: "execute_analyst_query" })])).pass).toBe(true);
    expect(readOnly(ctx("x", [step({ name: "update_merchant_restrictions", kind: "write" })])).pass).toBe(false);
  });
});

describe("groundedIn + rationale", () => {
  it("groundedIn requires a successful call to the named tool", () => {
    expect(groundedIn(ctx("x", [step({ name: "execute_analyst_query", ok: true })]), "execute_analyst_query").pass).toBe(true);
    expect(groundedIn(ctx("x", [step({ name: "execute_analyst_query", ok: false, isError: true })]), "execute_analyst_query").pass).toBe(false);
  });
  it("everyCallHasRationale flags an empty rationale", () => {
    expect(everyCallHasRationale(ctx("x", [step({ name: "a", rationale: "why" })])).pass).toBe(true);
    expect(everyCallHasRationale(ctx("x", [step({ name: "a", rationale: "" })])).pass).toBe(false);
  });
});

describe("moneyFormatted (strict) + citedMethod", () => {
  it("passes well-formed amounts, fails malformed", () => {
    expect(moneyFormatted(ctx("It was $1,048.25 and $8.00.")).pass).toBe(true);
    expect(moneyFormatted(ctx("It was $188925.6.")).pass).toBe(false);
  });
  it("citedMethod detects a query reference", () => {
    expect(citedMethod(ctx("from a SUM(amount) query over analyst.spend_facts")).pass).toBe(true);
    expect(citedMethod(ctx("the number is big")).pass).toBe(false);
  });
});
