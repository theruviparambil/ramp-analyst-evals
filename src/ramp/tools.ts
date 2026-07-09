/**
 * The Ramp agent-tool registry.
 *
 * Names, descriptions, and parameter schemas mirror Ramp's public agent-tool
 * surface (agent-tools/execute-analyst-query, list-users, get-transactions,
 * search-vendors, answer-policy-question, and the analyst catalog/docs tools).
 * Every tool takes a required `rationale` — a non-empty string — exactly as the
 * real API does; omitting it is a validation error here just like a 422 there.
 *
 * Each tool is classified read vs write. The agent is only ever handed the READ
 * tools, and the eval asserts no write tool was called — the read-only invariant.
 * A single write tool (update_merchant_restrictions) is registered but not
 * exposed, so the classification is real and the invariant is testable.
 */

import { z } from "zod";
import { ANALYST_TABLE_NAMES } from "./analyst-db.js";

export type ToolKind = "read" | "write";

export interface ToolResult {
  ok: boolean;
  /** The tool's JSON response body (schema-faithful to the wire) when ok. */
  data?: unknown;
  /** A human/agent-readable error the model can act on when not ok. */
  error?: string;
}

/** Anything that can dispatch a named Ramp tool call. Fixture and live both implement this. */
export interface RampToolSurface {
  readonly mode: "fixture" | "live";
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ToolDef {
  name: string;
  kind: ToolKind;
  /** Whether the agent is offered this tool. Write tools are never exposed. */
  exposed: boolean;
  description: string;
  /** JSON Schema handed to the model for function-calling. */
  parameters: Record<string, unknown>;
  /** Runtime validator (validate tool args before executing — security floor). */
  argsSchema: z.ZodTypeAny;
}

const rationaleJson = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  description: "Briefly explain why you are calling this tool: the goal it serves and what you'll do with the result.",
};
const rationale = z.string().min(1, "rationale is required (non-empty)").max(1024);

