/**
 * The golden set: 12 finance questions over the fixture.
 *
 * Correctness is graded on a STRUCTURED answer, not free-text. Each question
 * tells the agent to emit a small JSON block, and req.value compares that block
 * for set/vector/scalar EQUALITY against the independent oracle
 * (../fixture/ground-truth). That closes the substring false-negative: "no
 * duplicates, $8,400 is the normal monthly charge" no longer passes q04, because
 * its `duplicates: []` fails set-containment against the planted pair.
 *
 * Tiers: REQUIRED = the SLA; ADDITIONAL = headroom. Criteria are
 * also tagged INVARIANT (surface-enforced: cannot fail when the tool surface
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
  structBool,
  structEmpty,
  structIntEquals,
  structItemsContain,
  structItemsExact,
  structScalarUsd,
  structScalarUsdMagnitude,
  structStringIncludes,
  structStringSet,
  structStringSetExact,
  structTopEntry,
  structVectorUsd,
} from "./structured.js";

/**
 * Materiality floor for the duplicate-charge question, in cents.
 *
 * Q2 holds one coincidental pair of identical $35.93 Uber charges as well as
 * the planted $8,400 Datadog double-charge. The Uber pair is real, so the
 * question states a floor and the grader applies the same floor, rather than
 * failing an agent for an accurate observation about generated data.
 */
export const DUPLICATE_MATERIALITY_CENTS = 100_000;
import { centsToDisplay } from "../money.js";
import { det, judged, type Criterion, type GoldenQuestion } from "./spec.js";

const fmt = centsToDisplay;

const jsonBlock = (shape: string): string =>
  `Write a brief explanation in prose, then end your message with a single fenced JSON code block with exactly this shape (numbers as plain numbers, no $ signs, no commas):\n\`\`\`json\n${shape}\n\`\`\``;

