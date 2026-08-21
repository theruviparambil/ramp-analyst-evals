/**
 * Core-owned catalog + domain docs for the analyst artifact.
 *
 * In Ramp's real MCP, these are returned by GetAnalystCatalog and the
 * *DomainDocs tools, and they are the *semantic source of truth* the agent is
 * told to read before writing SQL (don't introspect DuckDB metadata, don't
 * guess column names). We reproduce that contract: the docs describe the grain,
 * the money/date columns, the join keys, and, critically, the caveat that
 * `merchant_name` is un-normalized, which is how a docs-reading agent learns to
 * collapse raw merchant spellings onto a canonical name.
 *
 * The response shapes mirror agent-tool.json (catalog: analyst_tables +
 * artifact + freshness; domain docs: columns[] + sections[] + caveats[]).
 */

import { ANALYST_TABLE_NAMES, type AnalystTableName } from "./analyst-db.js";
import { BILLS, MERCHANTS, TRANSACTIONS, USERS, DEPARTMENTS } from "../fixture/data.js";

const RESOLVED_AT = "2026-07-01T00:00:00Z";

export interface CatalogTable {
  qualified_name: string;
  schema_name: string;
  table_name: string;
  availability: "queryable" | "unavailable";
  column_count: number;
  row_count: number;
  source_tables: string[];
  /**
   * Example queries, deliberately NOT the answers to the golden set.
   *
   * These used to be the solution SQL verbatim: the net-spend sum, the
   * normalized-vendor group-by, and `SELECT COUNT(*) AS active_users ... WHERE
   * is_active`, whose alias is the exact JSON key q12 is graded on. The agent
   * is REQUIRED to fetch these docs before it can query, so the eval was
   * partly measuring whether a model can copy a query it was just handed.
   * Seven of the eight questions with a leaked method sat at a perfect ceiling
   * for all three agents.
   *
   * They are near-misses now: same tables, same joins, same idiom, different
   * aggregate or grouping. They still teach the schema, which is what a real
   * catalog does, without answering anything.
   */
  starter_queries: string[];
}

export interface DomainDocColumn {
  column_name: string;
  description: string;
}

export interface DomainDocs {
  qualified_name: string;
  artifact_status: "fresh";
  table_availability: "queryable";
  columns: DomainDocColumn[];
  sections: Array<{ title: string; content: string }>;
  caveats: string[];
  column_count: number;
  row_count: number;
  source_tables: string[];
  resolved_at: string;
  external_agent_messages: string[];
}

const rowCounts: Record<AnalystTableName, number> = {
  "analyst.spend_facts": TRANSACTIONS.length,
  "analyst.user_dim": USERS.length,
  "analyst.department_dim": DEPARTMENTS.length,
  "analyst.merchant_dim": MERCHANTS.length,
  "analyst.ap_bill_facts": BILLS.length,
};

interface TableDoc {
  columns: DomainDocColumn[];
  sections: Array<{ title: string; content: string }>;
  caveats: string[];
  source_tables: string[];
  starter_queries: string[];
}