function obj(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

export const TOOLS: ToolDef[] = [
  {
    name: "get_analyst_catalog",
    kind: "read",
    exposed: true,
    description:
      "Return Core-owned catalog metadata for the analyst artifact: which analyst.* tables exist, whether they are queryable, and starter SQL. Call this BEFORE drafting analyst SQL.",
    parameters: obj({ rationale: rationaleJson }, ["rationale"]),
    argsSchema: z.object({ rationale, artifact_instance_id: z.string().optional() }),
  },
  {
    name: "get_analyst_spend_facts_domain_docs",
    kind: "read",
    exposed: true,
    description:
      "Return semantic docs for analyst.spend_facts (grain, money/date columns, identity caveats, the un-normalized merchant_name caveat). Read this before writing SQL that touches spend_facts.",
    parameters: obj({ rationale: rationaleJson }, ["rationale"]),
    argsSchema: z.object({ rationale, artifact_instance_id: z.string().optional() }),
  },
  {
    name: "get_analyst_table_domain_docs",
    kind: "read",
    exposed: true,
    description:
      "Return semantic docs for one analyst table (columns, grain, join keys, caveats). Call once per analyst.* table your SQL will reference before executing.",
    parameters: obj(
      {
        qualified_name: { type: "string", enum: [...ANALYST_TABLE_NAMES], description: "The analyst.<table> whose docs to return." },
        rationale: rationaleJson,
      },
      ["qualified_name", "rationale"],
    ),
    argsSchema: z.object({ qualified_name: z.enum(ANALYST_TABLE_NAMES), rationale, artifact_instance_id: z.string().optional() }),
  },
  {
    name: "execute_analyst_query",
    kind: "read",
    exposed: true,
    description:
      "Run read-only DuckDB SQL against analyst.* tables. Prerequisite: in this session you must have called get_analyst_catalog and read domain docs for EVERY analyst.<table> the SQL references; otherwise this returns a docs_required response listing what to read (not an error). Qualify tables as analyst.<table>, qualify every column with its table/alias, put non-aggregated SELECT columns in GROUP BY, and use DATE 'YYYY-MM-DD' literals.",
    parameters: obj(
      {
        sql: { type: "string", description: "Read-only DuckDB SQL over analyst.* tables." },
        rationale: rationaleJson,
      },
      ["sql", "rationale"],
    ),
    argsSchema: z.object({ sql: z.string().min(1), rationale, artifact_instance_id: z.string().optional() }),
  },
  {
    name: "get_all_reduced_users",
    kind: "read",
    exposed: true,
    description: "List and search users across the business. Supports name_search (partial, case-insensitive) and pagination. Returns active and inactive users (check is_inactive).",
    parameters: obj(
      {
        name_search: { type: "string", description: "Partial, case-insensitive name filter." },
        page_size: { type: "integer", minimum: 1, maximum: 100, description: "Users per page (default 20)." },
        rationale: rationaleJson,
      },
      ["rationale"],
    ),
    argsSchema: z.object({ name_search: z.string().nullish(), page_size: z.number().int().min(1).max(100).optional(), rationale }),
  },
  {
    name: "get_user_transactions",
    kind: "read",
    exposed: true,
    description:
      "Search individual card transactions (amounts are formatted strings like \"$1,048.25\"). Use analyst tools for aggregates/group-bys; use this for transaction-level lookup. Supports from_date/to_date and a merchant/category text search.",
    parameters: obj(
      {
        from_date: { type: "string", description: "Inclusive start date YYYY-MM-DD." },
        to_date: { type: "string", description: "Inclusive end date YYYY-MM-DD." },
        merchant_search: { type: "string", description: "Case-insensitive merchant name substring." },
        merchant_category: { type: "string", description: "Exact merchant category filter." },
        page_size: { type: "integer", minimum: 1, maximum: 200, description: "Max transactions (default 50)." },
        rationale: rationaleJson,
      },
      ["rationale"],
    ),
    argsSchema: z.object({
      from_date: z.string().nullish(),
      to_date: z.string().nullish(),
      merchant_search: z.string().nullish(),
      merchant_category: z.string().nullish(),
      page_size: z.number().int().min(1).max(200).optional(),
      rationale,
    }),
  },
  {
    name: "search_vendors",
    kind: "read",
    exposed: true,
    description: "Search vendors (payees) by name (fuzzy). Returns vendor id, name, is_draft. Use to find a vendor or spot spelling variants of the same vendor.",
    parameters: obj(
      {
        search_term: { type: "string", description: "Vendor name or partial name." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max vendors (default 10)." },
        rationale: rationaleJson,
      },
      ["search_term", "rationale"],
    ),
    argsSchema: z.object({ search_term: z.string().min(1), limit: z.number().int().min(1).max(50).optional(), rationale }),
  },
  {
    name: "answer_policy_question",
    kind: "read",
    exposed: true,
    description: "Ask the expense policy: spending limits, restrictions, what's allowed. Returns a natural-language answer.",
    parameters: obj(
      {
        question: { type: "string", description: "The policy question." },
        include_restrictions: { type: "boolean", description: "Include restriction detail (default true)." },
        rationale: rationaleJson,
      },
      ["question", "rationale"],
    ),
    argsSchema: z.object({ question: z.string().min(1), include_restrictions: z.boolean().optional(), rationale }),
  },
  // ── Write tool — registered for classification, never exposed to the agent ──
  {
    name: "update_merchant_restrictions",
    kind: "write",
    exposed: false,
    description: "(WRITE) Update card merchant restrictions. Disabled in this read-only analyst demo.",
    parameters: obj({ rationale: rationaleJson }, ["rationale"]),
    argsSchema: z.object({ rationale }).passthrough(),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getToolDef(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

export function isWriteTool(name: string): boolean {
  return BY_NAME.get(name)?.kind === "write";
}

/** The read tools the agent is offered, as OpenAI/Anthropic-style function defs. */
export function agentToolDefs(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return TOOLS.filter((t) => t.exposed && t.kind === "read").map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export const READ_TOOL_NAMES = TOOLS.filter((t) => t.kind === "read").map((t) => t.name);
export const WRITE_TOOL_NAMES = TOOLS.filter((t) => t.kind === "write").map((t) => t.name);