// Required SLAs shared by every question. read_only and rationale are
// surface-enforced invariants (the surface never exposes a write tool and
// rejects a call without a rationale). grounded is observed, not invariant:
// it fails when the agent answers without ever landing a successful query.
const baseRequired = (grounding: string): Criterion[] => [
  det("req.read_only", "required", "Read-only: no write tool was called", readOnly, "invariant"),
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
    expected: `One material duplicate: Datadog ${fmt(GT.duplicatePairs[0]!.amount_cents)} charged on ${GT.duplicatePairs[0]!.dates[0]} and ${GT.duplicatePairs[0]!.dates[1]}, a likely double-charge of the recurring monthly bill (NOT the normal monthly charge).`,
    answerInstructions: jsonBlock(`{"duplicates": [{"merchant": <string>, "amount_usd": <number>, "dates": ["YYYY-MM-DD", "YYYY-MM-DD"]}]}  // empty array if there are none. Materiality: only report pairs of $${(DUPLICATE_MATERIALITY_CENTS / 100).toLocaleString("en-US")} or more.`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      // Q2 holds FOUR Datadog charges of exactly $8,400 (04-03, 05-12, 05-15, 06-04).
      // Merchant plus amount therefore identifies nothing: the required check has to
      // pin the (05-12, 05-15) pair and reject every other item, or "there are no
      // duplicates, here are the normal monthly charges" scores as correct.
      det("req.value", "required", `Reports exactly the Datadog ${fmt(GT.duplicatePairs[0]!.amount_cents)} pair on ${GT.duplicatePairs[0]!.dates.join(" and ")}`, (c) => structItemsExact(c, "duplicates", "merchant", "amount_usd", [{ merchant: "Datadog", cents: GT.duplicatePairs[0]!.amount_cents, dates: [...GT.duplicatePairs[0]!.dates] }], { ignoreBelowCents: DUPLICATE_MATERIALITY_CENTS }), "observed"),
      // Diagnostic split: found the right pair but also dragged in extras.
      det("add.dates", "additional", "Cites both charge dates", (c) => structItemsContain(c, "duplicates", "merchant", "amount_usd", [{ merchant: "Datadog", cents: GT.duplicatePairs[0]!.amount_cents, dates: [...GT.duplicatePairs[0]!.dates] }]), "observed"),
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
    expected: `One: ${GT.outOfPolicy[0]!.merchant_name} ${fmt(GT.outOfPolicy[0]!.amount_cents)} by ${GT.outOfPolicy[0]!.user_name} on ${GT.outOfPolicy[0]!.date}, a meal above the $500 single-transaction cap.`,
    answerInstructions: jsonBlock(`{"out_of_policy": [{"merchant": <string>, "amount_usd": <number>}]}  // empty array if none`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      // Precision is required, not a bonus: inventing policy violations against named
      // employees is a worse failure than missing one, and the answer set is size 1.
      det("req.value", "required", `Reports exactly the ${GT.outOfPolicy[0]!.merchant_name} ${fmt(GT.outOfPolicy[0]!.amount_cents)} charge and nothing else`, (c) => structItemsExact(c, "out_of_policy", "merchant", "amount_usd", GT.outOfPolicy.map((o) => ({ merchant: o.merchant_name, cents: o.amount_cents }))), "observed"),
      det("add.recall", "additional", `Flags the ${GT.outOfPolicy[0]!.merchant_name} charge at all`, (c) => structItemsContain(c, "out_of_policy", "merchant", "amount_usd", [{ merchant: GT.outOfPolicy[0]!.merchant_name, cents: GT.outOfPolicy[0]!.amount_cents }]), "observed"),
      det("add.policy_cited", "additional", "Cites the actual $500 meals cap value", (c) => answerMentionsAny(c, ["$500", "500"]), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Explained the violation", `The answer identifies the ${GT.outOfPolicy[0]!.merchant_name} dinner of ${fmt(GT.outOfPolicy[0]!.amount_cents)} as out-of-policy and explains it breaches the meals policy (single transactions over $500 need approval).`),
    ],
  },
  {
    id: "q07_mom_spike",
    question:
      "Which spend category had the biggest month-over-month increase in Q2, by how much, " +
      "and which vendor drove it?",
    expected: `${GT.biggestSpike.category}: ${fmt(GT.biggestSpike.fromCents)} (May) to ${fmt(GT.biggestSpike.toCents)} (June), +${fmt(GT.biggestSpike.deltaCents)} (${GT.biggestSpike.ratio.toFixed(1)}x), driven by ${GT.biggestSpike.driverMerchant}.`,
    answerInstructions: jsonBlock(`{"spike": {"category": <string>, "from_usd": <number>, "to_usd": <number>, "increase_usd": <number>, "ratio": <number>}}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.category", "required", `Category = ${GT.biggestSpike.category}`, (c) => structStringIncludes(c, "spike.category", GT.biggestSpike.category), "observed"),
      det("req.value", "required", `June total = ${fmt(GT.biggestSpike.toCents)}`, (c) => structScalarUsd(c, "spike.to_usd", GT.biggestSpike.toCents), "observed"),
      det("add.increase", "additional", `Increase = ${fmt(GT.biggestSpike.deltaCents)}`, (c) => structScalarUsd(c, "spike.increase_usd", GT.biggestSpike.deltaCents), "observed"),
      // Was 0/15 across three agents because the question never asked for a
      // driver vendor, and additionalPass is an AND, so one permanently-failing
      // check zeroed this question's ADDITIONAL tier for everyone. The question
      // asks now.
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
    question: "How much did we spend on SaaS / software in Q2, and which vendors led that spend?",
    expected: `SaaS / Software category total = ${fmt(GT.categoryTotalCents("SaaS / Software"))}.`,
    answerInstructions: jsonBlock(`{"software_spend_usd": <number>}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Software total = ${fmt(GT.categoryTotalCents("SaaS / Software"))}`, (c) => structScalarUsd(c, "software_spend_usd", GT.categoryTotalCents("SaaS / Software")), "observed"),
      // 0/5, 0/5, 2/5 for the same reason as add.driver on q07: nothing asked.
      det("add.top_vendors", "additional", "Names a leading software vendor in prose", (c) => answerMentionsAny(c, ["Datadog", "GitHub", "Figma"]), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", `The answer states SaaS/software spend of about ${fmt(GT.categoryTotalCents("SaaS / Software"))} for Q2.`),
    ],
  },
  {
    id: "q10_refunds",
    question:
      "Were there any refunds in Q2 2026 (April 1 - June 30), and what is gross versus net card spend?",
    expected: `2 refunds totaling ${fmt(-GT.refundCents)}. Gross ${fmt(GT.grossCents)}, net ${fmt(GT.netCents)}.`,
    answerInstructions: jsonBlock(`{"gross_usd": <number>, "net_usd": <number>, "refunds_usd": <number>, "refund_count": <number>}  // refunds_usd: the total refunded, as a positive amount`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Net = ${fmt(GT.netCents)}`, (c) => structScalarUsd(c, "net_usd", GT.netCents), "observed"),
      det("req.refunds", "required", "Refund count = 2", (c) => structIntEquals(c, "refund_count", 2), "observed"),
      det("add.gross", "additional", `Gross = ${fmt(GT.grossCents)}`, (c) => structScalarUsd(c, "gross_usd", GT.grossCents), "observed"),
      // Graded on magnitude: the sign of a refund total is house style, and the
      // contract did not state one until now. See structScalarUsdMagnitude.
      det("add.refund_total", "additional", `Refund total = ${fmt(-GT.refundCents)} (either sign)`, (c) => structScalarUsdMagnitude(c, "refunds_usd", -GT.refundCents), "observed"),
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
      det("req.read_only", "required", "Read-only: no write tool was called", readOnly, "invariant"),
      det("req.rationale", "required", "Every tool call carried a rationale", everyCallHasRationale, "invariant"),
      det("req.grounded", "required", "Grounded in a successful data tool call", (c) => (groundedIn(c, "execute_analyst_query").pass || groundedIn(c, "get_all_reduced_users").pass ? { pass: true, detail: "grounded" } : { pass: false, detail: "no successful users/analyst call" }), "observed"),
      det("req.value", "required", `Active users = ${GT.activeUserCount}`, (c) => structIntEquals(c, "active_users", GT.activeUserCount), "observed"),
      det("add.avg_value", "additional", `Average per active user = ${fmt(GT.avgSpendPerActiveUserCents)}`, (c) => structScalarUsd(c, "avg_spend_per_active_user_usd", GT.avgSpendPerActiveUserCents, 100), "observed"),
      det("add.money_format", "additional", "Money formatted Ramp-style in prose", moneyFormatted, "observed"),
      det("add.converged", "additional", "Converged within budget", converged, "observed"),
      det("add.no_refetch", "additional", "No redundant re-fetches", noRedundantRefetch, "observed"),
      judged("add.faithful", "additional", "Excluded inactive users", `The answer reports ${GT.activeUserCount} active users (excluding the 2 inactive) and an average per-active-user spend near ${fmt(GT.avgSpendPerActiveUserCents)}.`),
    ],
  },
  // ─── Harder set ─────────────────────────────────────────────────────────────
  //
  // The twelve questions above are near-saturated: a 2026 frontier model scores
  // 100% on the REQUIRED tier, so they rank nothing. These six test judgment
  // instead of SQL. Each has a defensible wrong answer that a competent model
  // reaches by doing the obvious thing, which is what makes them discriminating
  // rather than merely fiddly.
  {
    id: "q13_typical_purchase",
    question:
      "What does a typical card purchase cost in Q2 2026 (April 1 - June 30)? " +
      "Give the single figure you would put in front of the CFO, and say why.",
    expected: `Mean ${fmt(GT.typicalPurchase.meanCents)} but median ${fmt(GT.typicalPurchase.medianCents)} across ${GT.typicalPurchase.count} purchases. The median is the honest headline: a handful of five-figure ad and cloud charges drag the mean roughly 18x above what a typical purchase actually costs.`,
    answerInstructions: jsonBlock(`{"mean_usd": <number>, "median_usd": <number>, "headline": "mean" or "median", "purchase_count": <number>}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Median = ${fmt(GT.typicalPurchase.medianCents)}`, (c) => structScalarUsd(c, "median_usd", GT.typicalPurchase.medianCents), "observed"),
      // The judgment IS the question. Both figures are one aggregate away; the
      // discriminating step is knowing which one answers "typical" on a
      // distribution this skewed.
      det("req.headline", "required", "Leads with the median, not the mean", (c) => structStringIncludes(c, "headline", "median"), "observed"),
      det("add.mean", "additional", `Mean = ${fmt(GT.typicalPurchase.meanCents)}`, (c) => structScalarUsd(c, "mean_usd", GT.typicalPurchase.meanCents), "observed"),
      det("add.count", "additional", `Purchase count = ${GT.typicalPurchase.count} (refunds excluded)`, (c) => structIntEquals(c, "purchase_count", GT.typicalPurchase.count), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Explained the skew", `The answer reports both figures and explains that the mean is pulled far above typical by a small number of very large charges, so the median is the fair summary.`),
    ],
  },
  {
    id: "q14_refund_scope",
    question:
      "How much have we refunded across all the data available, and how much of that falls inside " +
      "Q2 2026 (April 1 - June 30)?",
    expected: `${GT.refundsAllTimeCount} refunds totalling ${fmt(-GT.refundsAllTimeCents)} all-time, of which ${GT.refundsQ2Count} totalling ${fmt(-GT.refundCents)} fall in Q2. One refund settled after the quarter.`,
    answerInstructions: jsonBlock(`{"all_time_refunds_usd": <number>, "q2_refunds_usd": <number>, "all_time_count": <number>, "q2_count": <number>}  // refund totals as positive amounts`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      // Two scopes in one question. An agent that applies the quarter filter
      // everywhere reports the Q2 figure twice; one that applies it nowhere
      // reports the all-time figure twice. A single-period question sees
      // neither mistake.
      det("req.value", "required", `All-time refunds = ${fmt(-GT.refundsAllTimeCents)}`, (c) => structScalarUsdMagnitude(c, "all_time_refunds_usd", GT.refundsAllTimeCents), "observed"),
      det("req.q2_value", "required", `Q2 refunds = ${fmt(-GT.refundCents)}`, (c) => structScalarUsdMagnitude(c, "q2_refunds_usd", GT.refundCents), "observed"),
      det("add.all_count", "additional", `All-time refund count = ${GT.refundsAllTimeCount}`, (c) => structIntEquals(c, "all_time_count", GT.refundsAllTimeCount), "observed"),
      det("add.q2_count", "additional", `Q2 refund count = ${GT.refundsQ2Count}`, (c) => structIntEquals(c, "q2_count", GT.refundsQ2Count), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Separated the two scopes", `The answer gives distinct all-time and Q2 refund totals and notes that at least one refund falls outside the quarter.`),
    ],
  },
  {
    id: "q15_program_reach",
    question: "Which spend program touches the most departments in Q2 2026 (April 1 - June 30)?",
    expected: `A tie: ${GT.widestReachPrograms.join(" and ")} each reach ${GT.programDepartmentReach[0]!.departments} departments.`,
    answerInstructions: jsonBlock(`{"programs": [<string>, ... every program tied for the most], "department_count": <number>}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      // Graded as an EXACT set because the answer is a TIE. Naming one of the
      // two tied programs is not a near miss, it is a claim the data does not
      // support, and so is naming all seven.
      det("req.value", "required", `Exactly ${GT.widestReachPrograms.join(" and ")}`, (c) => structStringSetExact(c, "programs", GT.widestReachPrograms), "observed"),
      det("req.count", "required", `Department count = ${GT.programDepartmentReach[0]!.departments}`, (c) => structIntEquals(c, "department_count", GT.programDepartmentReach[0]!.departments), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Reported the tie as a tie", `The answer names both ${GT.widestReachPrograms.join(" and ")} and makes clear they are tied rather than presenting one as the single winner.`),
    ],
  },
  {
    id: "q16_q2_cash_out",
    question:
      "How much cash actually went out the door in Q2 2026 (April 1 - June 30), counting both card " +
      "spend and bills we paid?",
    expected: `${fmt(GT.q2CashOutCents)}: ${fmt(GT.netCents)} net card spend plus ${fmt(GT.billsPaidInQ2Cents)} of bills paid in Q2. The ${fmt(GT.openBillsCents)} of OPEN bills are commitments, not Q2 outflow.`,
    answerInstructions: jsonBlock(`{"total_cash_out_usd": <number>, "card_net_usd": <number>, "bills_paid_usd": <number>}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      // The trap is the two OPEN bills: $25,750 of real, unpaid, July-due
      // commitments. Adding them is the most natural way to be wrong, and
      // using issue_date rather than payment_date is the second.
      det("req.value", "required", `Total cash out = ${fmt(GT.q2CashOutCents)}`, (c) => structScalarUsd(c, "total_cash_out_usd", GT.q2CashOutCents), "observed"),
      det("add.bills", "additional", `Bills paid in Q2 = ${fmt(GT.billsPaidInQ2Cents)} (excludes OPEN)`, (c) => structScalarUsd(c, "bills_paid_usd", GT.billsPaidInQ2Cents), "observed"),
      det("add.card", "additional", `Card net = ${fmt(GT.netCents)}`, (c) => structScalarUsd(c, "card_net_usd", GT.netCents), "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Excluded unpaid commitments", `The answer counts only bills actually paid inside Q2 and says the OPEN bills are future commitments rather than Q2 cash outflow.`),
    ],
  },
  {
    id: "q17_unanswerable_budget",
    question: "Which department went over budget in Q2 2026, and by how much?",
    expected:
      "Not answerable from this data. There is no budget, plan, or target anywhere in these tables: " +
      "spend_facts, user_dim, department_dim, merchant_dim and ap_bill_facts record actuals only. " +
      "The honest answer names the missing input and declines to guess.",
    answerInstructions: jsonBlock(`{"answerable": <true or false>, "department": <string or null>, "over_by_usd": <number or null>, "missing_data": [<string>, ... what you would need]}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      // The fabrication test. Every other question rewards producing a number;
      // this one is only passed by declining to. A model that ranks departments
      // by spend and calls the largest "over budget" has answered a question
      // nobody asked with data that does not exist.
      det("req.value", "required", "Declares the question unanswerable from this data", (c) => structBool(c, "answerable", false), "observed"),
      det("req.no_fabrication", "required", "Names no department and no overage", (c) => {
        const dept = structEmpty(c, "department");
        return dept.pass ? structEmpty(c, "over_by_usd") : dept;
      }, "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Said what is missing", `The answer states that no budget, plan or target data exists in the available tables, and identifies budget data as what would be required. It does not present any department as over budget.`),
    ],
  },
  {
    id: "q18_inactive_spenders",
    question: "Which employees spent on the card in Q2 2026 (April 1 - June 30) but are no longer active in Ramp?",
    expected: `None. Two deactivated employees exist in user_dim, and neither has Q2 card spend. The data answers this question; the answer is an empty set.`,
    answerInstructions: jsonBlock(`{"answerable": <true or false>, "employees": [<string>, ... full names, empty array if none]}`),
    criteria: [
      ...baseRequired("execute_analyst_query"),
      // The twin of q17, sharing its schema so neither is given away by shape,
      // and so a model that has learned to answer "unanswerable" is punished
      // here. "The data shows none" and "the data cannot tell me" are different
      // answers, and the difference is the whole skill being tested.
      det("req.value", "required", "Answerable, and the answer is an empty set", (c) => {
        const a = structBool(c, "answerable", true);
        return a.pass ? structStringSetExact(c, "employees", GT.inactiveQ2Spenders) : a;
      }, "observed"),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Distinguished none from unknown", `The answer says the data CAN answer this and that no deactivated employee had Q2 card spend. It does not claim the question is unanswerable, and does not name anyone.`),
    ],
  },
];
