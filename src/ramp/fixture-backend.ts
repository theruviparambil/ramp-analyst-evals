/**
 * Fixture backend: the default tool surface, backed by the local synthetic
 * company and a real in-process DuckDB.
 *
 * It is schema-faithful to Ramp's agent-tool wire shapes (formatted-string
 * transaction amounts, numeric bill dollars, the docs_required handshake) and
 * it enforces the same prerequisite Ramp's Core does: execute_analyst_query
 * refuses to run until, in THIS session, the catalog has been read and domain
 * docs have been read for every analyst.<table> the SQL references. That state
 * is per-backend, so each agent run starts with a clean handshake.
 */

import { centsToDisplay } from "../money.js";
import { POLICY_KB, TRANSACTIONS, USERS, VENDORS } from "../fixture/data.js";
import { AnalystArtifact, referencedTables, type AnalystTableName, ANALYST_TABLE_NAMES } from "./analyst-db.js";
import { getCatalog, getSpendFactsDomainDocs, getTableDomainDocs, isAnalystTableName } from "./docs.js";
import { getToolDef, isWriteTool, type RampToolSurface, type ToolResult } from "./tools.js";

const MAX_ROWS = 100;
const nameByUuid = new Map(USERS.map((u) => [u.user_uuid, `${u.first_name} ${u.last_name}`]));

let sharedArtifact: AnalystArtifact | null = null;
function getSharedArtifact(): AnalystArtifact {
  if (!sharedArtifact) sharedArtifact = new AnalystArtifact();
  return sharedArtifact;
}

class FixtureBackend implements RampToolSurface {
  readonly mode = "fixture" as const;
  private catalogRead = false;
  private docsRead = new Set<AnalystTableName>();

  constructor(private artifact: AnalystArtifact) {}

  async call(name: string, rawArgs: Record<string, unknown>): Promise<ToolResult> {
    const def = getToolDef(name);
    if (!def) return { ok: false, error: `unknown tool: ${name}` };

    // Validate arguments before executing (validate tool-call args, security floor).
    const parsed = def.argsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { ok: false, error: `invalid arguments for ${name}: ${detail}` };
    }
    const args = parsed.data as Record<string, unknown>;

    if (isWriteTool(name)) {
      return { ok: false, error: `${name} is a write tool and is disabled in this read-only analyst demo` };
    }