const TABLE_DOCS: Record<AnalystTableName, TableDoc> = {
  "analyst.spend_facts": {
    columns: [
      { column_name: "spend_event_uuid", description: "Stable UUID for the card spend event. Use this (not spend_event_id) when filtering or joining on a specific event." },
      { column_name: "spend_event_id", description: "Integer surrogate id. Never compare this to a UUID string literal." },
      { column_name: "transaction_date", description: "DATE the transaction settled. Compare with DATE 'YYYY-MM-DD' literals." },
      { column_name: "amount", description: "Signed DECIMAL in whole dollars (USD). Positive = spend, negative = refund/credit. Sum directly for net spend; filter amount > 0 for gross." },
      { column_name: "currency", description: "ISO currency code. All rows in this fixture are USD." },
      { column_name: "merchant_uuid", description: "FK to merchant_dim.merchant_uuid." },
      { column_name: "merchant_name", description: "Merchant name AS CAPTURED at authorization. NOT normalized: the same vendor can appear under multiple spellings. For canonical vendor totals, join merchant_dim and group by normalized_merchant_name." },
      { column_name: "merchant_category", description: "Merchant category label, e.g. 'SaaS / Software', 'Advertising', 'Airlines'." },
      { column_name: "user_uuid", description: "FK to user_dim.user_uuid, the employee who made the charge." },
      { column_name: "department_uuid", description: "FK to department_dim.department_uuid, the spending user's department at time of charge." },
      { column_name: "policy_status", description: "System policy assessment: 'in_policy' or 'out_of_policy'." },
      { column_name: "spend_program", description: "Internal spend program / allocation bucket, e.g. 'Software', 'Cloud', 'Travel', 'Marketing', 'G&A'." },
    ],
    sections: [
      { title: "Grain", content: "One row per settled card spend event. Bill/AP spend is NOT here. See analyst.ap_bill_facts. There is no unified spend table; card and AP are separate." },
      { title: "Money", content: "amount is a signed DECIMAL in dollars. Refunds and credits are stored as negative rows in the same column, so a naive total nets them out." },
      { title: "Identity caveats", content: "Join to dims for human-readable labels: user_dim for names/role/active status, department_dim for department name, merchant_dim for the canonical (normalized) vendor name. merchant_name on this table is raw and may contain variant spellings." },
    ],
    caveats: [
      "merchant_name is not normalized; grouping by it splits a single vendor across spelling variants. Use merchant_dim.normalized_merchant_name for true vendor totals.",
      "amount is signed; include negative rows (refunds) knowingly when reporting net vs gross.",
      "This table covers card spend only. For bills/AP use analyst.ap_bill_facts.",
    ],
    source_tables: ["core.card_transactions", "core.spend_events"],
    starter_queries: [
      "SELECT spend_facts.transaction_date, spend_facts.amount FROM analyst.spend_facts ORDER BY spend_facts.transaction_date DESC LIMIT 20",
      "SELECT spend_facts.spend_program, COUNT(*) AS n FROM analyst.spend_facts GROUP BY spend_facts.spend_program",
    ],
  },
  "analyst.user_dim": {
    columns: [
      { column_name: "user_uuid", description: "Stable user UUID. Join target for spend_facts.user_uuid." },
      { column_name: "user_id", description: "Integer surrogate id. Do not compare to UUID strings." },
      { column_name: "first_name", description: "Given name." },
      { column_name: "last_name", description: "Family name." },
      { column_name: "email", description: "Work email." },
      { column_name: "role", description: "Ramp role: OWNER, ADMIN, MEMBER, BOOKKEEPER." },
      { column_name: "is_active", description: "BOOLEAN. FALSE = deactivated employee. Filter to is_active for 'active users' questions." },
      { column_name: "department_uuid", description: "FK to department_dim.department_uuid." },
      { column_name: "department_name", description: "Denormalized department label (also available via department_dim)." },
      { column_name: "location_name", description: "Office / location label." },
    ],
    sections: [{ title: "Grain", content: "One row per employee (active and inactive). Use is_active to distinguish." }],
    caveats: ["Inactive users still appear; exclude them with WHERE user_dim.is_active for headcount / active-user metrics."],
    source_tables: ["core.users"],
    starter_queries: ["SELECT user_dim.role, COUNT(*) AS n FROM analyst.user_dim GROUP BY user_dim.role"],
  },
  "analyst.department_dim": {
    columns: [
      { column_name: "department_uuid", description: "Stable department UUID. Join target for spend_facts.department_uuid." },
      { column_name: "department_id", description: "Integer surrogate id." },
      { column_name: "department_name", description: "Department label, e.g. 'Engineering'." },
    ],
    sections: [{ title: "Grain", content: "One row per department." }],
    caveats: [],
    source_tables: ["core.departments"],
    starter_queries: [
      "SELECT d.department_name, COUNT(*) AS txn_count FROM analyst.spend_facts sf JOIN analyst.department_dim d ON sf.department_uuid = d.department_uuid GROUP BY d.department_name",
    ],
  },
  "analyst.merchant_dim": {
    columns: [
      { column_name: "merchant_uuid", description: "Stable merchant UUID. Join target for spend_facts.merchant_uuid." },
      { column_name: "merchant_name", description: "Raw merchant name as captured (may be a variant spelling)." },
      { column_name: "normalized_merchant_name", description: "Canonical vendor name. Multiple raw merchant_name spellings map to one normalized_merchant_name. GROUP BY this for true per-vendor totals." },
      { column_name: "merchant_category", description: "Merchant category label." },
    ],
    sections: [
      { title: "Grain", content: "One row per raw merchant record. Several rows can share a normalized_merchant_name when the same vendor was captured under different spellings." },
    ],
    caveats: ["To combine vendor spelling variants, join spend_facts to merchant_dim on merchant_uuid and group by normalized_merchant_name."],
    source_tables: ["core.merchants"],
    starter_queries: [
      "SELECT sf.merchant_name, COUNT(*) AS n FROM analyst.spend_facts sf GROUP BY sf.merchant_name ORDER BY n DESC LIMIT 10",
    ],
  },
  "analyst.ap_bill_facts": {
    columns: [
      { column_name: "bill_uuid", description: "Stable bill UUID." },
      { column_name: "payee_uuid", description: "Vendor/payee UUID." },
      { column_name: "payee_name", description: "Vendor/payee name." },
      { column_name: "amount", description: "Bill amount, DECIMAL dollars (USD). Positive." },
      { column_name: "currency", description: "ISO currency code." },
      { column_name: "invoice_number", description: "Vendor invoice number." },
      { column_name: "payment_status", description: "'PAID' or 'OPEN'. OPEN = an unpaid commitment." },
      { column_name: "issue_date", description: "DATE the bill was issued." },
      { column_name: "due_date", description: "DATE the bill is due." },
      { column_name: "payment_date", description: "DATE the bill was paid (NULL if still OPEN)." },
    ],
    sections: [
      { title: "Grain", content: "One row per accounts-payable bill. Separate from card spend (analyst.spend_facts). Do not add the two without saying so." },
      { title: "Money", content: "amount is positive DECIMAL dollars. payment_status distinguishes settled bills from outstanding ones." },
    ],
    caveats: ["Bills and card transactions are different resources; report them separately unless explicitly combining committed + actual spend."],
    source_tables: ["core.bills"],
    starter_queries: [
      "SELECT ap_bill_facts.payment_status, COUNT(*) AS n FROM analyst.ap_bill_facts GROUP BY ap_bill_facts.payment_status",
    ],
  },
};

