/**
 * The golden set — 12 finance questions over the fixture.
 *
 * Correctness is graded on a STRUCTURED answer, not free-text. Each question
 * tells the agent to emit a small JSON block, and req.value compares that block
 * for set/vector/scalar EQUALITY against the independent oracle
 * (../fixture/ground-truth). That closes the substring false-negative: "no
 * duplicates, $8,400 is the normal monthly charge" no longer passes q04, because
 * its `duplicates: []` fails set-containment against the planted pair.
 *
 * Tiers (Hebbia framing): REQUIRED = the SLA; ADDITIONAL = headroom. Criteria are
 * also tagged INVARIANT (surface-enforced — cannot fail when the tool surface
 * behaves) vs OBSERVED (real agent behavior a lazy/wrong agent can fail), so the
 * report never dresses a harness guarantee up as model virtue.
 */

import * as GT from "../fixture/ground-truth.js";
import {
  answerMentionsAny,
  citedMethod,
  everyCallHasRationale,
  groundedIn,
  moneyFormatted,
  readOnly,
} from "./checkers.js";
import {
  aggregatedInSql,
  catalogBeforeQuery,
  converged,
  docsBeforeQuery,
  noRedundantRefetch,
  queryAttemptsWithin,
} from "./trajectory.js";
import {
  structIntEquals,
  structItemsContain,
  structItemsExact,
  structScalarUsd,
  structStringIncludes,
  structStringSet,
  structTopEntry,
  structVectorUsd,
} from "./structured.js";
import { centsToDisplay } from "../money.js";
import { det, judged, type Criterion, type GoldenQuestion } from "./spec.js";

const fmt = centsToDisplay;

const jsonBlock = (shape: string): string =>
  `Write a brief explanation in prose, then end your message with a single fenced JSON code block with exactly this shape (numbers as plain numbers — no $ signs, no commas):\n\`\`\`json\n${shape}\n\`\`\``;

// Required SLAs shared by every question. read_only and rationale are
// surface-enforced invariants (the surface never exposes a write tool and
// rejects a call without a rationale). grounded is observed, not invariant:
// it fails when the agent answers without ever landing a successful query.
const baseRequired = (grounding: string): Criterion[] => [
  det("req.read_only", "required", "Read-only — no write tool was called", readOnly, "invariant"),
  det("req.rationale", "required", "Every tool call carried a rationale", everyCallHasRationale, "invariant"),
  det("req.grounded", "required", `Grounded in a successful ${grounding} call`, (c) => groundedIn(c, grounding), "observed"),
];

// Additional headroom shared by most questions.
const baseAdditional = (analyst: boolean): Criterion[] => [
  det("add.money_format", "additional", "Money formatted Ramp-style in prose", moneyFormatted, "observed"),
  det("add.cited_method", "additional", "Explained which query/tool produced the number", citedMethod, "observed"),
  det("add.converged", "additional", "Converged within the tool-call budget", converged, "observed"),
  det("add.no_refetch", "additional", "No redundant re-fetches (same doc/query twice)", noRedundantRefetch, "observed"),
  ...(analyst
    ? [
        det("add.aggregated_in_sql", "additional", "Aggregated in SQL, not by scanning raw transactions", (c) => aggregatedInSql(c), "observed"),
        det("path.catalog_before_query", "additional", "Consulted the catalog before querying", catalogBeforeQuery, "observed"),
        det("path.docs_before_query", "additional", "Read domain docs for referenced tables before querying", docsBeforeQuery, "observed"),
        det("path.attempts", "additional", "Converged in ≤ 4 analyst-query attempts", (c) => queryAttemptsWithin(c, 4), "observed"),
      ]
    : []),
];

