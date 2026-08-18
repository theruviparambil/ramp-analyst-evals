/**
 * Enforce that agent-authored SQL is a single read-only SELECT.
 *
 * The model writes this SQL, so the model is the threat model. Without this,
 * DuckDB runs whatever it is handed: `DELETE FROM analyst.spend_facts` succeeds,
 * and `read_csv_auto('/etc/hosts')` returns the contents of an arbitrary file.
 *
 * The correctness consequence is worse than the security one. The DuckDB
 * instance is a process-wide singleton shared across an entire eval run, so one
 * mutating query in question 4 silently corrupts the fixture for every question
 * after it, while the oracle keeps grading against pristine data. The harness
 * would report capability failures it caused itself and there would be no trace.
 *
 * Approach: strip comments and quoted text first, so keywords cannot hide inside
 * a string literal ("WHERE note = 'drop table'") or trigger a false positive
 * from an identifier. Then require exactly one statement, require it to start
 * with SELECT or WITH, and reject statement-type and file-access keywords.
 */

/** Statement types that mutate state, change session config, or load extensions. */
const FORBIDDEN_KEYWORDS = [
  "alter", "analyze", "attach", "begin", "call", "checkpoint", "commit", "copy",
  "create", "deallocate", "delete", "describe", "detach", "drop", "execute",
  "export", "grant", "import", "insert", "install", "load", "pragma", "prepare",
  "reindex", "reset", "revoke", "rollback", "set", "truncate", "update", "vacuum",
] as const;

/** Table functions that read from the filesystem, the network, or other databases. */
const FORBIDDEN_FUNCTIONS = [
  "read_csv", "read_csv_auto", "read_parquet", "read_json", "read_json_auto",
  "read_json_objects", "read_ndjson", "read_ndjson_auto", "read_text", "read_blob",
  "read_xlsx", "glob", "parquet_scan", "csv_scan", "sniff_csv", "delta_scan",
  "iceberg_scan", "postgres_scan", "postgres_scan_pushdown", "mysql_scan",
  "sqlite_scan", "shellfs", "parquet_metadata", "parquet_schema",
] as const;

export class ReadOnlyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyViolationError";
  }
}

/**
 * Blank out comments and quoted text, preserving length-irrelevant structure.
 *
 * Single quotes are string literals, double quotes and backticks are identifiers,
 * and `$tag$...$tag$` is DuckDB's dollar-quoting. All four can contain words that
 * would otherwise look like keywords, so none of them are scanned.
 */
export function stripCommentsAndQuoted(sql: string): string {
  let out = sql;
  out = out.replace(/\/\*[\s\S]*?\*\//g, " ");        // /* block */
  out = out.replace(/--[^\n]*/g, " ");                 // -- line
  out = out.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " ''  "); // $tag$ ... $tag$
  out = out.replace(/'(?:[^']|'')*'/g, " '' ");        // 'literal', '' escapes
  out = out.replace(/"(?:[^"]|"")*"/g, " ident ");     // "identifier"
  out = out.replace(/`[^`]*`/g, " ident ");            // `identifier`
  return out;
}

/**
 * Throw unless `sql` is exactly one read-only SELECT.
 *
 * Called before execution rather than inside it, so the guarantee holds for any
 * caller rather than only the tool layer.
 */
export function assertReadOnlyQuery(sql: string): void {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new ReadOnlyViolationError("Query rejected: empty SQL.");
  }

  const scrubbed = stripCommentsAndQuoted(sql);

  // One statement only. A trailing semicolon is fine; a second statement is not,
  // since "SELECT 1; DELETE FROM analyst.spend_facts" would otherwise pass a
  // naive prefix check.
  const statements = scrubbed.split(";").filter((s) => s.trim() !== "");
  if (statements.length > 1) {
    throw new ReadOnlyViolationError(
      "Query rejected: multiple statements are not allowed. Send one SELECT.",
    );
  }

  const body = (statements[0] ?? "").trim();
  if (!/^(select|with)\b/i.test(body)) {
    const firstWord = body.split(/\s+/)[0] ?? "";
    throw new ReadOnlyViolationError(
      `Query rejected: only SELECT is allowed, got "${firstWord.toUpperCase()}". ` +
        "This tool is read-only.",
    );
  }

  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(body)) {
      throw new ReadOnlyViolationError(
        `Query rejected: "${kw.toUpperCase()}" is not permitted. This tool is read-only.`,
      );
    }
  }

  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (new RegExp(`\\b${fn}\\s*\\(`, "i").test(body)) {
      throw new ReadOnlyViolationError(
        `Query rejected: "${fn}" reads outside the analyst tables and is not permitted.`,
      );
    }
  }
}