    switch (name) {
      case "get_analyst_catalog":
        this.catalogRead = true;
        return { ok: true, data: { ...getCatalog(), external_agent_messages: [] } };

      case "get_analyst_spend_facts_domain_docs":
        this.docsRead.add("analyst.spend_facts");
        return { ok: true, data: getSpendFactsDomainDocs() };

      case "get_analyst_table_domain_docs": {
        const qn = args.qualified_name as string;
        if (!isAnalystTableName(qn)) return { ok: false, error: `unknown analyst table: ${qn}` };
        this.docsRead.add(qn);
        return { ok: true, data: getTableDomainDocs(qn) };
      }

      case "execute_analyst_query":
        return this.executeAnalystQuery(args.sql as string);

      case "get_all_reduced_users":
        return this.listUsers(args);

      case "get_user_transactions":
        return this.getTransactions(args);

      case "search_vendors":
        return this.searchVendors(args);

      case "answer_policy_question":
        return this.answerPolicy(args);

      default:
        return { ok: false, error: `tool ${name} is registered but not implemented in the fixture backend` };
    }
  }

  private async executeAnalystQuery(sql: string): Promise<ToolResult> {
    const referenced = referencedTables(sql);
    const known = referenced.filter((t): t is AnalystTableName => (ANALYST_TABLE_NAMES as readonly string[]).includes(t));
    const missingDocs = known.filter((t) => !this.docsRead.has(t));

    if (!this.catalogRead || missingDocs.length > 0) {
      const requiredToolCalls: Array<{ tool_name: string; qualified_table_name?: string }> = [];
      if (!this.catalogRead) requiredToolCalls.push({ tool_name: "get_analyst_catalog" });
      for (const t of missingDocs) {
        requiredToolCalls.push(
          t === "analyst.spend_facts"
            ? { tool_name: "get_analyst_spend_facts_domain_docs", qualified_table_name: t }
            : { tool_name: "get_analyst_table_domain_docs", qualified_table_name: t },
        );
      }
      return {
        ok: true,
        data: {
          status: "docs_required",
          missing_catalog: !this.catalogRead,
          missing_doc_tables: missingDocs,
          referenced_tables: referenced,
          required_tool_calls: requiredToolCalls,
          rows: [],
          columns: [],
          message:
            "Prerequisite docs not yet read this session. Call the listed tools (get_analyst_catalog and the domain-docs tool for each referenced table), then resubmit the same SQL.",
          external_agent_messages: [
            "docs_required is a prerequisite response, not an error: read the requested docs and retry the query.",
          ],
        },
      };
    }

    try {
      const { columns, rows } = await this.artifact.query(sql);
      const truncated = rows.length > MAX_ROWS;
      return {
        ok: true,
        data: {
          status: "success",
          execution_mode: "materialized",
          columns,
          rows: rows.slice(0, MAX_ROWS),
          row_count: Math.min(rows.length, MAX_ROWS),
          total_row_count: rows.length,
          truncated,
          referenced_tables: referenced,
          message: truncated
            ? `Result truncated to ${MAX_ROWS} of ${rows.length} rows. Aggregate in SQL (GROUP BY / SUM) or add filters to get a complete answer.`
            : null,
          external_agent_messages: [],
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `SQL error: ${msg.split("\n")[0]}` };
    }
  }

  private listUsers(args: Record<string, unknown>): ToolResult {
    const search = (args.name_search as string | undefined)?.toLowerCase();
    const pageSize = (args.page_size as number | undefined) ?? 20;
    const matched = USERS.filter((u) => !search || `${u.first_name} ${u.last_name}`.toLowerCase().includes(search));
    const users = matched.slice(0, pageSize).map((u) => ({
      id: u.user_uuid,
      first_name: u.first_name,
      last_name: u.last_name,
      email: u.email,
      role: u.role,
      is_inactive: !u.is_active,
      department_name: u.department_name,
      location_name: u.location_name,
    }));
    return { ok: true, data: { users, next_page: matched.length > pageSize ? "cursor_2" : null, external_agent_messages: [] } };
  }

  private getTransactions(args: Record<string, unknown>): ToolResult {
    const from = args.from_date as string | undefined;
    const to = args.to_date as string | undefined;
    const merchant = (args.merchant_search as string | undefined)?.toLowerCase();
    const category = args.merchant_category as string | undefined;
    const pageSize = (args.page_size as number | undefined) ?? 50;

    let rows = [...TRANSACTIONS];
    if (from) rows = rows.filter((t) => t.transaction_date >= from);
    if (to) rows = rows.filter((t) => t.transaction_date <= to);
    if (merchant) rows = rows.filter((t) => t.merchant_name.toLowerCase().includes(merchant));
    if (category) rows = rows.filter((t) => t.merchant_category === category);
    rows.sort((a, b) => a.transaction_time.localeCompare(b.transaction_time));

    const total = rows.length;
    const transactions = rows.slice(0, pageSize).map((t) => ({
      transaction_uuid: t.spend_event_uuid,
      merchant_name: t.merchant_name,
      merchant_category: t.merchant_category,
      amount: centsToDisplay(t.amount_cents), // Ramp wire format: formatted string
      transaction_time: t.transaction_time,
      spent_by_user: nameByUuid.get(t.user_uuid) ?? null,
      reason_or_justification: t.reason_or_justification,
      spend_allocation_name: t.spend_program,
      state: "CLEARED",
      system_in_or_out_of_policy_assessment: t.policy_status === "out_of_policy" ? "OUT_OF_POLICY" : "IN_POLICY",
      transaction_link: `https://app.ramp.com/transactions/${t.spend_event_uuid}`,
    }));
    return {
      ok: true,
      data: {
        transactions,
        total_count: total,
        next_page_cursor: total > pageSize ? "cursor_2" : null,
        external_agent_messages: total > pageSize ? [`Returned ${pageSize} of ${total}; paginate for the rest.`] : [],
      },
    };
  }

  private searchVendors(args: Record<string, unknown>): ToolResult {
    const term = (args.search_term as string).toLowerCase();
    const limit = (args.limit as number | undefined) ?? 10;
    const matched = VENDORS.filter((v) => v.name.toLowerCase().includes(term));
    return {
      ok: true,
      data: {
        search_term: args.search_term,
        total_found: matched.length,
        vendors: matched.slice(0, limit),
        external_agent_messages: [],
      },
    };
  }

  private answerPolicy(args: Record<string, unknown>): ToolResult {
    const question = (args.question as string).toLowerCase();
    // Score by number of keyword hits and take the best match, so a meals
    // question ("client dinner over the limit?") isn't hijacked by a generic
    // word appearing in another policy. Ties break toward KB order.
    const ranked = POLICY_KB.map((e) => ({ e, score: e.keywords.filter((k) => question.includes(k)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const entry = ranked[0]?.e;
    const answer =
      entry?.answer ??
      "No specific policy rule matched. General guidance: business expenses must have a clear business purpose, a receipt, and stay within category limits; anything unusual should be pre-approved by a manager.";
    return { ok: true, data: { question: args.question, answer, external_agent_messages: [] } };
  }
}

/** Create a fresh fixture backend (fresh docs-handshake session) over the shared DuckDB. */
export function createFixtureBackend(artifact?: AnalystArtifact): RampToolSurface {
  return new FixtureBackend(artifact ?? getSharedArtifact());
}
