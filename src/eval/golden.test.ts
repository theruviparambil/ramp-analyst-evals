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
  });
});

/**
 * Regression pins for grading holes found by probing the rubric with answers a
 * confidently-wrong agent would actually produce. Each of these PASSED required
 * before 2026-08-21. They are the receipts for the claim that structured
 * grading discriminates, so they are asserted directly on the criteria rather
 * than through a scripted agent run.
 */
describe("grading holes: answers that must not score as correct", () => {
  const ctx = (q: (typeof GOLDEN)[number], finalAnswer: string) => ({ question: q.question, finalAnswer, trajectory: undefined as never });
  const reqValue = (q: (typeof GOLDEN)[number], id = "req.value") => {
    const c = q.criteria.find((x) => x.id === id);
    if (!c?.run) throw new Error(`${q.id} has no runnable ${id}`);
    return c.run;
  };
  const block = (o: unknown) => "Analysis complete.\n\n```json\n" + JSON.stringify(o) + "\n```";

  const q4 = byId("q04_duplicate_charge");
  const q6 = byId("q06_out_of_policy");
  const q2 = byId("q02_top_vendor");
  const q1 = byId("q01_total_net_spend");
  const q7 = byId("q07_mom_spike");

  it("q04: prose denies the duplicate while the JSON lists the LEGIT monthly charges", () => {
    // Q2 contains four Datadog charges of exactly $8,400 (04-03, 05-12, 05-15,
    // 06-04). A merchant+amount check cannot tell the double-charge from the
    // recurring bill, so this answer used to satisfy req.value while asserting
    // the opposite conclusion.
    const answer =
      "These are the normal monthly observability bills, all $8,400. There are NO duplicate charges in Q2." +
      block({ duplicates: [{ merchant: "Datadog", amount_usd: 8400, dates: ["2026-04-03"] }, { merchant: "Datadog", amount_usd: 8400, dates: ["2026-06-04"] }] });
    expect(reqValue(q4)(ctx(q4, answer)).pass).toBe(false);
  });

  it("q04: the real duplicate reported alongside two fabricated ones", () => {
    const answer = block({ duplicates: [
      { merchant: "Datadog", amount_usd: 8400, dates: ["2026-05-12", "2026-05-15"] },
      { merchant: "Notion", amount_usd: 1200, dates: ["2026-05-02", "2026-05-09"] },
      { merchant: "Nobu", amount_usd: 6750, dates: ["2026-06-18", "2026-06-19"] },
    ] });
    expect(reqValue(q4)(ctx(q4, answer)).pass).toBe(false);
  });

  it("q04: the right pair smeared across all four monthly charges", () => {
    const answer = block({ duplicates: [{ merchant: "Datadog", amount_usd: 8400, dates: ["2026-04-03", "2026-05-12", "2026-05-15", "2026-06-04"] }] });
    expect(reqValue(q4)(ctx(q4, answer)).pass).toBe(false);
  });

  it("q04: a REAL but immaterial coincidental pair is neither credited nor penalized", () => {
    // Q2 genuinely contains two identical $35.93 Uber charges seven days apart.
    // gpt-5.5 reported it alongside the Datadog duplicate on 2026-08-19. That is
    // a correct observation about the data, so it must not fail the question.
    const answer = block({ duplicates: [
      { merchant: "Datadog", amount_usd: 8400, dates: ["2026-05-12", "2026-05-15"] },
      { merchant: "Uber", amount_usd: 35.93, dates: ["2026-06-10", "2026-06-17"] },
    ] });
    expect(reqValue(q4)(ctx(q4, answer)).pass).toBe(true);
  });

  it("q04: the materiality floor does not forgive a fabricated item above it", () => {
    const answer = block({ duplicates: [
      { merchant: "Datadog", amount_usd: 8400, dates: ["2026-05-12", "2026-05-15"] },
      { merchant: "Notion", amount_usd: 1200, dates: ["2026-05-02", "2026-05-09"] },
    ] });
    expect(reqValue(q4)(ctx(q4, answer)).pass).toBe(false);
  });

  it("q04: an unparseable amount does not slip under the materiality floor", () => {
    const answer = block({ duplicates: [
      { merchant: "Datadog", amount_usd: 8400, dates: ["2026-05-12", "2026-05-15"] },
      { merchant: "Ghost Vendor", amount_usd: "unknown", dates: ["2026-05-02", "2026-05-09"] },
    ] });
    expect(reqValue(q4)(ctx(q4, answer)).pass).toBe(false);
  });

  it("q04: cosmetic date and merchant formatting still passes", () => {
    const answer = block({ duplicates: [{ merchant: "datadog", amount_usd: 8400, dates: ["2026-05-15T00:00:00Z", "2026-05-12"] }] });
    expect(reqValue(q4)(ctx(q4, answer)).pass).toBe(true);
  });

  it("q06: the real violation reported alongside two fabricated ones", () => {
    // Inventing policy violations against named employees is a worse failure
    // than missing one, so precision is required rather than a bonus.
    const answer = block({ out_of_policy: [
      { merchant: "Nobu", amount_usd: 6750 },
      { merchant: "Delta Air Lines", amount_usd: 2100 },
      { merchant: "Google Ads", amount_usd: 42500 },
    ] });
    expect(reqValue(q6)(ctx(q6, answer)).pass).toBe(false);
  });

  it("q02: a one-letter vendor name does not score as the right vendor", () => {
    // "a" is a substring of every merchant in the fixture; bidirectional
    // substring matching accepted it against a correct dollar figure.
    expect(reqValue(q2)(ctx(q2, block({ top_vendor: { name: "a", spend_usd: 42500 } }))).pass).toBe(false);
  });

  it("q07: a one-letter category does not score as the right category", () => {
    expect(reqValue(q7, "req.category")(ctx(q7, block({ spike: { category: "a", to_usd: 50000 } }))).pass).toBe(false);
  });

  it("q02: a vendor total off by $21 fails", () => {
    expect(reqValue(q2)(ctx(q2, block({ top_vendor: { name: "Google Ads", spend_usd: 42521 } }))).pass).toBe(false);
  });

  it("q01: net spend off by $94 fails (the old 0.05% tolerance allowed +/-$94.46)", () => {
    expect(reqValue(q1)(ctx(q1, block({ net_spend_usd: 189019.6 }))).pass).toBe(false);
  });

  it("q10: a refund total reported with either sign passes", () => {
    // gpt-5.1 and claude-4.6 both answered -501.50 and were graded wrong,
    // because the answer contract never stated a sign convention.
    const q10 = byId("q10_refunds");
    const c = q10.criteria.find((x) => x.id === "add.refund_total");
    if (!c?.run) throw new Error("q10 has no runnable add.refund_total");
    for (const v of [-501.5, 501.5]) {
      expect(c.run(ctx(q10, block({ refunds_usd: v }))).pass).toBe(true);
    }
    // A wrong magnitude is still wrong.
    expect(c.run(ctx(q10, block({ refunds_usd: -601.5 }))).pass).toBe(false);
  });

  it("q02: cosmetic vendor formatting and known aliases still pass", () => {
    expect(reqValue(q2)(ctx(q2, block({ top_vendor: { name: "Google Ads (Advertising)", spend_usd: 42500 } }))).pass).toBe(true);
    expect(reqValue(q2)(ctx(q2, block({ top_vendor: { name: "  google   adwords ", spend_usd: 42500 } }))).pass).toBe(true);
  });
});
