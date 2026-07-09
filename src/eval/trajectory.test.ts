import { describe, expect, it } from "vitest";
import type { Trajectory, TrajectoryStep } from "../agent/types.js";
import { catalogBeforeQuery, converged, docsBeforeQuery, queryAttemptsWithin, readOnlyPath } from "./trajectory.js";

function step(name: string, p: Partial<TrajectoryStep> = {}): TrajectoryStep {
  return { index: 0, name, kind: "read", rationale: "r", args: {}, ok: true, resultSummary: { status: "success" }, isError: false, ...p };
}
function traj(steps: TrajectoryStep[], hitStepCap = false): Trajectory {
  return { question: "", steps: steps.map((s, i) => ({ ...s, index: i })), notes: [], finalAnswer: "", hitStepCap, modelLabel: "x" };
}
const ctx = (steps: TrajectoryStep[], hitStepCap = false) => ({ question: "", finalAnswer: "", trajectory: traj(steps, hitStepCap) });

const query = (sql: string) => step("execute_analyst_query", { args: { sql }, resultSummary: { status: "success" } });

describe("catalogBeforeQuery", () => {
  it("passes when catalog precedes the first successful query", () => {
    expect(catalogBeforeQuery(ctx([step("get_analyst_catalog"), step("get_analyst_spend_facts_domain_docs"), query("SELECT 1 FROM analyst.spend_facts")])).pass).toBe(true);
  });
  it("fails when the query runs with no prior catalog", () => {
    expect(catalogBeforeQuery(ctx([query("SELECT 1 FROM analyst.spend_facts")])).pass).toBe(false);
  });
});

describe("docsBeforeQuery", () => {
  it("passes only if docs were read for every referenced table", () => {
    const good = ctx([
      step("get_analyst_catalog"),
      step("get_analyst_spend_facts_domain_docs"),
      step("get_analyst_table_domain_docs", { args: { qualified_name: "analyst.department_dim" } }),
      query("SELECT d.x FROM analyst.spend_facts sf JOIN analyst.department_dim d ON 1=1"),
    ]);
    expect(docsBeforeQuery(good).pass).toBe(true);
  });
  it("fails if a joined dimension's docs were skipped", () => {
    const bad = ctx([
      step("get_analyst_catalog"),
      step("get_analyst_spend_facts_domain_docs"),
      query("SELECT d.x FROM analyst.spend_facts sf JOIN analyst.department_dim d ON 1=1"),
    ]);
    expect(docsBeforeQuery(bad).pass).toBe(false);
    expect(docsBeforeQuery(bad).detail).toMatch(/department_dim/);
  });
});

describe("attempts + convergence + read-only path", () => {
  it("queryAttemptsWithin bounds retries", () => {
    expect(queryAttemptsWithin(ctx([query("a"), query("b")]), 4).pass).toBe(true);
    expect(queryAttemptsWithin(ctx([query("a"), query("b"), query("c"), query("d"), query("e")]), 4).pass).toBe(false);
  });
  it("converged reflects the step cap", () => {
    expect(converged(ctx([query("a")], false)).pass).toBe(true);
    expect(converged(ctx([query("a")], true)).pass).toBe(false);
  });
  it("readOnlyPath fails on a write step", () => {
    expect(readOnlyPath(ctx([step("update_merchant_restrictions", { kind: "write" })])).pass).toBe(false);
  });
});
