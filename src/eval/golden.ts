/**
 * The golden set — 12 finance questions over the fixture.
 *
 * Every expected value comes from the independent oracle (../fixture/ground-truth),
 * so the answers are exact, not hand-typed. Each question carries REQUIRED
 * criteria (the SLA: right number, read-only, grounded in a real tool call) and
 * ADDITIONAL criteria (headroom: cite the query, catch the variant/anomaly,
 * format money, take a clean reasoning path, pass the faithfulness judge).
 *
 * Four questions target the planted patterns directly (Q4 duplicate, Q5 vendor
 * variant, Q6 out-of-policy, Q7 month-over-month spike); the rest exercise
 * totals, group-bys, refunds, bills, and the user directory.
 */

import { centsToDisplay } from "../money.js";
import * as GT from "../fixture/ground-truth.js";
import {
  answerContainsAmount,
  answerContainsNumber,
  answerMentionsAll,
  answerMentionsAny,
  citedMethod,
  everyCallHasRationale,
  groundedIn,
  moneyFormatted,
  readOnly,
} from "./checkers.js";
import { catalogBeforeQuery, converged, docsBeforeQuery, queryAttemptsWithin } from "./trajectory.js";
import { det, judged, type Criterion, type GoldenQuestion } from "./spec.js";

const fmt = centsToDisplay;

// Criteria every question shares.
const baseRequired = (grounding: string): Criterion[] => [
  det("req.read_only", "required", "Stayed read-only — no write tool was called", readOnly),
  det("req.rationale", "required", "Every tool call carried a rationale", everyCallHasRationale),
  det("req.grounded", "required", `Answer grounded in a successful ${grounding} call`, (ctx) => groundedIn(ctx, grounding)),
];

const baseAdditional = (analyst: boolean): Criterion[] => [
  det("add.money_format", "additional", "Money formatted Ramp-style ($1,234.56)", moneyFormatted),
  det("add.cited_method", "additional", "Explained which query/tool produced the number", citedMethod),
  det("add.converged", "additional", "Converged within the tool-call budget", converged),
  ...(analyst
    ? [
        det("path.catalog_before_query", "additional", "Consulted the catalog before querying", catalogBeforeQuery),
        det("path.docs_before_query", "additional", "Read domain docs for referenced tables before querying", docsBeforeQuery),
        det("path.attempts", "additional", "Converged in ≤ 4 analyst-query attempts", (ctx) => queryAttemptsWithin(ctx, 4)),
      ]
    : []),
];

