/**
 * Trajectory assertions — "grade the reasoning path, not just the answer."
 *
 * The final number can be right for the wrong reasons (a lucky guess, a cached
 * figure, a write that happened to not matter). These checks inspect the
 * intermediate tool calls: did the agent consult the catalog before querying,
 * did it read domain docs for the tables it referenced, did it stay read-only,
 * and did it converge without thrashing.
 */

import { referencedTables, ANALYST_TABLE_NAMES } from "../ramp/analyst-db.js";
import type { Trajectory } from "../agent/types.js";
import type { CheckContext, CheckOutcome } from "./checkers.js";

function firstIndexOf(trajectory: Trajectory, name: string, okOnly = false): number {
  const step = trajectory.steps.find((s) => s.name === name && (!okOnly || s.ok));
  return step ? step.index : -1;
}

/** The catalog was read before the first successful analyst query. */
export function catalogBeforeQuery(ctx: CheckContext): CheckOutcome {
  const { trajectory } = ctx;
  const firstQuery = trajectory.steps.find((s) => s.name === "execute_analyst_query" && s.ok && (s.resultSummary as { status?: string })?.status === "success");
  if (!firstQuery) return { pass: false, detail: "no successful analyst query to check ordering against" };
  const catalogIdx = firstIndexOf(trajectory, "get_analyst_catalog");
  return catalogIdx >= 0 && catalogIdx < firstQuery.index
    ? { pass: true, detail: `catalog@${catalogIdx} before query@${firstQuery.index}` }
    : { pass: false, detail: `catalog not read before first successful query@${firstQuery.index}` };
}

/** Domain docs were read for every analyst table referenced by the first successful query. */
export function docsBeforeQuery(ctx: CheckContext): CheckOutcome {
  const { trajectory } = ctx;
  const firstQuery = trajectory.steps.find((s) => s.name === "execute_analyst_query" && s.ok && (s.resultSummary as { status?: string })?.status === "success");
  if (!firstQuery) return { pass: false, detail: "no successful analyst query" };
  const sql = typeof firstQuery.args?.sql === "string" ? firstQuery.args.sql : "";
  const referenced = referencedTables(sql).filter((t) => (ANALYST_TABLE_NAMES as readonly string[]).includes(t));

  const docsReadBefore = new Set<string>();
  for (const s of trajectory.steps) {
    if (s.index >= firstQuery.index) break;
    if (s.name === "get_analyst_spend_facts_domain_docs") docsReadBefore.add("analyst.spend_facts");
    if (s.name === "get_analyst_table_domain_docs" && typeof s.args?.qualified_name === "string") docsReadBefore.add(s.args.qualified_name);
  }
  const missing = referenced.filter((t) => !docsReadBefore.has(t));
  return missing.length === 0
    ? { pass: true, detail: `docs read for ${referenced.join(", ") || "(no analyst tables)"} before query` }
    : { pass: false, detail: `queried ${missing.join(", ")} without reading its docs first` };
}

/** No write tool anywhere in the path (the read-only guarantee, path view). */
export function readOnlyPath(ctx: CheckContext): CheckOutcome {
  const writes = ctx.trajectory.steps.filter((s) => s.kind === "write");
  return writes.length === 0
    ? { pass: true, detail: "read-only throughout" }
    : { pass: false, detail: `write calls: ${writes.map((s) => s.name).join(", ")}` };
}

/** The agent converged: analyst-query attempts stayed at or below `max`. */
export function queryAttemptsWithin(ctx: CheckContext, max: number): CheckOutcome {
  const attempts = ctx.trajectory.steps.filter((s) => s.name === "execute_analyst_query").length;
  return attempts <= max
    ? { pass: true, detail: `${attempts} query attempt(s) (≤ ${max})` }
    : { pass: false, detail: `${attempts} query attempts (> ${max}) — thrashing` };
}

/** The agent finished (did not hit the tool-call budget cap). */
export function converged(ctx: CheckContext): CheckOutcome {
  return ctx.trajectory.hitStepCap
    ? { pass: false, detail: "hit the tool-call budget without finishing" }
    : { pass: true, detail: "converged within budget" };
}
