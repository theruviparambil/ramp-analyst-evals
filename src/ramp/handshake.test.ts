/**
 * Tool-surface behavior: the docs_required handshake, SQL error surfacing,
 * argument validation, the read-only write block, and the wire money formats.
 */
import { describe, expect, it } from "vitest";
import { createFixtureBackend } from "./backend.js";
import { referencedTables } from "./analyst-db.js";

const netSql = "SELECT SUM(sf.amount) AS net FROM analyst.spend_facts sf";

describe("referencedTables", () => {
  it("extracts qualified analyst tables from SQL", () => {
    expect(referencedTables("SELECT * FROM analyst.spend_facts sf JOIN analyst.user_dim u ON 1=1").sort()).toEqual([
      "analyst.spend_facts",
      "analyst.user_dim",
    ]);
  });
});

describe("docs_required handshake", () => {
  it("refuses a query before the catalog + docs are read, then succeeds after", async () => {
    const b = createFixtureBackend();

    const r1 = (await b.call("execute_analyst_query", { sql: netSql, rationale: "net" })).data as Record<string, unknown>;
    expect(r1.status).toBe("docs_required");
    expect(r1.missing_catalog).toBe(true);
    expect((r1.required_tool_calls as unknown[]).length).toBeGreaterThanOrEqual(2);

    await b.call("get_analyst_catalog", { rationale: "discover" });
    const r2 = (await b.call("execute_analyst_query", { sql: netSql, rationale: "net" })).data as Record<string, unknown>;
    expect(r2.status).toBe("docs_required");
    expect(r2.missing_catalog).toBe(false);
    expect(r2.missing_doc_tables).toEqual(["analyst.spend_facts"]);

    await b.call("get_analyst_spend_facts_domain_docs", { rationale: "grain" });
    const r3 = (await b.call("execute_analyst_query", { sql: netSql, rationale: "net" })).data as Record<string, unknown>;
    expect(r3.status).toBe("success");
    expect((r3.rows as Array<{ net: number }>)[0]!.net).toBeCloseTo(188925.6, 2);
  });

  it("requires docs for EACH referenced table (joins included)", async () => {
    const b = createFixtureBackend();
    await b.call("get_analyst_catalog", { rationale: "d" });
    await b.call("get_analyst_spend_facts_domain_docs", { rationale: "d" });
    const joinSql = "SELECT d.department_name, SUM(sf.amount) t FROM analyst.spend_facts sf JOIN analyst.department_dim d ON sf.department_uuid=d.department_uuid GROUP BY d.department_name";
    const r = (await b.call("execute_analyst_query", { sql: joinSql, rationale: "by dept" })).data as Record<string, unknown>;
    expect(r.status).toBe("docs_required");
    expect(r.missing_doc_tables).toEqual(["analyst.department_dim"]);
  });

  it("handshake state is per-backend (fresh session each run)", async () => {
    const a = createFixtureBackend();
    await a.call("get_analyst_catalog", { rationale: "d" });
    await a.call("get_analyst_spend_facts_domain_docs", { rationale: "d" });
    const fresh = createFixtureBackend();
    const r = (await fresh.call("execute_analyst_query", { sql: netSql, rationale: "net" })).data as Record<string, unknown>;
    expect(r.status).toBe("docs_required");
    expect(r.missing_catalog).toBe(true);
  });
});

describe("SQL errors and validation", () => {
  it("surfaces a DuckDB error for self-correction (ok=false)", async () => {
    const b = createFixtureBackend();
    await b.call("get_analyst_catalog", { rationale: "d" });
    await b.call("get_analyst_spend_facts_domain_docs", { rationale: "d" });
    const res = await b.call("execute_analyst_query", { sql: "SELECT bogus FROM analyst.spend_facts", rationale: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/SQL error/i);
  });

  it("rejects a call missing the required rationale", async () => {
    const b = createFixtureBackend();
    const res = await b.call("execute_analyst_query", { sql: netSql });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/rationale/i);
  });
});

describe("read-only guarantee", () => {
  it("blocks the registered write tool", async () => {
    const b = createFixtureBackend();
    const res = await b.call("update_merchant_restrictions", { rationale: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/write tool/i);
  });
});

describe("wire money formats", () => {
  it("transaction amounts are formatted strings; the Nobu charge is flagged", async () => {
    const b = createFixtureBackend();
    const res = (await b.call("get_user_transactions", { merchant_search: "nobu", rationale: "find" })).data as {
      transactions: Array<{ amount: string; system_in_or_out_of_policy_assessment: string }>;
    };
    expect(res.transactions[0]!.amount).toBe("$6,750.00");
    expect(res.transactions[0]!.system_in_or_out_of_policy_assessment).toBe("OUT_OF_POLICY");
  });

  it("search_vendors surfaces both Delta spellings", async () => {
    const b = createFixtureBackend();
    const res = (await b.call("search_vendors", { search_term: "delta", rationale: "variant" })).data as {
      vendors: Array<{ name: string }>;
    };
    expect(res.vendors.map((v) => v.name).sort()).toEqual(["Delta Air Lines", "Delta Airlines"]);
  });

  it("answer_policy_question returns the meals cap for a meals question", async () => {
    const b = createFixtureBackend();
    const res = (await b.call("answer_policy_question", { question: "what is the limit on client dinners?", rationale: "policy" })).data as { answer: string };
    expect(res.answer).toMatch(/\$500/);
  });

  it("answer_policy_question is not hijacked by a generic word (meals over flights)", async () => {
    const b = createFixtureBackend();
    // Mentions 'travel' but is clearly about a meal: must resolve to the meals policy.
    const res = (await b.call("answer_policy_question", { question: "on a business travel trip, is a $6,750 client dinner within meal policy?", rationale: "policy" })).data as { answer: string };
    expect(res.answer).toMatch(/\$500/);
    expect(res.answer.toLowerCase()).toContain("meal");
  });
});

describe("column format inference", () => {
  it("classifies money columns as money and identifier columns as text/number", async () => {
    const b = createFixtureBackend();
    await b.call("get_analyst_catalog", { rationale: "d" });
    await b.call("get_analyst_spend_facts_domain_docs", { rationale: "d" });
    const res = (await b.call("execute_analyst_query", {
      sql: "SELECT sf.spend_event_uuid, sf.spend_event_id, sf.amount, sf.spend_program, sf.transaction_date FROM analyst.spend_facts sf LIMIT 1",
      rationale: "inspect column formats",
    })).data as { columns: Array<{ key: string; format: string }> };
    const fmt = Object.fromEntries(res.columns.map((c) => [c.key, c.format]));
    expect(fmt.spend_event_uuid).toBe("text"); // was wrongly "money" (regex matched 'spend')
    expect(fmt.spend_program).toBe("text");
    expect(fmt.spend_event_id).toBe("number");
    expect(fmt.amount).toBe("money");
    expect(fmt.transaction_date).toBe("date");
  });
});