export const GOLDEN: GoldenQuestion[] = [
  {
    id: "q01_total_net_spend",
    question: "What was Vela Robotics' total net card spend in Q2 2026 (April 1 – June 30), after refunds?",
    expected: `Net card spend = ${fmt(GT.netCents)} (gross ${fmt(GT.grossCents)} minus ${fmt(-GT.refundCents)} of refunds).`,
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Net total = ${fmt(GT.netCents)}`, (c) => answerContainsAmount(c, GT.netCents, { tolFrac: 0.0005 })),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", "The answer states the total net Q2 card spend and the figure matches the ground-truth (within a dollar). It does not invent unsupported numbers."),
    ],
  },
  {
    id: "q02_top_vendor",
    question: "Which vendor did we spend the most with in Q2, and how much?",
    expected: `Top vendor: ${GT.topVendor.key} at ${fmt(GT.topVendor.cents)} (canonical vendor totals).`,
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.vendor", "required", `Names ${GT.topVendor.key}`, (c) => answerMentionsAll(c, [GT.topVendor.key])),
      det("req.value", "required", `Top vendor spend = ${fmt(GT.topVendor.cents)}`, (c) => answerContainsAmount(c, GT.topVendor.cents, { tolFrac: 0.0005 })),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", `The answer identifies ${GT.topVendor.key} as the top vendor with spend of about ${fmt(GT.topVendor.cents)}, grounded in a query result.`),
    ],
  },
  {
    id: "q03_spend_by_department",
    question: "Break down Q2 spend by department. Which department spent the most, and how much?",
    expected: `Top department: ${GT.topDepartment.key} at ${fmt(GT.topDepartment.cents)}. Full ranking across 6 departments.`,
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.dept", "required", `Names ${GT.topDepartment.key} as top`, (c) => answerMentionsAll(c, [GT.topDepartment.key])),
      det("req.value", "required", `Top department spend = ${fmt(GT.topDepartment.cents)}`, (c) => answerContainsAmount(c, GT.topDepartment.cents, { tolFrac: 0.0005 })),
      det("add.full_table", "additional", "Lists all six departments", (c) => answerMentionsAll(c, GT.departmentSpend.map((d) => d.key))),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", `The answer ranks departments by spend and names ${GT.topDepartment.key} as the top at about ${fmt(GT.topDepartment.cents)}.`),
    ],
  },
  {
    id: "q04_duplicate_charge",
    question: "Are there any duplicate charges from Q2 we should investigate?",
    expected: `One material duplicate: Datadog ${fmt(GT.duplicatePairs[0]!.amount_cents)} charged twice, on ${GT.duplicatePairs[0]!.dates[0]} and ${GT.duplicatePairs[0]!.dates[1]} — a likely double-charge of the recurring monthly bill.`,
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.merchant", "required", "Identifies Datadog as the duplicate", (c) => answerMentionsAll(c, ["Datadog"])),
      det("req.value", "required", `Duplicate amount = ${fmt(GT.duplicatePairs[0]!.amount_cents)}`, (c) => answerContainsAmount(c, GT.duplicatePairs[0]!.amount_cents)),
      det("add.dates", "additional", "Cites both charge dates (May 12 & May 15)", (c) => answerMentionsAny(c, ["05-12", "may 12", "12th"]) .pass && answerMentionsAny(c, ["05-15", "may 15", "15th"]).pass ? { pass: true, detail: "both dates cited" } : { pass: false, detail: "did not cite both May 12 and May 15" }),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Flagged the anomaly correctly", "The answer flags the Datadog $8,400.00 charge appearing twice within a few days as a probable duplicate/double-charge of the recurring monthly bill, not as normal recurring spend."),
    ],
  },
  {
    id: "q05_vendor_variant",
    question: "How much did we spend with Delta in Q2 in total?",
    expected: `Combined Delta spend = ${fmt(GT.deltaCombinedCents)}, spread across two un-normalized spellings: ${GT.deltaVariants.join(" and ")}.`,
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Combined Delta spend = ${fmt(GT.deltaCombinedCents)} (must sum both spellings)`, (c) => answerContainsAmount(c, GT.deltaCombinedCents)),
      det("add.variants", "additional", "Names both spelling variants", (c) => answerMentionsAll(c, GT.deltaVariants)),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Caught the vendor variant", `The answer reports the combined Delta spend of ${fmt(GT.deltaCombinedCents)} and explicitly flags that it is split across two spelling variants (${GT.deltaVariants.join(" and ")}) that are the same airline.`),
    ],
  },
  {
    id: "q06_out_of_policy",
    question: "Were there any out-of-policy transactions in Q2? If so, which and why?",
    expected: `One: ${GT.outOfPolicy[0]!.merchant_name} ${fmt(GT.outOfPolicy[0]!.amount_cents)} by ${GT.outOfPolicy[0]!.user_name} on ${GT.outOfPolicy[0]!.date} — a meal above the $500 single-transaction policy cap.`,
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.merchant", "required", `Identifies the ${GT.outOfPolicy[0]!.merchant_name} charge`, (c) => answerMentionsAll(c, [GT.outOfPolicy[0]!.merchant_name])),
      det("req.value", "required", `Amount = ${fmt(GT.outOfPolicy[0]!.amount_cents)}`, (c) => answerContainsAmount(c, GT.outOfPolicy[0]!.amount_cents)),
      det("add.policy_cited", "additional", "Cites the policy reason ($500 meals cap)", (c) => answerMentionsAny(c, ["policy", "$500", "500", "limit", "cap", "approval"])),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Explained the violation", `The answer identifies the ${GT.outOfPolicy[0]!.merchant_name} dinner of ${fmt(GT.outOfPolicy[0]!.amount_cents)} as out-of-policy and explains it breaches the meals policy (single transactions over $500 need approval).`),
    ],
  },
  {
    id: "q07_mom_spike",
    question: "Which spend category had the biggest month-over-month increase in Q2, and by how much?",
    expected: `${GT.biggestSpike.category}: ${fmt(GT.biggestSpike.fromCents)} in May to ${fmt(GT.biggestSpike.toCents)} in June (+${fmt(GT.biggestSpike.deltaCents)}, ${GT.biggestSpike.ratio.toFixed(1)}x), driven by ${GT.biggestSpike.driverMerchant}.`,
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.category", "required", `Names ${GT.biggestSpike.category}`, (c) => answerMentionsAll(c, [GT.biggestSpike.category])),
      det("req.value", "required", `June total ${fmt(GT.biggestSpike.toCents)} or increase ${fmt(GT.biggestSpike.deltaCents)}`, (c) => (answerContainsAmount(c, GT.biggestSpike.toCents).pass || answerContainsAmount(c, GT.biggestSpike.deltaCents).pass ? { pass: true, detail: "states June total or the increase" } : { pass: false, detail: `expected ${fmt(GT.biggestSpike.toCents)} or ${fmt(GT.biggestSpike.deltaCents)}` })),
      det("add.quantified", "additional", "Quantifies the jump (4x / 300% / +$37,500)", (c) => answerMentionsAny(c, ["4x", "4.0x", "300%", "3x", "37,500", "quadrupl"])),
      det("add.driver", "additional", "Names the driver vendor", (c) => answerMentionsAny(c, [GT.biggestSpike.driverMerchant])),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Explained the spike", `The answer names ${GT.biggestSpike.category} as the biggest month-over-month increase (May ${fmt(GT.biggestSpike.fromCents)} to June ${fmt(GT.biggestSpike.toCents)}) and correctly characterizes the magnitude (~4x / +${fmt(GT.biggestSpike.deltaCents)}).`),
    ],
  },
  {
    id: "q08_top_spender",
    question: "Who was the top spender by card in Q2, and how much did they spend?",
    expected: `${GT.topSpender.key} at ${fmt(GT.topSpender.cents)}.`,
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.user", "required", `Names ${GT.topSpender.key}`, (c) => answerMentionsAll(c, [GT.topSpender.key])),
      det("req.value", "required", `Top spender total = ${fmt(GT.topSpender.cents)}`, (c) => answerContainsAmount(c, GT.topSpender.cents, { tolFrac: 0.0005 })),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", `The answer names ${GT.topSpender.key} as the top spender at about ${fmt(GT.topSpender.cents)}.`),
    ],
  },
  {
    id: "q09_software_total",
    question: "How much did we spend on SaaS / software in Q2?",
    expected: `SaaS / Software category total = ${fmt(GT.categoryTotalCents("SaaS / Software"))}.`,
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Software total = ${fmt(GT.categoryTotalCents("SaaS / Software"))}`, (c) => answerContainsAmount(c, GT.categoryTotalCents("SaaS / Software"), { tolFrac: 0.0005 })),
      det("add.top_vendors", "additional", "Names a leading software vendor (e.g. Datadog)", (c) => answerMentionsAny(c, ["Datadog", "GitHub", "Figma"])),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", `The answer states SaaS/software spend of about ${fmt(GT.categoryTotalCents("SaaS / Software"))} for Q2.`),
    ],
  },
  {
    id: "q10_refunds",
    question: "Were there any refunds this quarter, and what is gross versus net card spend?",
    expected: `${GT.GROUND_TRUTH.refundCents < 0 ? 2 : 0} refunds totaling ${fmt(-GT.refundCents)}. Gross ${fmt(GT.grossCents)}, net ${fmt(GT.netCents)}.`,
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.refunds_ack", "required", "Acknowledges refunds exist", (c) => answerMentionsAny(c, ["refund", "credit", "-$"])),
      det("req.value", "required", `Net = ${fmt(GT.netCents)}`, (c) => answerContainsAmount(c, GT.netCents, { tolFrac: 0.0005 })),
      det("add.gross", "additional", `States gross ${fmt(GT.grossCents)}`, (c) => answerContainsAmount(c, GT.grossCents, { tolFrac: 0.0005 })),
      det("add.refund_total", "additional", `States refund total ${fmt(-GT.refundCents)}`, (c) => answerContainsAmount(c, -GT.refundCents)),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Separated gross and net", `The answer distinguishes gross spend (${fmt(GT.grossCents)}) from net (${fmt(GT.netCents)}) and notes the ${fmt(-GT.refundCents)} of refunds netted out.`),
    ],
  },
  {
    id: "q11_open_bills",
    question: "How much do we currently owe in unpaid (open) bills?",
    expected: `Open AP bills = ${fmt(GT.openBillsCents)} across ${GT.openBillCount} bills. (Paid bills so far: ${fmt(GT.paidBillsCents)}.)`,
    criteria: [
      ...baseRequired("execute_analyst_query"),
      det("req.value", "required", `Open bills total = ${fmt(GT.openBillsCents)}`, (c) => answerContainsAmount(c, GT.openBillsCents)),
      det("add.count", "additional", `States ${GT.openBillCount} open bills`, (c) => answerContainsNumber(c, GT.openBillCount)),
      det("add.separates", "additional", "Distinguishes open from paid", (c) => answerMentionsAny(c, ["open", "unpaid", "outstanding"])),
      ...baseAdditional(true),
      judged("add.faithful", "additional", "Answer is faithful and correct", `The answer states outstanding/open AP bills total ${fmt(GT.openBillsCents)}, and does not conflate bills with card spend.`),
    ],
  },
  {
    id: "q12_active_users",
    question: "How many active users do we have, and what is the average Q2 card spend per active user?",
    expected: `${GT.activeUserCount} active users (of ${GT.activeUserCount + GT.inactiveUserCount}); average net spend per active user = ${fmt(GT.avgSpendPerActiveUserCents)}.`,
    criteria: [
      det("req.read_only", "required", "Stayed read-only", readOnly),
      det("req.rationale", "required", "Every tool call carried a rationale", everyCallHasRationale),
      det("req.grounded", "required", "Grounded in a successful data tool call", (c) => (groundedIn(c, "execute_analyst_query").pass || groundedIn(c, "get_all_reduced_users").pass ? { pass: true, detail: "grounded" } : { pass: false, detail: "no successful users/analyst call" })),
      det("req.active_count", "required", `${GT.activeUserCount} active users`, (c) => answerContainsNumber(c, GT.activeUserCount)),
      det("add.avg_value", "additional", `Average spend per active user = ${fmt(GT.avgSpendPerActiveUserCents)}`, (c) => answerContainsAmount(c, GT.avgSpendPerActiveUserCents, { tolFrac: 0.01 })),
      det("add.money_format", "additional", "Money formatted Ramp-style", moneyFormatted),
      det("add.converged", "additional", "Converged within budget", converged),
      judged("add.faithful", "additional", "Excluded inactive users", `The answer reports ${GT.activeUserCount} active users (excluding the 2 inactive) and an average per-active-user spend near ${fmt(GT.avgSpendPerActiveUserCents)}.`),
    ],
  },
];