export function getCatalog(): { analyst_tables: CatalogTable[]; artifact: Record<string, unknown>; freshness: Record<string, unknown> } {
  const analyst_tables: CatalogTable[] = ANALYST_TABLE_NAMES.map((name) => {
    const doc = TABLE_DOCS[name];
    return {
      qualified_name: name,
      schema_name: "analyst",
      table_name: name.split(".")[1]!,
      availability: "queryable",
      column_count: doc.columns.length,
      row_count: rowCounts[name],
      source_tables: doc.source_tables,
      starter_queries: doc.starter_queries,
    };
  });
  return {
    analyst_tables,
    artifact: {
      artifact_instance_id: "default",
      artifact_instance_name: "Vela Robotics (default)",
      is_default_artifact_instance: true,
      build_status: "succeeded",
      artifact_schema_version: "1.0.0",
    },
    freshness: { status: "fresh", computed_at: RESOLVED_AT, source_table_count: 6 },
  };
}

export function getTableDomainDocs(name: AnalystTableName): DomainDocs {
  const doc = TABLE_DOCS[name];
  return {
    qualified_name: name,
    artifact_status: "fresh",
    table_availability: "queryable",
    columns: doc.columns,
    sections: doc.sections,
    caveats: doc.caveats,
    column_count: doc.columns.length,
    row_count: rowCounts[name],
    source_tables: doc.source_tables,
    resolved_at: RESOLVED_AT,
    external_agent_messages: [],
  };
}

export function getSpendFactsDomainDocs(): DomainDocs {
  return getTableDomainDocs("analyst.spend_facts");
}

export function isAnalystTableName(name: string): name is AnalystTableName {
  return (ANALYST_TABLE_NAMES as readonly string[]).includes(name);
}
