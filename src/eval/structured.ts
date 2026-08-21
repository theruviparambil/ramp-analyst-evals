/**
 * Structured-answer grading.
 *
 * Substring grading is a coinflip: "$8,400" is both the planted duplicate AND
 * Datadog's legit monthly charge, so a confidently-wrong "no duplicates, $8,400
 * is normal" would pass a substring check. To close that, every question asks
 * the agent to emit a machine-readable JSON block alongside its prose, and we
 * grade that block for set / vector / scalar EQUALITY against the independent
 * oracle in ../fixture/ground-truth. This is what makes the oracle load-bearing
 * and turns req.value into a real discriminator.
 */

import { dollarsToCents } from "../money.js";
import type { CheckContext, CheckOutcome } from "./checkers.js";

/** Pull the last fenced ```json block (or a trailing bare object) and parse it. */
export function parseStructured(finalAnswer: string): Record<string, unknown> | null {
  const fenced = [...finalAnswer.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const candidates = fenced.length ? [fenced[fenced.length - 1]![1]!] : [];
  if (candidates.length === 0) {
    const m = finalAnswer.match(/\{[\s\S]*\}/); // last-ditch: a bare object
    if (m) candidates.push(m[0]);
  }
  for (const c of candidates) {
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  return null;
}

const NO_JSON: CheckOutcome = { pass: false, detail: "no valid JSON answer block emitted" };

/**
 * The oracle is exact integer cents, so there is no measurement error to absorb:
 * tolerance is absolute and stated in cents, never a fraction. A fractional
 * tolerance silently scales with the magnitude of the answer -- the old 0.0005
 * bought +/-$94.46 of slack on the $188,925.60 net-spend question, which is
 * larger than most of the planted anomalies this suite is built to detect.
 */
function moneyClose(aCents: number, bCents: number, tolCents = 2): boolean {
  return Math.abs(aCents - bCents) <= tolCents;
}

const asNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/[$,]/g, "")))
      ? Number(v.replace(/[$,]/g, ""))
      : null;
const usdToCents = (v: unknown): number | null => {
  const n = asNumber(v);
  return n === null ? null : dollarsToCents(n);
};
const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();

/**
 * Entity names are compared for EQUALITY after normalization, not by substring.
 * Substring matching in either direction is not a weak check, it is a broken
 * one: `"a"` is a substring of every merchant in the fixture, so a one-letter
 * answer used to score a correct vendor, department, spender and category.
 *
 * Normalization strips a trailing parenthetical ("Google Ads (Advertising)"),
 * punctuation, corporate suffixes, and repeated whitespace, so an agent is not
 * failed for cosmetics. Anything beyond that needs an explicit alias below.
 */
const CORPORATE_SUFFIX = /\b(inc|llc|ltd|corp|co|plc|gmbh|sa|nv)\b/g;

