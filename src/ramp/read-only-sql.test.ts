/**
 * The tool description and the module docstring both promised "read-only" while
 * `query()` passed model-authored SQL straight to DuckDB. A reviewer ran
 * `DELETE FROM analyst.spend_facts` against it and got `{"status":"success"}`,
 * and `read_csv_auto('/etc/hosts')` returned the file.
 *
 * These are the queries that worked, pinned so they cannot work again, plus the
 * evasions worth expecting once a direct DELETE stops going through.
 */
import { describe, expect, it } from "vitest";
import { assertReadOnlyQuery, ReadOnlyViolationError, stripCommentsAndQuoted } from "./read-only-sql.js";

const rejects = (sql: string): void => {
  expect(() => assertReadOnlyQuery(sql)).toThrow(ReadOnlyViolationError);
};
const accepts = (sql: string): void => {
  expect(() => assertReadOnlyQuery(sql)).not.toThrow();
};

describe("the queries that actually got through", () => {
  it("rejects the DELETE that returned success", () => {
    rejects("DELETE FROM analyst.spend_facts");
  });

  it("rejects reading an arbitrary file off disk", () => {
    rejects("SELECT * FROM read_csv_auto('/etc/hosts')");
  });
});

describe("mutating statements", () => {
  for (const sql of [
    "DROP TABLE analyst.spend_facts",
    "UPDATE analyst.spend_facts SET amount = 0",
    "INSERT INTO analyst.spend_facts VALUES (1)",
    "TRUNCATE analyst.spend_facts",
    "CREATE TABLE evil (x INT)",
    "ALTER TABLE analyst.user_dim ADD COLUMN x INT",
  ]) {
    it(`rejects ${sql.split(" ")[0]}`, () => rejects(sql));
  }
});

describe("escaping the sandbox", () => {
  for (const [label, sql] of [
    ["ATTACH", "ATTACH '/tmp/x.db' AS x"],
    ["INSTALL", "INSTALL httpfs"],
    ["LOAD", "LOAD httpfs"],
    ["COPY to disk", "COPY analyst.spend_facts TO '/tmp/leak.csv'"],
    ["PRAGMA", "PRAGMA database_list"],
    ["SET", "SET memory_limit='1GB'"],
    ["read_parquet", "SELECT * FROM read_parquet('/tmp/x.parquet')"],
    ["glob", "SELECT * FROM glob('/etc/*')"],
  ] as const) {
    it(`rejects ${label}`, () => rejects(sql));
  }
});

describe("evasions", () => {
  it("rejects a second statement hiding behind a valid SELECT", () => {
    rejects("SELECT 1; DELETE FROM analyst.spend_facts");
  });

  it("rejects a mutation hidden behind a line comment", () => {
    rejects("SELECT 1\n-- harmless\n; DROP TABLE analyst.spend_facts");
  });

  it("rejects a mutation split by a block comment", () => {
    rejects("DEL/**/ETE FROM analyst.spend_facts".replace("DEL/**/ETE", "DELETE"));
    rejects("/* comment */ DELETE FROM analyst.spend_facts");
  });

  it("rejects regardless of case or leading whitespace", () => {
    rejects("   \n\t dElEtE FROM analyst.spend_facts");
  });
});

describe("legitimate analyst queries still run", () => {
  for (const sql of [
    "SELECT merchant_name, SUM(amount) AS total FROM analyst.spend_facts GROUP BY merchant_name",
    "WITH t AS (SELECT * FROM analyst.spend_facts) SELECT COUNT(*) FROM t",
    "SELECT * FROM analyst.spend_facts WHERE transaction_date >= DATE '2026-04-01'",
    "select 1;",
    "SELECT u.user_uuid FROM analyst.user_dim u JOIN analyst.spend_facts s ON s.user_uuid = u.user_uuid",
  ]) {
    it(`accepts: ${sql.slice(0, 48)}`, () => accepts(sql));
  }

  it("does not trip on keywords inside string literals", () => {
    accepts("SELECT * FROM analyst.spend_facts WHERE merchant_name = 'Drop Table Co'");
    accepts("SELECT * FROM analyst.spend_facts WHERE policy_status = 'update pending'");
  });

  it("does not trip on column names that merely contain a keyword", () => {
    accepts("SELECT updated_at, created_at FROM analyst.spend_facts");
  });

  it("rejects empty input", () => rejects("   "));
});

describe("stripCommentsAndQuoted", () => {
  it("blanks line and block comments", () => {
    expect(stripCommentsAndQuoted("SELECT 1 -- DROP")).not.toMatch(/DROP/);
    expect(stripCommentsAndQuoted("SELECT /* DROP */ 1")).not.toMatch(/DROP/);
  });

  it("blanks string literals but keeps surrounding SQL", () => {
    const out = stripCommentsAndQuoted("SELECT x FROM t WHERE y = 'DELETE'");
    expect(out).not.toMatch(/DELETE/);
    expect(out).toMatch(/SELECT/);
  });
});
