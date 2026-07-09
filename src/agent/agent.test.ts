/**
 * The agent loop, driven entirely offline by a scripted LLM client. The tool
 * calls still hit the real fixture backend + DuckDB, so these exercise the
 * genuine handshake and SQL paths — no network, no key.
 */
import { describe, expect, it } from "vitest";
import { runAgent } from "./agent.js";
import { ScriptedClient, toolTurn, finalTurn } from "./scripted.js";
import { createFixtureBackend } from "../ramp/backend.js";
import { readOnly } from "../eval/checkers.js";

const NET_SQL = "SELECT SUM(sf.amount) AS net FROM analyst.spend_facts sf";

describe("agent loop — happy path", () => {
  it("does catalog -> docs -> query -> answer and stays read-only", async () => {
    const client = new ScriptedClient([
      toolTurn("plan", [{ name: "get_analyst_catalog", args: { rationale: "discover tables" } }]),
      toolTurn("docs", [{ name: "get_analyst_spend_facts_domain_docs", args: { rationale: "grain + money" } }]),
      toolTurn("query", [{ name: "execute_analyst_query", args: { sql: NET_SQL, rationale: "net spend" } }]),
      finalTurn("Net Q2 spend was $188,925.60."),
    ]);
    const { trajectory, finalAnswer } = await runAgent("total spend?", { client, surface: createFixtureBackend() });

    expect(trajectory.steps.map((s) => s.name)).toEqual([
      "get_analyst_catalog",
      "get_analyst_spend_facts_domain_docs",
      "execute_analyst_query",
    ]);
    expect(trajectory.steps.every((s) => s.ok)).toBe(true);
    expect(finalAnswer).toContain("$188,925.60");
    expect(trajectory.hitStepCap).toBe(false);
    expect(readOnly({ question: "", finalAnswer, trajectory }).pass).toBe(true);
  });
});

describe("agent loop — self-correction", () => {
  it("recovers from a docs_required response by reading the docs and retrying", async () => {
    const client = new ScriptedClient([
      toolTurn("query too early", [{ name: "execute_analyst_query", args: { sql: NET_SQL, rationale: "net" } }]),
      toolTurn("read prereqs", [
        { name: "get_analyst_catalog", args: { rationale: "catalog" } },
        { name: "get_analyst_spend_facts_domain_docs", args: { rationale: "docs" } },
      ]),
      toolTurn("retry", [{ name: "execute_analyst_query", args: { sql: NET_SQL, rationale: "net retry" } }]),
      finalTurn("Net spend is $188,925.60."),
    ]);
    const { trajectory, finalAnswer } = await runAgent("total?", { client, surface: createFixtureBackend() });

    const queries = trajectory.steps.filter((s) => s.name === "execute_analyst_query");
    expect((queries[0]!.resultSummary as { status: string }).status).toBe("docs_required");
    expect((queries[1]!.resultSummary as { status: string }).status).toBe("success");
    expect(finalAnswer).toContain("$188,925.60");
  });

  it("recovers from a SQL error by fixing the query", async () => {
    const client = new ScriptedClient([
      toolTurn("prep", [{ name: "get_analyst_catalog", args: { rationale: "c" } }]),
      toolTurn("prep2", [{ name: "get_analyst_spend_facts_domain_docs", args: { rationale: "d" } }]),
      toolTurn("bad sql", [{ name: "execute_analyst_query", args: { sql: "SELECT bogus FROM analyst.spend_facts", rationale: "oops" } }]),
      toolTurn("fixed sql", [{ name: "execute_analyst_query", args: { sql: NET_SQL, rationale: "fixed" } }]),
      finalTurn("Net spend is $188,925.60."),
    ]);
    const { trajectory, finalAnswer } = await runAgent("total?", { client, surface: createFixtureBackend() });
    const queries = trajectory.steps.filter((s) => s.name === "execute_analyst_query");
    expect(queries[0]!.isError).toBe(true);
    expect(queries[1]!.ok).toBe(true);
    expect(finalAnswer).toContain("$188,925.60");
  });
});

describe("agent loop — read-only invariant", () => {
  it("records a write attempt and the invariant catches it", async () => {
    const client = new ScriptedClient([
      toolTurn("misbehave", [{ name: "update_merchant_restrictions", args: { rationale: "should not do this" } }]),
      finalTurn("done"),
    ]);
    const { trajectory, finalAnswer } = await runAgent("q", { client, surface: createFixtureBackend() });
    const writeStep = trajectory.steps.find((s) => s.name === "update_merchant_restrictions");
    expect(writeStep?.kind).toBe("write");
    expect(writeStep?.isError).toBe(true); // backend blocked it
    expect(readOnly({ question: "", finalAnswer, trajectory }).pass).toBe(false); // invariant fails
  });
});

describe("agent loop — budget", () => {
  it("stops at the tool-call budget instead of looping forever", async () => {
    const client = new ScriptedClient(() => toolTurn("again", [{ name: "get_analyst_catalog", args: { rationale: "loop" } }]));
    const { trajectory } = await runAgent("q", { client, surface: createFixtureBackend(), maxToolCalls: 3 });
    expect(trajectory.hitStepCap).toBe(true);
    expect(trajectory.steps.length).toBeLessThanOrEqual(3);
  });
});