const canonicalName = (v: unknown): string =>
  norm(v)
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[.,'"`]/g, "")
    .replace(CORPORATE_SUFFIX, "")
    .replace(/\s+/g, " ")
    .trim();

/** Renderings that are genuinely the same entity, not just formatted differently. */
const NAME_ALIASES: ReadonlyArray<ReadonlyArray<string>> = [
  ["amazon web services", "aws"],
  ["google ads", "google adwords", "google advertising"],
  ["delta air lines", "delta airlines"],
];

const ALIAS_INDEX: ReadonlyMap<string, number> = new Map(
  NAME_ALIASES.flatMap((group, i) => group.map((name) => [name, i] as const)),
);

export function nameMatches(got: unknown, expected: string): boolean {
  const a = canonicalName(got);
  const b = canonicalName(expected);
  if (a === "" || b === "") return false;
  if (a === b) return true;
  const ga = ALIAS_INDEX.get(a);
  return ga !== undefined && ga === ALIAS_INDEX.get(b);
}

/** Resolve a dotted path ("spike.to_usd") within the parsed object. */
function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

// ─── Scalar (dotted path) ─────────────────────────────────────────────────────

export function structScalarUsd(ctx: CheckContext, path: string, expectedCents: number, tolCents = 2): CheckOutcome {
  const s = parseStructured(ctx.finalAnswer);
  if (!s) return NO_JSON;
  const cents = usdToCents(getPath(s, path));
  if (cents === null) return { pass: false, detail: `missing numeric "${path}"` };
  return moneyClose(cents, expectedCents, tolCents)
    ? { pass: true, detail: `${path}=${(cents / 100).toFixed(2)} == ${(expectedCents / 100).toFixed(2)}` }
    : { pass: false, detail: `${path}=${(cents / 100).toFixed(2)} != expected ${(expectedCents / 100).toFixed(2)}` };
}

export function structIntEquals(ctx: CheckContext, path: string, expected: number): CheckOutcome {
  const s = parseStructured(ctx.finalAnswer);
  if (!s) return NO_JSON;
  const n = asNumber(getPath(s, path));
  if (n === null) return { pass: false, detail: `missing numeric "${path}"` };
  return Math.round(n) === expected ? { pass: true, detail: `${path}=${n} == ${expected}` } : { pass: false, detail: `${path}=${n} != ${expected}` };
}

export function structStringIncludes(ctx: CheckContext, path: string, expected: string): CheckOutcome {
  const s = parseStructured(ctx.finalAnswer);
  if (!s) return NO_JSON;
  const raw = getPath(s, path);
  return nameMatches(raw, expected)
    ? { pass: true, detail: `${path}="${norm(raw)}" == "${expected}"` }
    : { pass: false, detail: `${path}="${norm(raw)}" != "${expected}"` };
}

// ─── Top entry {name, value} ──────────────────────────────────────────────────

export function structTopEntry(ctx: CheckContext, obj: string, nameField: string, valueField: string, expectedName: string, expectedCents: number): CheckOutcome {
  const s = parseStructured(ctx.finalAnswer);
  if (!s) return NO_JSON;
  const entry = getPath(s, obj);
  if (!entry || typeof entry !== "object") return { pass: false, detail: `missing object "${obj}"` };
  const e = entry as Record<string, unknown>;
  const nameOk = nameMatches(e[nameField], expectedName);
  const cents = usdToCents(e[valueField]);
  const valueOk = cents !== null && moneyClose(cents, expectedCents);
  if (nameOk && valueOk) return { pass: true, detail: `${expectedName} @ ${(expectedCents / 100).toFixed(2)}` };
  return { pass: false, detail: `name=${String(e[nameField])} (${nameOk ? "ok" : "wrong"}), value=${cents === null ? "?" : (cents / 100).toFixed(2)} (${valueOk ? "ok" : "wrong, want " + (expectedCents / 100).toFixed(2)})` };
}

// ─── Vector (set of {key -> value}) ───────────────────────────────────────────

export function structVectorUsd(ctx: CheckContext, arrayField: string, keyField: string, valueField: string, expected: Array<{ key: string; cents: number }>): CheckOutcome {
  const s = parseStructured(ctx.finalAnswer);
  if (!s) return NO_JSON;
  const arr = getPath(s, arrayField);
  if (!Array.isArray(arr)) return { pass: false, detail: `missing array "${arrayField}"` };
  const got = new Map<string, number>();
  for (const row of arr) {
    if (row && typeof row === "object") {
      const cents = usdToCents((row as Record<string, unknown>)[valueField]);
      if (cents !== null) got.set(norm((row as Record<string, unknown>)[keyField]), cents);
    }
  }
  const missing = expected.filter((e) => {
    const c = got.get(norm(e.key));
    return c === undefined || !moneyClose(c, e.cents);
  });
  return missing.length === 0 && got.size === expected.length
    ? { pass: true, detail: `all ${expected.length} entries match` }
    : { pass: false, detail: `mismatch: ${missing.map((m) => m.key).join(", ") || "extra/missing rows"} (got ${got.size}, want ${expected.length})` };
}

// ─── Item sets (duplicates, flagged transactions) ─────────────────────────────

export interface ExpectedItem {
  merchant: string;
  cents: number;
  dates?: string[];
}

interface GotItem {
  merchant: string;
  cents: number;
  dates: string[];
}

function readItems(ctx: CheckContext, field: string, merchantKey: string, amountKey: string): GotItem[] | null {
  const s = parseStructured(ctx.finalAnswer);
  if (!s) return null;
  const arr = getPath(s, field);
  if (!Array.isArray(arr)) return null;
  return arr
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      merchant: norm(r[merchantKey]),
      cents: usdToCents(r[amountKey]) ?? Number.NaN,
      dates: Array.isArray(r.dates) ? (r.dates as unknown[]).map((d) => String(d).slice(0, 10)).sort() : [],
    }));
}