export const GOLDEN: GoldenQuestion[] = [
  {
    id: "q01_total_net_spend",
    question: "What was Vela Robotics' total net card spend in Q2 2026 (April 1 – June 30), after refunds?",
    expected: `Net card spend = ${fmt(GT.netCents)} (gross ${fmt(GT.grossCents)} minus ${fmt(-GT.refundCents)} of refunds).`,
    answerInstructions: jsonBlock(`{"net_spend_usd": <number>}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Net total = ${fmt(GT.netCents)}`, (c) => structScalarUsd(c, "net_spend_usd", GT.netCents), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", `The prose states the total net Q2 card spend and matches ${fmt(GT.netCents)}; it invents no unsupported numbers.`),
    ],
  },
  {
    id: "q02_top_vendor",
    question: "Which vendor did we spend the most with in Q2, and how much?",
    expected: `Top vendor: ${GT.topVendor.key} at ${fmt(GT.topVendor.cents)} (canonical vendor totals).`,
    answerInstructions: jsonBlock(`{"top_vendor": {"name": <string>, "spend_usd": <number>}}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Top vendor = ${GT.topVendor.key} @ ${fmt(GT.topVendor.cents)}`, (c) => structTopEntry(c, "top_vendor", "name", "spend_usd", GT.topVendor.key, GT.topVendor.cents), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", `The answer identifies ${GT.topVendor.key} as the top vendor at about ${fmt(GT.topVendor.cents)}, grounded in a query result.`),
    ],
  },
  {
    id: "q03_spend_by_department",
    question: "Break down Q2 spend by department. Which department spent the most, and how much?",
    expected: `Top: ${GT.topDepartment.key} at ${fmt(GT.topDepartment.cents)}. Full ranking across ${GT.departmentSpend.length} departments.`,
    answerInstructions: jsonBlock(`{"top_department": {"name": <string>, "spend_usd": <number>}, "by_department": [{"department": <string>, "spend_usd": <number>}, ... one row per department]}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Top department = ${GT.topDepartment.key} @ ${fmt(GT.topDepartment.cents)}`, (c) => structTopEntry(c, "top_department", "name", "spend_usd", GT.topDepartment.key, GT.topDepartment.cents), "observed"),
      det("add.full_vector", "additional", `Full ${GT.departmentSpend.length}-department vector matches`, (c) => structVectorUsd(c, "by_department", "department", "spend_usd", GT.departmentSpend.map((d) => ({ key: d.key, cents: d.cents }))), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", `The answer ranks departments and names ${GT.topDepartment.key} as top at about ${fmt(GT.topDepartment.cents)}.`),
    ],
  },
  {
    id: "q04_duplicate_charge",
    question: "Are there any duplicate charges from Q2 we should investigate?",
    expected: `One material duplicate: Datadog ${fmt(GT.duplicatePairs[0]!.amount_cents)} charged on ${GT.duplicatePairs[0]!.dates[0]} and ${GT.duplicatePairs[0]!.dates[1]} — a likely double-charge of the recurring monthly bill (NOT the normal monthly charge).`,
    answerInstructions: jsonBlock(`{"duplicates": [{"merchant": <string>, "amount_usd": <number>, "dates": ["YYYY-MM-DD", "YYYY-MM-DD"]}]}  // empty array if there are none`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Flags the Datadog ${fmt(GT.duplicatePairs[0]!.amount_cents)} duplicate`, (c) => structItemsContain(c, "duplicates", "merchant", "amount_usd", [{ merchant: "Datadog", cents: GT.duplicatePairs[0]!.amount_cents }]), "observed"),
      det("add.dates", "additional", "Cites both charge dates", (c) => structItemsContain(c, "duplicates", "merchant", "amount_usd", [{ merchant: "Datadog", cents: GT.duplicatePairs[0]!.amount_cents, dates: [...GT.duplicatePairs[0]!.dates] }]), "observed"),
      det("add.exact", "additional", "Reports exactly the one real duplicate (no false positives)", (c) => structItemsExact(c, "duplicates", "merchant", "amount_usd", [{ merchant: "Datadog", cents: GT.duplicatePairs[0]!.amount_cents, dates: [...GT.duplicatePairs[0]!.dates] }]), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Flagged the anomaly correctly", "The answer flags the Datadog $8,400.00 charge appearing twice within days as a probable double-charge of the recurring monthly bill, not as normal recurring spend."),
    ],
  },
  {
    id: "q05_vendor_variant",
    question: "How much did we spend with Delta in Q2 in total?",
    expected: `Combined Delta spend = ${fmt(GT.deltaCombinedCents)}, across two un-normalized spellings: ${GT.deltaVariants.join(" and ")}.`,
    answerInstructions: jsonBlock(`{"combined_spend_usd": <number>, "variants": [<string>, ... every raw merchant spelling you combined]}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Combined Delta spend = ${fmt(GT.deltaCombinedCents)} (must sum both spellings)`, (c) => structScalarUsd(c, "combined_spend_usd", GT.deltaCombinedCents), "observed"),
      det("add.variants", "additional", "Names both spelling variants", (c) => structStringSet(c, "variants", GT.deltaVariants), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Caught the vendor variant", `The answer reports combined Delta spend of ${fmt(GT.deltaCombinedCents)} and flags that it spans two spelling variants (${GT.deltaVariants.join(" and ")}) that are the same airline.`),
    ],
  },
  {
    id: "q06_out_of_policy",
    question: "Were there any out-of-policy transactions in Q2? If so, which and why?",
    expected: `One: ${GT.outOfPolicy[0]!.merchant_name} ${fmt(GT.outOfPolicy[0]!.amount_cents)} by ${GT.outOfPolicy[0]!.user_name} on ${GT.outOfPolicy[0]!.date} — a meal above the $500 single-transaction cap.`,
    answerInstructions: jsonBlock(`{"out_of_policy": [{"merchant": <string>, "amount_usd": <number>}]}  // empty array if none`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Flags the ${GT.outOfPolicy[0]!.merchant_name} ${fmt(GT.outOfPolicy[0]!.amount_cents)} charge`, (c) => structItemsContain(c, "out_of_policy", "merchant", "amount_usd", [{ merchant: GT.outOfPolicy[0]!.merchant_name, cents: GT.outOfPolicy[0]!.amount_cents }]), "observed"),
      det("add.exact", "additional", "Reports exactly the one out-of-policy charge", (c) => structItemsExact(c, "out_of_policy", "merchant", "amount_usd", GT.outOfPolicy.map((o) => ({ merchant: o.merchant_name, cents: o.amount_cents }))), "observed"),
      det("add.policy_cited", "additional", "Cites the actual $500 meals cap value", (c) => answerMentionsAny(c, ["$500", "500"]), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Explained the violation", `The answer identifies the ${GT.outOfPolicy[0]!.merchant_name} dinner of ${fmt(GT.outOfPolicy[0]!.amount_cents)} as out-of-policy and explains it breaches the meals policy (single transactions over $500 need approval).`),
    ],
  },
  {
    id: "q07_mom_spike",
    question: "Which spend category had the biggest month-over-month increase in Q2, and by how much?",
    expected: `${GT.biggestSpike.category}: ${fmt(GT.biggestSpike.fromCents)} (May) to ${fmt(GT.biggestSpike.toCents)} (June), +${fmt(GT.biggestSpike.deltaCents)} (${GT.biggestSpike.ratio.toFixed(1)}x), driven by ${GT.biggestSpike.driverMerchant}.`,
    answerInstructions: jsonBlock(`{"spike": {"category": <string>, "from_usd": <number>, "to_usd": <number>, "increase_usd": <number>, "ratio": <number>}}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.category", "required", `Category = ${GT.biggestSpike.category}`, (c) => structStringIncludes(c, "spike.category", GT.biggestSpike.category), "observed"),
      det("req.value", "required", `June total = ${fmt(GT.biggestSpike.toCents)}`, (c) => structScalarUsd(c, "spike.to_usd", GT.biggestSpike.toCents), "observed"),
      det("add.increase", "additional", `Increase = ${fmt(GT.biggestSpike.deltaCents)}`, (c) => structScalarUsd(c, "spike.increase_usd", GT.biggestSpike.deltaCents), "observed"),
      det("add.driver", "additional", "Names the driver vendor in prose", (c) => answerMentionsAny(c, [GT.biggestSpike.driverMerchant]), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Explained the spike", `The answer names ${GT.biggestSpike.category} (May ${fmt(GT.biggestSpike.fromCents)} to June ${fmt(GT.biggestSpike.toCents)}) and characterizes the magnitude (~4x / +${fmt(GT.biggestSpike.deltaCents)}).`),
    ],
  },
  {
    id: "q08_top_spender",
    question: "Who was the top spender by card in Q2, and how much did they spend?",
    expected: `${GT.topSpender.key} at ${fmt(GT.topSpender.cents)}.`,
    answerInstructions: jsonBlock(`{"top_spender": {"name": <string>, "spend_usd": <number>}}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Top spender = ${GT.topSpender.key} @ ${fmt(GT.topSpender.cents)}`, (c) => structTopEntry(c, "top_spender", "name", "spend_usd", GT.topSpender.key, GT.topSpender.cents), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", `The answer names ${GT.topSpender.key} as the top spender at about ${fmt(GT.topSpender.cents)}.`),
    ],
  },
  {
    id: "q09_software_total",
    question: "How much did we spend on SaaS / software in Q2?",
    expected: `SaaS / Software category total = ${fmt(GT.categoryTotalCents("SaaS / Software"))}.`,
    answerInstructions: jsonBlock(`{"software_spend_usd": <number>}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Software total = ${fmt(GT.categoryTotalCents("SaaS / Software"))}`, (c) => structScalarUsd(c, "software_spend_usd", GT.categoryTotalCents("SaaS / Software")), "observed"),
      det("add.top_vendors", "additional", "Names a leading software vendor in prose", (c) => answerMentionsAny(c, ["Datadog", "GitHub", "Figma"]), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", `The answer states SaaS/software spend of about ${fmt(GT.categoryTotalCents("SaaS / Software"))} for Q2.`),
    ],
  },
  {
    id: "q10_refunds",
    question: "Were there any refunds this quarter, and what is gross versus net card spend?",
    expected: `2 refunds totaling ${fmt(-GT.refundCents)}. Gross ${fmt(GT.grossCents)}, net ${fmt(GT.netCents)}.`,
    answerInstructions: jsonBlock(`{"gross_usd": <number>, "net_usd": <number>, "refunds_usd": <number>, "refund_count": <number>}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Net = ${fmt(GT.netCents)}`, (c) => structScalarUsd(c, "net_usd", GT.netCents), "observed"),
      det("req.refunds", "required", "Refund count = 2", (c) => structIntEquals(c, "refund_count", 2), "observed"),
      det("add.gross", "additional", `Gross = ${fmt(GT.grossCents)}`, (c) => structScalarUsd(c, "gross_usd", GT.grossCents), "observed"),
      det("add.refund_total", "additional", `Refund total = ${fmt(-GT.refundCents)}`, (c) => structScalarUsd(c, "refunds_usd", -GT.refundCents), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Separated gross and net", `The answer distinguishes gross (${fmt(GT.grossCents)}) from net (${fmt(GT.netCents)}) and notes the ${fmt(-GT.refundCents)} of refunds netted out.`),
    ],
  },
  {
    id: "q11_open_bills",
    question: "How much do we currently owe in unpaid (open) bills?",
    expected: `Open AP bills = ${fmt(GT.openBillsCents)} across ${GT.openBillCount} bills. (Paid so far: ${fmt(GT.paidBillsCents)}.)`,
    answerInstructions: jsonBlock(`{"open_bills_usd": <number>, "open_bill_count": <number>}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Open bills = ${fmt(GT.openBillsCents)}`, (c) => structScalarUsd(c, "open_bills_usd", GT.openBillsCents), "observed"),
      det("add.count", "additional", `Open bill count = ${GT.openBillCount}`, (c) => structIntEquals(c, "open_bill_count", GT.openBillCount), "observed"),
      det("add.separates", "additional", "Distinguishes open from paid in prose", (c) => answerMentionsAny(c, ["open", "unpaid", "outstanding"]), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", `The answer states outstanding/open AP bills total ${fmt(GT.openBillsCents)}, and does not conflate bills with card spend.`),
    ],
  },
  {
    id: "q12_active_users",
    question: "How many active users do we have, and what is the average Q2 card spend per active user?",
    expected: `${GT.activeUserCount} active users (of ${GT.activeUserCount + GT.inactiveUserCount}); average net spend per active user = ${fmt(GT.avgSpendPerActiveUserCents)}.`,
    answerInstructions: jsonBlock(`{"active_users": <number>, "avg_spend_per_active_user_usd": <number>}`),
    criteria: [
      det("req.read_only", "required", "Read-only — no write tool was called", readOnly, "invariant"),
      det("req.rationale", "required", "Every tool call carried a rationale", everyCallHasRationale, "invariant"),
      det("req.grounded", "required", "Grounded in a successful data tool call", (c) => (groundedIn(c, "execute_analyst_query").pass || groundedIn(c, "get_all_reduced_users").pass ? { pass: true, detail: "grounded" } : { pass: false, detail: "no successful users/analyst call" }), "invariant"),
      det("req.value", "required", `Active users = ${GT.activeUserCount}`, (c) => structIntEquals(c, "active_users", GT.activeUserCount), "observed"),
      det("add.avg_value", "additional", `Average per active user = ${fmt(GT.avgSpendPerActiveUserCents)}`, (c) => structScalarUsd(c, "avg_spend_per_active_user_usd", GT.avgSpendPerActiveUserCents, 0.01), "observed"),
      det("add.money_format", "additional", "Money formatted Ramp-style in prose", moneyFormatted, "observed"),
      det("add.converged", "additional", "Converged within budget", converged, "observed"),
      det("add.no_refetch", "additional", "No redundant re-fetches", noRedundantRefetch, "observed"),
      judged("add.faithful", "additional", "Excluded inactive users", `The answer reports ${GT.activeUserCount} active users (excluding the 2 inactive) and an average per-active-user spend near ${fmt(GT.avgSpendPerActiveUserCents)}.`),
    ],
  },
];
