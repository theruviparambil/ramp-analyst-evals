/**
 * End-to-end (offline): drive real golden questions through the real agent loop
 * and DuckDB with a scripted model, then score with the real rubric.
 *
 * Two failures this guards against:
 *   - q05 vendor-variant trap: summing one spelling gives the wrong total.
 *   - q04 duplicate FALSE-NEGATIVE: the substring era passed "no duplicates,
 *     $8,400 is the normal monthly charge" because "$8,400" appears. Structured
 *     grading must now FAIL it, because duplicates:[] misses the planted pair.
 */
import { describe, expect, it } from "vitest";
import { runAgent } from "../agent/agent.js";
import { ScriptedClient, toolTurn, finalTurn } from "../agent/scripted.js";
import { createFixtureBackend } from "../ramp/backend.js";
import { GOLDEN } from "./golden.js";
import { agentPrompt } from "./spec.js";
import { scoreQuestion } from "./rubric.js";

const byId = (id: string) => GOLDEN.find((q) => q.id === id)!;

const catalog = () => toolTurn("catalog", [{ name: "get_analyst_catalog", args: { rationale: "discover" } }]);
const spendDocs = () => toolTurn("spend docs", [{ name: "get_analyst_spend_facts_domain_docs", args: { rationale: "grain" } }]);

describe("golden set structure", () => {
  it("has 12 questions, each with answer instructions and both tiers/natures", () => {
    expect(GOLDEN).toHaveLength(12);
    for (const q of GOLDEN) {
      expect(q.answerInstructions).toMatch(/json/i);
      expect(q.criteria.some((c) => c.tier === "required")).toBe(true);
      expect(q.criteria.some((c) => c.tier === "additional")).toBe(true);
      expect(q.criteria.some((c) => c.nature === "invariant")).toBe(true);
      expect(q.criteria.some((c) => c.nature === "observed")).toBe(true);
    }
  });
});

describe("Q05 vendor variant: end to end", () => {
  const q5 = byId("q05_vendor_variant");
  const COMBINED = `SELECT SUM(sf.amount) AS total FROM analyst.spend_facts sf
    JOIN analyst.merchant_dim md ON sf.merchant_uuid = md.merchant_uuid
    WHERE md.normalized_merchant_name = 'Delta Air Lines'`;
  const ONE = "SELECT SUM(sf.amount) AS total FROM analyst.spend_facts sf WHERE sf.merchant_name = 'Delta Air Lines'";

  it("summing BOTH spellings passes required", async () => {
    const client = new ScriptedClient([
      catalog(),
      spendDocs(),
      toolTurn("merchant docs", [{ name: "get_analyst_table_domain_docs", args: { qualified_name: "analyst.merchant_dim", rationale: "normalized" } }]),
      toolTurn("query", [{ name: "execute_analyst_query", args: { sql: COMBINED, rationale: "combine variants" } }]),
      finalTurn('Combined Delta spend was $4,387.00 across two spellings (Delta Air Lines and Delta Airlines), from a SUM over analyst.spend_facts joined to merchant_dim.\n```json\n{"combined_spend_usd": 4387.00, "variants": ["Delta Air Lines", "Delta Airlines"]}\n```'),
    ]);
    const { trajectory, finalAnswer } = await runAgent(agentPrompt(q5), { client, surface: createFixtureBackend() });
    const score = await scoreQuestion(q5, finalAnswer, trajectory, {});
    expect(score.requiredPass).toBe(true);
    expect(score.results.find((r) => r.id === "add.variants")?.pass).toBe(true);
  });

  it("summing ONE spelling fails required (wrong total)", async () => {
    const client = new ScriptedClient([
      catalog(),
      spendDocs(),
      toolTurn("query", [{ name: "execute_analyst_query", args: { sql: ONE, rationale: "delta" } }]),
      finalTurn('We spent $2,184.50 with Delta in Q2.\n```json\n{"combined_spend_usd": 2184.50, "variants": ["Delta Air Lines"]}\n```'),
    ]);
    const { trajectory, finalAnswer } = await runAgent(agentPrompt(q5), { client, surface: createFixtureBackend() });
    const score = await scoreQuestion(q5, finalAnswer, trajectory, {});
    expect(score.requiredPass).toBe(false);
    expect(score.results.find((r) => r.id === "req.value")?.pass).toBe(false);
  });
});

describe("Q04 duplicate: structured grading closes the substring false-negative", () => {
  const q4 = byId("q04_duplicate_charge");
  // A same-day GROUP BY finds nothing (the real charges are 3 days apart).
  const SAME_DAY = "SELECT sf.merchant_name, sf.amount, sf.transaction_date, COUNT(*) AS n FROM analyst.spend_facts sf GROUP BY sf.merchant_name, sf.amount, sf.transaction_date HAVING COUNT(*) > 1";
  const PROXIMITY = "SELECT sf.merchant_name, sf.amount FROM analyst.spend_facts sf WHERE sf.merchant_name = 'Datadog' AND sf.amount = 8400.00";

  it("the confidently-WRONG 'no duplicates, $8,400 is normal' now FAILS required", async () => {
    const client = new ScriptedClient([
      catalog(),
      spendDocs(),
      toolTurn("same-day scan", [{ name: "execute_analyst_query", args: { sql: SAME_DAY, rationale: "find same-day dupes" } }]),
      finalTurn('No duplicate charges. The Datadog $8,400.00 charge is the normal recurring monthly bill.\n```json\n{"duplicates": []}\n```'),
    ]);
    const { trajectory, finalAnswer } = await runAgent(agentPrompt(q4), { client, surface: createFixtureBackend() });
    const score = await scoreQuestion(q4, finalAnswer, trajectory, {});
    // Substring era would have passed this ("Datadog" + "$8,400" both present).
    expect(finalAnswer).toContain("$8,400.00");
    expect(score.requiredPass).toBe(false);
    expect(score.results.find((r) => r.id === "req.value")?.pass).toBe(false);
  });

  it("correctly flagging the Datadog pair passes required", async () => {
    const client = new ScriptedClient([
      catalog(),
      spendDocs(),
      toolTurn("proximity scan", [{ name: "execute_analyst_query", args: { sql: PROXIMITY, rationale: "check datadog repeats" } }]),
      finalTurn('Datadog $8,400.00 was charged twice within days (2026-05-12 and 2026-05-15), a likely double-charge of the monthly bill.\n```json\n{"duplicates": [{"merchant": "Datadog", "amount_usd": 8400.00, "dates": ["2026-05-12", "2026-05-15"]}]}\n```'),
    ]);
    const { trajectory, finalAnswer } = await runAgent(agentPrompt(q4), { client, surface: createFixtureBackend() });
    const score = await scoreQuestion(q4, finalAnswer, trajectory, {});
    expect(score.requiredPass).toBe(true);
    expect(score.results.find((r) => r.id === "add.dates")?.pass).toBe(true);
    expect(score.results.find((r) => r.id === "add.exact")?.pass).toBe(true);
  });
});