function itemMatches(got: GotItem, exp: ExpectedItem): boolean {
  if (!nameMatches(got.merchant, exp.merchant)) return false;
  if (!moneyClose(got.cents, exp.cents)) return false;
  if (exp.dates && exp.dates.length) {
    // Set EQUALITY, not containment. The fixture holds four Datadog charges of
    // $8,400 in Q2 and only the (05-12, 05-15) pair is the double-charge, so a
    // recall-only date check would accept an answer that dragged the two legit
    // monthly charges in alongside it.
    const want = [...exp.dates].map((d) => d.slice(0, 10)).sort();
    return want.length === got.dates.length && want.every((d, i) => d === got.dates[i]);
  }
  return true;
}

/** Every expected item appears in the answer set (recall). */
export function structItemsContain(ctx: CheckContext, field: string, merchantKey: string, amountKey: string, expected: ExpectedItem[]): CheckOutcome {
  const got = readItems(ctx, field, merchantKey, amountKey);
  if (got === null) return { pass: false, detail: `no valid JSON array "${field}"` };
  const missing = expected.filter((e) => !got.some((g) => itemMatches(g, e)));
  return missing.length === 0
    ? { pass: true, detail: `all ${expected.length} expected item(s) present` }
    : { pass: false, detail: `missing: ${missing.map((m) => `${m.merchant} $${(m.cents / 100).toFixed(2)}`).join("; ") || "none reported"}` };
}

export interface ExactOptions {
  /**
   * A MATERIALITY FLOOR, in cents. Reported items below it are neither credited
   * nor penalized.
   *
   * This exists because the fixture is generated, and generated spend collides:
   * Q2 contains one coincidental pair of identical $35.93 Uber charges seven
   * days apart alongside the planted $8,400 Datadog double-charge. That pair is
   * REAL. An agent that surfaces it has observed the data correctly, and failing
   * it for precision would be grading luck, not capability.
   *
   * Silently forgiving it would be worse, though: then a fabricated $1,200 item
   * would be forgiven too. So the floor is explicit, stated to the agent in the
   * question, and applied symmetrically. Materiality thresholds are how audit
   * scopes work in this domain, which is why this is a rule rather than a patch.
   */
  ignoreBelowCents?: number;
}

/** The answer set equals the expected set exactly (recall AND precision). */
export function structItemsExact(ctx: CheckContext, field: string, merchantKey: string, amountKey: string, expected: ExpectedItem[], opts: ExactOptions = {}): CheckOutcome {
  const got = readItems(ctx, field, merchantKey, amountKey);
  if (got === null) return { pass: false, detail: `no valid JSON array "${field}"` };
  const floor = opts.ignoreBelowCents ?? 0;
  // NaN (an unparseable amount) must not slip under the floor as "immaterial".
  const material = got.filter((g) => !(Number.isFinite(g.cents) && Math.abs(g.cents) < floor));
  const ignored = got.length - material.length;
  const missing = expected.filter((e) => !material.some((g) => itemMatches(g, e)));
  const spurious = material.filter((g) => !expected.some((e) => itemMatches(g, e)));
  const note = ignored ? `, ${ignored} below the $${(floor / 100).toFixed(2)} materiality floor (ignored)` : "";
  return missing.length === 0 && spurious.length === 0
    ? { pass: true, detail: `exact set of ${expected.length}${note}` }
    : { pass: false, detail: `missing ${missing.length}, spurious ${spurious.length}${note}` };
}

// ─── String set (vendor variants) ─────────────────────────────────────────────

export function structStringSet(ctx: CheckContext, field: string, expected: string[]): CheckOutcome {
  const s = parseStructured(ctx.finalAnswer);
  if (!s) return NO_JSON;
  const arr = getPath(s, field);
  if (!Array.isArray(arr)) return { pass: false, detail: `missing array "${field}"` };
  const got = new Set(arr.map((x) => norm(x)));
  const missing = expected.filter((e) => !got.has(norm(e)));
  return missing.length === 0
    ? { pass: true, detail: `contains ${expected.join(", ")}` }
    : { pass: false, detail: `missing variant(s): ${missing.join(", ")}` };
}
