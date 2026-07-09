/**
 * End-to-end (offline): drive a real golden question through the real agent loop
 * and DuckDB with a scripted model, then score it with the real rubric. Uses Q5
 * (the vendor-variant trap): the agent that sums both spellings passes the
 * REQUIRED tier; the agent that matches one spelling gets a wrong number and
 * fails it — exactly the failure the eval exists to catch.
 */
import { describe, expect, it } from "vitest";
import { runAgent } from "../agent/agent.js";
import { ScriptedClient, toolTurn, finalTurn } from "../agent/scripted.js";
import { createFixtureBackend } from "../ramp/backend.js";
import { GOLDEN } from "./golden.js";
import { scoreQuestion } from "./rubric.js";

const q5 = GOLDEN.find((q) => q.id === "q05_vendor_variant")!;

const COMBINED_SQL = `SELECT SUM(sf.amount) AS total FROM analyst.spend_facts sf
  JOIN analyst.merchant_dim md ON sf.merchant_uuid = md.merchant_uuid
  WHERE md.normalized_merchant_name = 'Delta Air Lines'`;
const ONE_SPELLING_SQL = "SELECT SUM(sf.amount) AS total FROM analyst.spend_facts sf WHERE sf.merchant_name = 'Delta Air Lines'";

describe("golden set structure", () => {
  it("has 12 questions, each with at least one required and one additional criterion", () => {
    expect(GOLDEN).toHaveLength(12);
    for (const q of GOLDEN) {
      expect(q.criteria.some((c) => c.tier === "required")).toBe(true);
      expect(q.criteria.some((c) => c.tier === "additional")).toBe(true);
      expect(q.id && q.question && q.expected).toBeTruthy();
    }
  });
});

describe("Q5 vendor variant — end to end", () => {
  it("an agent that sums BOTH spellings passes the required tier", async () => {
    const client = new ScriptedClient([
      toolTurn("catalog", [{ name: "get_analyst_catalog", args: { rationale: "discover" } }]),
      toolTurn("spend docs", [{ name: "get_analyst_spend_facts_domain_docs", args: { rationale: "grain" } }]),
      toolTurn("merchant docs", [{ name: "get_analyst_table_domain_docs", args: { qualified_name: "analyst.merchant_dim", rationale: "normalized name" } }]),
      toolTurn("query", [{ name: "execute_analyst_query", args: { sql: COMBINED_SQL, rationale: "combine variants" } }]),
      finalTurn("Combined Delta spend in Q2 was $4,387.00. Note this is split across two un-normalized spellings — Delta Air Lines and Delta Airlines — that are the same airline; the figure comes from a SUM(amount) over analyst.spend_facts joined to merchant_dim on the normalized vendor name."),
    ]);
    const { trajectory, finalAnswer } = await runAgent(q5.question, { client, surface: createFixtureBackend() });
    const score = await scoreQuestion(q5, finalAnswer, trajectory, {});
    expect(score.requiredPass).toBe(true);
    // it also nails the variant + method additional criteria
    expect(score.results.find((r) => r.id === "add.variants")?.pass).toBe(true);
  });

  it("an agent that matches ONE spelling gets the wrong total and fails the required tier", async () => {
    const client = new ScriptedClient([
      toolTurn("catalog", [{ name: "get_analyst_catalog", args: { rationale: "discover" } }]),
      toolTurn("spend docs", [{ name: "get_analyst_spend_facts_domain_docs", args: { rationale: "grain" } }]),
      toolTurn("query", [{ name: "execute_analyst_query", args: { sql: ONE_SPELLING_SQL, rationale: "delta spend" } }]),
      finalTurn("We spent $2,184.50 with Delta in Q2, from a SUM over analyst.spend_facts."),
    ]);
    const { trajectory, finalAnswer } = await runAgent(q5.question, { client, surface: createFixtureBackend() });
    const score = await scoreQuestion(q5, finalAnswer, trajectory, {});
    expect(score.requiredPass).toBe(false); // the value criterion catches the under-count
    expect(score.results.find((r) => r.id === "req.value")?.pass).toBe(false);
  });
});
