import { describe, expect, it } from "vitest";
import type { Trajectory } from "../agent/types.js";
import { ScriptedClient, finalTurn } from "../agent/scripted.js";
import { answerContainsAmount } from "./checkers.js";
import { det, judged, type GoldenQuestion } from "./spec.js";
import { scoreQuestion, summarize } from "./rubric.js";

const emptyTraj: Trajectory = { question: "", steps: [], notes: [], finalAnswer: "", hitStepCap: false, modelLabel: "x" };

const question: GoldenQuestion = {
  id: "t",
  question: "Q",
  expected: "E",
  answerInstructions: "emit json",
  criteria: [
    det("req.always", "required", "always true", () => ({ pass: true, detail: "" })),
    det("req.value", "required", "answer states $1.00", (c) => answerContainsAmount(c, 100)),
    det("add.always", "additional", "always true", () => ({ pass: true, detail: "" })),
    judged("add.faithful", "additional", "faithful", "the answer is faithful"),
  ],
};

const passJudge = () => new ScriptedClient(() => finalTurn('{"pass": true, "reason": "correct"}'));
const failJudge = () => new ScriptedClient(() => finalTurn('{"pass": false, "reason": "wrong number"}'));

describe("scoreQuestion", () => {
  it("required tier passes when every required criterion passes; judge adds to additional", async () => {
    const s = await scoreQuestion(question, "The total is $1.00.", emptyTraj, { judge: passJudge() });
    expect(s.requiredPass).toBe(true);
    expect(s.requiredPassed).toBe(2);
    expect(s.additionalPass).toBe(true);
    expect(s.results.find((r) => r.id === "add.faithful")?.pass).toBe(true);
  });

  it("a wrong number fails the required tier even if the judge is lenient", async () => {
    const s = await scoreQuestion(question, "The total is $2.00.", emptyTraj, { judge: passJudge() });
    expect(s.requiredPass).toBe(false);
  });

  it("a failing judge fails only the ADDITIONAL tier", async () => {
    const s = await scoreQuestion(question, "The total is $1.00.", emptyTraj, { judge: failJudge() });
    expect(s.requiredPass).toBe(true);
    expect(s.additionalPass).toBe(false);
  });

  it("skips judge criteria (pass=null) when no judge is available: required tier unaffected", async () => {
    const s = await scoreQuestion(question, "The total is $1.00.", emptyTraj, {});
    expect(s.requiredPass).toBe(true);
    const judgeResult = s.results.find((r) => r.id === "add.faithful");
    expect(judgeResult?.pass).toBeNull();
    // additional pass computed over evaluated (non-null) criteria only
    expect(s.additionalEvaluated).toBe(1);
    expect(s.additionalPass).toBe(true);
  });
});

describe("summarize", () => {
  it("reports required and additional tier pass rates separately", async () => {
    const good = await scoreQuestion(question, "$1.00", emptyTraj, { judge: passJudge() });
    const bad = await scoreQuestion(question, "$2.00", emptyTraj, { judge: passJudge() });
    const sum = summarize([good, bad]);
    expect(sum.total).toBe(2);
    expect(sum.requiredTierPassRate).toBe(0.5);
    expect(sum.additionalTierPassRate).toBe(1); // additional criteria pass in both
    const value = sum.criterionPassRates.find((c) => c.id === "req.value");
    expect(value).toMatchObject({ evaluated: 2, passed: 1 });
  });

  it("excludes infra errors from the denominator (infra failure != capability failure)", async () => {
    const good = await scoreQuestion(question, "$1.00", emptyTraj, { judge: passJudge() });
    const infra = {
      id: "x", question: "", expected: "", finalAnswer: "INFRA_ERROR: timeout",
      results: [], requiredTotal: 0, requiredPassed: 0, requiredPass: false,
      additionalTotal: 0, additionalEvaluated: 0, additionalPassed: 0, additionalPass: false,
      steps: 0, hitStepCap: false, infraError: true, errorMessage: "timeout",
    };
    const sum = summarize([good, infra]);
    expect(sum.total).toBe(1); // the errored sample is dropped, not counted as a fail
    expect(sum.errored).toBe(1);
    expect(sum.requiredTierPassRate).toBe(1); // 1/1 valid, not 1/2
  });
});
