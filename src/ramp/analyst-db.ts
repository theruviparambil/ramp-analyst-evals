/**
 * The analyst artifact — a real, in-process DuckDB built from the fixture.
 *
 * `execute_analyst_query` runs genuine DuckDB SQL against these tables, so the
 * agent's queries either work or fail for real reasons (a bad column, a missing
 * GROUP BY), and the self-correction loop has something authentic to correct
 * against. This mirrors Ramp's analyst surface, where the central table is
 * `analyst.spend_facts` and dimensions hang off it.
 *
 * Tables built here (schema-faithful to Ramp's `analyst.*` naming):
 *   analyst.spend_facts     — one row per card spend event (money as DECIMAL $)
 *   analyst.user_dim        — employees (join for names / department / active)
 *   analyst.department_dim  — departments
 *   analyst.merchant_dim    — merchants + normalized_merchant_name (variant key)
 *   analyst.ap_bill_facts   — accounts-payable bills (money as DECIMAL $)
 *
 * Everything is READ-ONLY: the connection only ever runs SELECTs the tool layer
 * has validated, and there is no write path exposed to the agent.
 */

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { BILLS, DEPARTMENTS, MERCHANTS, TRANSACTIONS, USERS } from "../fixture/data.js";

export interface QueryColumn {
  key: string;
  label: string;
  format: "money" | "date" | "number" | "text";
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Array<Record<string, unknown>>;
}

/** The analyst tables present in this artifact (drives the catalog tool). */
export const ANALYST_TABLE_NAMES = [
  "analyst.spend_facts",
  "analyst.user_dim",
  "analyst.department_dim",
  "analyst.merchant_dim",
  "analyst.ap_bill_facts",
] as const;

export type AnalystTableName = (typeof ANALYST_TABLE_NAMES)[number];

/** Extract the fully-qualified `analyst.<table>` names a query references. */
export function referencedTables(sql: string): string[] {
  const found = new Set<string>();
  const re = /analyst\.([a-z_][a-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) found.add(`analyst.${m[1].toLowerCase()}`);
  return [...found];
}

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const money = (cents: number): string => (cents / 100).toFixed(2);

function valuesRow(cells: string[]): string {
  return `(${cells.join(", ")})`;
}

/** Turn one DuckDB result cell into a plain JSON-safe value. */
function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
  if (typeof v === "object") {
    const ctor = (v as { constructor?: { name?: string } }).constructor?.name ?? "";
    const s = String(v);
    if (ctor.includes("Decimal")) return Number(s);
    return s; // dates, timestamps, etc. -> their canonical string form
  }
  return v;
}

export class AnalystArtifact {
  private conn: DuckDBConnection | null = null;
  private ready: Promise<void> | null = null;

  /** Build the DuckDB tables once. Idempotent and safe to await repeatedly. */
  async init(): Promise<void> {
    if (!this.ready) this.ready = this.build();
    return this.ready;
  }

