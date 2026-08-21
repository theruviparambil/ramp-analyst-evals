import { describe, expect, it, beforeAll } from "vitest";
import { AnalystArtifact } from "./analyst-db.js";
import { TRANSACTIONS } from "../fixture/data.js";

/**
 * Executes queries and then checks the database, which the guard's own unit
 * tests never did.
 *
 * `read-only-sql.test.ts` has thirty tests and every one of them asserts on
 * `assertReadOnlyQuery` in isolation. All thirty passed while the guard let
 * `SELECT '--' AS x; DELETE FROM analyst.spend_facts` through, because the
 * scrubber stripped comments before quotes, so a comment marker inside a string
 * literal truncated everything after it and the guard saw only `SELECT '`.
 * `runAndReadAll` then executed both statements: 207 rows before, 0 after, and
 * a success-shaped result returned to the agent with no trace in the trajectory.
 *
 * A guard test that never runs the query cannot catch that. These do.
 */

// The whole table, including the rows outside Q2 that make the date filter
// load-bearing. This suite is about mutation, not about the reporting period.
// Derived, not pinned: the fixture gained an orphan-merchant row and two
// pre-transfer charges, and a hand-updated literal here would have to be
// chased every time the data grows. What these tests assert is that the count
// is UNCHANGED by an attack, not what the count happens to be.
const ROWS = TRANSACTIONS.length;

describe("read-only enforcement, end to end", () => {
  let db: AnalystArtifact;

  beforeAll(async () => {
    db = new AnalystArtifact();
    await db.init();
  });

  const rowCount = async (): Promise<number> => {
    const result = await db.query("SELECT COUNT(*) AS n FROM analyst.spend_facts");
    return Number(JSON.parse(JSON.stringify(result.rows))[0].n);
  };

  it("starts from the expected fixture", async () => {
    expect(await rowCount()).toBe(ROWS);
  });

  const attacks: Array<[string, string]> = [
    ["comment marker inside a string literal, then DELETE",
      `SELECT '--' AS x; DELETE FROM analyst.spend_facts`],
    ["comment marker inside a quoted identifier, then DELETE",
      `SELECT 1 AS "a--b"; DELETE FROM analyst.spend_facts`],
    ["block-comment opener inside a literal, DELETE, then close it",
      `SELECT '/*' AS a; DELETE FROM analyst.spend_facts; SELECT '*/' AS b`],
    ["comment marker inside a literal, then UPDATE",
      `SELECT '--' AS x; UPDATE analyst.spend_facts SET amount = 999999.00`],
    ["dollar-quoted comment marker, then DELETE",
      `SELECT $t$--$t$ AS x; DELETE FROM analyst.spend_facts`],
    ["file read via a table function",
      `SELECT '--' AS x, * FROM read_csv_auto('/etc/hosts')`],
    ["file read via DuckDB's replacement scan, no evasion at all",
      `SELECT * FROM '/etc/hosts'`],
    ["file write, i.e. exfiltration",
      `WITH x AS (SELECT '--' ) SELECT * FROM x; COPY analyst.spend_facts TO '/tmp/jc-exfil.csv'`],
    ["re-enabling external access mid-session",
      `SET enable_external_access = true`],
    ["ATTACH a second database",
      `SELECT '--' AS a; ATTACH '/tmp/x.db' AS x`],
    ["plain DELETE, the control case",
      `DELETE FROM analyst.spend_facts`],
  ];

  it.each(attacks)("rejects: %s", async (_name, sql) => {
    await expect(db.query(sql)).rejects.toThrow();
  });

  it("leaves the fixture untouched after every attack", async () => {
    for (const [, sql] of attacks) {
      await db.query(sql).catch(() => undefined);
    }
    expect(await rowCount()).toBe(ROWS);
  });

  it("still answers legitimate analytical queries", async () => {
    const result = await db.query(
      "SELECT COUNT(*) AS n FROM analyst.spend_facts WHERE amount > 1000",
    );
    expect(Number(JSON.parse(JSON.stringify(result.rows))[0].n)).toBeGreaterThan(0);
  });

  it("still answers a CTE, which the guard must not confuse with a second statement", async () => {
    const result = await db.query(
      `WITH big AS (SELECT * FROM analyst.spend_facts WHERE amount > 1000)
       SELECT COUNT(*) AS n FROM big`,
    );
    expect(Number(JSON.parse(JSON.stringify(result.rows))[0].n)).toBeGreaterThan(0);
  });

  it("rejects a function name hidden inside a quoted identifier", async () => {
    // The scrubber blanks quoted identifiers so `SELECT 1 AS "delete"` is not
    // read as a DELETE. That also hid function names from the blocklist, so
    // quoting the call was enough to defeat it and only the connection lockdown
    // stopped the read. Two layers are only two layers if each works alone.
    await expect(db.query(`SELECT * FROM "read_csv_auto"('/etc/hosts')`)).rejects.toThrow();
    await expect(db.query("SELECT * FROM `read_text`('/etc/hosts')")).rejects.toThrow();
  });

  it("rejects the indirection functions that evaluate SQL from a string", async () => {
    await expect(db.query(`SELECT * FROM query('SELECT 1')`)).rejects.toThrow();
    await expect(db.query(`SELECT * FROM query_table('analyst.spend_facts')`)).rejects.toThrow();
  });

  it("still allows a quoted identifier that merely looks dangerous", async () => {
    // Not followed by "(", so it is a column alias and not a call.
    const result = await db.query(
      `SELECT COUNT(*) AS "read_csv_auto" FROM analyst.spend_facts`,
    );
    expect(Number(JSON.parse(JSON.stringify(result.rows))[0].read_csv_auto)).toBe(ROWS);
  });

  it("still allows an identifier containing a reserved word", async () => {
    const result = await db.query(`SELECT 1 AS "delete"`);
    expect(JSON.parse(JSON.stringify(result.rows))[0].delete).toBe(1);
  });

  it("still allows a literal that merely looks like a comment", async () => {
    const result = await db.query(`SELECT '--not a comment' AS note`);
    expect(JSON.parse(JSON.stringify(result.rows))[0].note).toBe("--not a comment");
  });
});