  private async build(): Promise<void> {
    const instance = await DuckDBInstance.create(":memory:");
    this.conn = await instance.connect();
    const run = (sql: string) => this.conn!.run(sql);

    await run("CREATE SCHEMA analyst");

    await run(`CREATE TABLE analyst.department_dim (
      department_uuid VARCHAR, department_id BIGINT, department_name VARCHAR)`);
    await run(`INSERT INTO analyst.department_dim VALUES ${DEPARTMENTS.map((d) =>
      valuesRow([q(d.department_uuid), String(d.department_id), q(d.department_name)]),
    ).join(",\n")}`);

    await run(`CREATE TABLE analyst.user_dim (
      user_uuid VARCHAR, user_id BIGINT, first_name VARCHAR, last_name VARCHAR, email VARCHAR,
      role VARCHAR, is_active BOOLEAN, department_uuid VARCHAR, department_name VARCHAR, location_name VARCHAR)`);
    await run(`INSERT INTO analyst.user_dim VALUES ${USERS.map((u) =>
      valuesRow([
        q(u.user_uuid), String(u.user_id), q(u.first_name), q(u.last_name), q(u.email),
        q(u.role), String(u.is_active), q(u.department_uuid), q(u.department_name), q(u.location_name),
      ]),
    ).join(",\n")}`);

    await run(`CREATE TABLE analyst.merchant_dim (
      merchant_uuid VARCHAR, merchant_name VARCHAR, normalized_merchant_name VARCHAR, merchant_category VARCHAR)`);
    await run(`INSERT INTO analyst.merchant_dim VALUES ${MERCHANTS.map((m) =>
      valuesRow([q(m.merchant_uuid), q(m.merchant_name), q(m.normalized_merchant_name), q(m.merchant_category)]),
    ).join(",\n")}`);

    await run(`CREATE TABLE analyst.spend_facts (
      spend_event_uuid VARCHAR, spend_event_id BIGINT, transaction_date DATE, amount DECIMAL(12,2),
      currency VARCHAR, merchant_uuid VARCHAR, merchant_name VARCHAR, merchant_category VARCHAR,
      user_uuid VARCHAR, department_uuid VARCHAR, policy_status VARCHAR, spend_program VARCHAR)`);
    await run(`INSERT INTO analyst.spend_facts VALUES ${TRANSACTIONS.map((t) =>
      valuesRow([
        q(t.spend_event_uuid), String(t.spend_event_id), `DATE '${t.transaction_date}'`, money(t.amount_cents),
        q(t.currency), q(t.merchant_uuid), q(t.merchant_name), q(t.merchant_category),
        q(t.user_uuid), q(t.department_uuid), q(t.policy_status), q(t.spend_program),
      ]),
    ).join(",\n")}`);

    await run(`CREATE TABLE analyst.ap_bill_facts (
      bill_uuid VARCHAR, payee_uuid VARCHAR, payee_name VARCHAR, amount DECIMAL(12,2), currency VARCHAR,
      invoice_number VARCHAR, payment_status VARCHAR, issue_date DATE, due_date DATE, payment_date DATE)`);
    await run(`INSERT INTO analyst.ap_bill_facts VALUES ${BILLS.map((b) =>
      valuesRow([
        q(b.bill_uuid), q(b.payee_uuid), q(b.payee_name), money(b.amount_cents), q(b.currency),
        q(b.invoice_number), q(b.payment_status), `DATE '${b.issue_date}'`, `DATE '${b.due_date}'`,
        b.payment_date ? `DATE '${b.payment_date}'` : "NULL",
      ]),
    ).join(",\n")}`);
  }

  /**
   * Execute read-only SQL and return normalized rows. Throws on any SQL error
   * (bad column, syntax, aggregation) — the caller surfaces the message to the
   * agent so it can repair and retry.
   */
  async query(sql: string): Promise<QueryResult> {
    await this.init();
    const reader = await this.conn!.runAndReadAll(sql);
    const rawColumns = reader.columnNames();
    const columnTypes = reader.columnTypes().map((t) => String(t.typeId ?? t));
    const rows = reader.getRowObjects().map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = normalize(v);
      return out;
    });
    const columns: QueryColumn[] = rawColumns.map((name, i) => ({
      key: name,
      label: name,
      format: inferFormat(name, columnTypes[i] ?? ""),
    }));
    return { columns, rows };
  }
}

function inferFormat(name: string, typeId: string): QueryColumn["format"] {
  const n = name.toLowerCase();
  // Exclusions first: identifiers and labels are never money, even when their
  // name contains a money-ish token (e.g. spend_event_uuid, spend_program).
  if (/uuid|_name$|^name$|category|status|program|currency|email|role|vendor|merchant$|department$|user$/.test(n)) return "text";
  if (/date/.test(n)) return "date";
  if (/_id$|_id\b|count|num_/.test(n)) return "number";
  if (/amount|spend|total|sum|cost|net|gross|balance|revenue|average|avg/.test(n)) return "money";
  if (/DECIMAL|DOUBLE|FLOAT/i.test(typeId)) return "money";
  if (/INT|BIGINT/i.test(typeId)) return "number";
  return "text";
}
