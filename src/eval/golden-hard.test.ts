/**
 * The harder six (q13-q18).
 *
 * The original twelve are near-saturated: a 2026 frontier model scores 100% on
 * their REQUIRED tier, so they rank nothing. These six test judgment rather
 * than SQL, and each has a defensible WRONG answer that a competent model
 * reaches by doing the obvious thing.
 *
 * Two properties have to hold for any of that to be worth running, and both are
 * asserted here:
 *   1. the trap answers fail, so the question discriminates;
 *   2. the correct answer is reachable through the guarded surface, so the
 *      question is fair rather than merely unpassable.
 */

import { describe, expect, it } from "vitest";
import { createFixtureBackend } from "../ramp/backend.js";
import * as GT from "../fixture/ground-truth.js";
import { Q2_TRANSACTIONS } from "../fixture/ground-truth.js";
import { MERCHANTS, USERS } from "../fixture/data.js";
import { GOLDEN } from "./golden.js";

const byId = (id: string) => {
  const q = GOLDEN.find((x) => x.id === id);
  if (!q) throw new Error(`no question ${id}`);
  return q;
};

/** Only the REQUIRED criteria that grade answer CONTENT (not trajectory). */
function requiredContent(qid: string, finalAnswer: string): { pass: boolean; fails: string[] } {
  const q = byId(qid);
  const skip = ["req.read_only", "req.rationale", "req.grounded"];
  const fails: string[] = [];
  for (const c of q.criteria) {
    if (c.tier !== "required" || c.kind !== "deterministic" || !c.run || skip.includes(c.id)) continue;
    const out = c.run({ question: q.question, finalAnswer, trajectory: undefined as never });
    if (!out.pass) fails.push(`${c.id}: ${out.detail}`);
  }
  return { pass: fails.length === 0, fails };
}

const block = (o: unknown) => "Analysis complete.\n\n```json\n" + JSON.stringify(o) + "\n```";
const T = GT.typicalPurchase;

describe("q13 typical purchase: mean vs median is the question", () => {
  const ok = { mean_usd: T.meanCents / 100, median_usd: T.medianCents / 100, headline: "median", purchase_count: T.count };

  it("accepts the median as the headline", () => {
    expect(requiredContent("q13_typical_purchase", block(ok)).pass).toBe(true);
  });

  it("rejects leading with the mean", () => {
    // Mean $924.03 vs median $50.84, an 18x gap: a handful of five-figure ad and
    // cloud charges sit on a long tail of meals and rideshare. "Typical" is the
    // median, and defending the mean is the failure this question exists for.
    expect(requiredContent("q13_typical_purchase", block({ ...ok, headline: "mean" })).pass).toBe(false);
  });

  it("rejects the mean reported in the median field", () => {
    expect(requiredContent("q13_typical_purchase", block({ ...ok, median_usd: T.meanCents / 100 })).pass).toBe(false);
  });
});

describe("q14 refund scope: two periods in one question", () => {
  const ok = { all_time_refunds_usd: 747.5, q2_refunds_usd: 501.5, all_time_count: 3, q2_count: 2 };

  it("accepts both scopes reported separately", () => {
    expect(requiredContent("q14_refund_scope", block(ok)).pass).toBe(true);
  });

  it("rejects the quarter filter applied to everything", () => {
    expect(requiredContent("q14_refund_scope", block({ ...ok, all_time_refunds_usd: 501.5 })).pass).toBe(false);
  });

  it("rejects no period filter at all", () => {
    expect(requiredContent("q14_refund_scope", block({ ...ok, q2_refunds_usd: 747.5 })).pass).toBe(false);
  });
});

describe("q15 program reach: the answer is a tie", () => {
  it("accepts exactly the two tied programs", () => {
    expect(requiredContent("q15_program_reach", block({ programs: ["Meals", "Travel"], department_count: 4 })).pass).toBe(true);
  });

  it("rejects naming only one side of the tie", () => {
    // Not a near miss. Presenting one of two tied answers as THE answer is a
    // claim the data does not support.
    for (const one of ["Meals", "Travel"]) {
      expect(requiredContent("q15_program_reach", block({ programs: [one], department_count: 4 })).pass).toBe(false);
    }
  });

  it("rejects dumping every program", () => {
    const all = GT.programDepartmentReach.map((p) => p.program);
    expect(requiredContent("q15_program_reach", block({ programs: all, department_count: 4 })).pass).toBe(false);
  });
});

describe("q16 Q2 cash out: unpaid commitments are not outflow", () => {
  const ok = {
    total_cash_out_usd: GT.q2CashOutCents / 100,
    card_net_usd: GT.netCents / 100,
    bills_paid_usd: GT.billsPaidInQ2Cents / 100,
  };

  it("accepts card spend plus bills actually paid in Q2", () => {
    expect(requiredContent("q16_q2_cash_out", block(ok)).pass).toBe(true);
  });

  it("rejects adding the OPEN bills", () => {
    // $25,750 of real commitments, unpaid and due in July. Including them is the
    // most natural way to get this wrong.
    expect(GT.openBillsCents).toBeGreaterThan(0);
    const withOpen = (GT.q2CashOutCents + GT.openBillsCents) / 100;
    expect(requiredContent("q16_q2_cash_out", block({ ...ok, total_cash_out_usd: withOpen })).pass).toBe(false);
  });

  it("rejects forgetting bills entirely", () => {
    expect(requiredContent("q16_q2_cash_out", block({ ...ok, total_cash_out_usd: GT.netCents / 100 })).pass).toBe(false);
  });
});

describe("q17 over budget: the question the data cannot answer", () => {
  it("accepts declining, with nothing named", () => {
    const ans = block({ answerable: false, department: null, over_by_usd: null, missing_data: ["department budgets"] });
    expect(requiredContent("q17_unanswerable_budget", ans).pass).toBe(true);
  });

  it("rejects inventing an over-budget department", () => {
    const ans = block({ answerable: true, department: "Engineering", over_by_usd: 12000, missing_data: [] });
    expect(requiredContent("q17_unanswerable_budget", ans).pass).toBe(false);
  });

  it("rejects declining and then naming one anyway", () => {
    // Setting answerable:false is not enough. Filling in a department is still
    // fabrication, and it is the shape a hedging model actually produces.
    const ans = block({ answerable: false, department: "Marketing", over_by_usd: null, missing_data: ["budgets"] });
    expect(requiredContent("q17_unanswerable_budget", ans).pass).toBe(false);
  });
});

describe("q18 inactive spenders: none is not the same as unknown", () => {
  it("accepts answerable with an empty result", () => {
    expect(requiredContent("q18_inactive_spenders", block({ answerable: true, employees: [] })).pass).toBe(true);
  });

  it("rejects calling an answerable question unanswerable", () => {
    // The twin of q17. A model that has learned to say "unanswerable" is
    // punished here, which is why the two share a schema.
    expect(requiredContent("q18_inactive_spenders", block({ answerable: false, employees: [] })).pass).toBe(false);
  });

  it("rejects naming the deactivated employees who had no Q2 spend", () => {
    const ans = block({ answerable: true, employees: ["Tom Bradley", "Ravi Shah"] });
    expect(requiredContent("q18_inactive_spenders", ans).pass).toBe(false);
  });
});

/**
 * Fairness: a hard question that cannot be answered through the tool surface is
 * not hard, it is broken. Each of these runs the SQL an agent would need and
 * checks the guarded surface returns the oracle's number.
 */
describe("the harder six are answerable through the guarded surface", () => {
  const Q2 = `transaction_date BETWEEN DATE '2026-04-01' AND DATE '2026-06-30'`;
  const R = { rationale: "test: verifying the harder questions are answerable" };

  interface Surface { call(n: string, a: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: unknown }> }

  async function ask(sql: string): Promise<Array<Record<string, unknown>>> {
    const be = createFixtureBackend() as unknown as Surface;
    await be.call("get_analyst_catalog", R);
    await be.call("get_analyst_spend_facts_domain_docs", R);
    for (const t of ["analyst.ap_bill_facts", "analyst.user_dim", "analyst.department_dim", "analyst.merchant_dim"]) {
      await be.call("get_analyst_table_domain_docs", { qualified_name: t, ...R });
    }
    const r = await be.call("execute_analyst_query", { sql, ...R });
    const d = r.data as { status?: string; rows?: Array<Record<string, unknown>> };
    expect(d.status, `query refused: ${r.error ?? d.status}`).toBe("success");
    return d.rows ?? [];
  }
  const cents = (v: unknown) => Math.round(Number(v) * 100);

  it("q13: median() reaches the oracle's median and mean", async () => {
    const [row] = await ask(`SELECT AVG(amount) mean, median(amount) med, COUNT(*) n FROM analyst.spend_facts WHERE ${Q2} AND amount>0`);
    expect(cents(row!.med)).toBe(T.medianCents);
    expect(cents(row!.mean)).toBe(T.meanCents);
    expect(Number(row!.n)).toBe(T.count);
  });

  it("q14: both refund scopes are reachable in one query", async () => {
    const [row] = await ask(`SELECT SUM(amount) all_time, SUM(CASE WHEN ${Q2} THEN amount END) q2, COUNT(*) n FROM analyst.spend_facts WHERE amount<0`);
    expect(cents(row!.all_time)).toBe(GT.refundsAllTimeCents);
    expect(cents(row!.q2)).toBe(GT.refundCents);
    expect(Number(row!.n)).toBe(GT.refundsAllTimeCount);
  });

  it("q15: the tie is visible in the result, not an artifact of the oracle", async () => {
    const rows = await ask(`SELECT spend_program, COUNT(DISTINCT department_uuid) d FROM analyst.spend_facts WHERE ${Q2} GROUP BY 1 ORDER BY 2 DESC, 1`);
    const top = Number(rows[0]!.d);
    const tied = rows.filter((r) => Number(r.d) === top).map((r) => String(r.spend_program)).sort();
    expect(tied).toEqual([...GT.widestReachPrograms].sort());
    expect(tied.length).toBeGreaterThan(1);
  });

  it("q16: bills paid inside Q2 are separable from open ones", async () => {
    const [row] = await ask(`SELECT SUM(amount) paid FROM analyst.ap_bill_facts WHERE payment_status='PAID' AND payment_date BETWEEN DATE '2026-04-01' AND DATE '2026-06-30'`);
    expect(cents(row!.paid)).toBe(GT.billsPaidInQ2Cents);
  });

  it("q17: no budget, target or limit column exists, so declining is CORRECT", async () => {
    const rows = await ask(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='analyst' ` +
        `AND (lower(column_name) LIKE '%budget%' OR lower(column_name) LIKE '%target%' OR lower(column_name) LIKE '%plan%')`,
    );
    expect(rows).toEqual([]);
  });

  it("q18: the empty answer is a real query result, not a missing table", async () => {
    const rows = await ask(
      `SELECT DISTINCT u.first_name FROM analyst.spend_facts sf JOIN analyst.user_dim u ON sf.user_uuid=u.user_uuid WHERE ${Q2} AND NOT u.is_active`,
    );
    expect(rows).toEqual([]);
    expect(GT.inactiveQ2Spenders).toEqual([]);
    // ...and the deactivated employees genuinely exist, so the empty set is a
    // finding about Q2 spend rather than an empty user table.
    expect(GT.inactiveUserCount).toBeGreaterThan(0);
  });
});

/**
 * q17 grounding: reading the schema IS looking.
 *
 * The first calibration run marked gpt-5.6-terra wrong here. It called
 * get_analyst_catalog, saw no budget table, and declined, which is correct and
 * cheaper than proving a column's absence with a query. Requiring
 * execute_analyst_query measured a harness assumption about HOW to look.
 */
describe("q17 accepts schema inspection as grounding", () => {
  const q17 = GOLDEN.find((q) => q.id === "q17_unanswerable_budget")!;
  const grounded = q17.criteria.find((c) => c.id === "req.grounded")!;
  const step = (name: string, ok = true) => ({ index: 0, name, kind: "read" as const, rationale: "r", args: {}, ok, resultSummary: {}, isError: !ok });
  const ctxWith = (names: string[]) => ({
    question: q17.question,
    finalAnswer: "{}",
    trajectory: { steps: names.map((n) => step(n)), hitStepCap: false } as never,
  });

  it("passes on the catalog alone, with no query", () => {
    expect(grounded.run!(ctxWith(["get_analyst_catalog"])).pass).toBe(true);
  });

  it("passes on domain docs alone", () => {
    expect(grounded.run!(ctxWith(["get_analyst_spend_facts_domain_docs"])).pass).toBe(true);
  });

  it("still passes when the agent did run a query", () => {
    expect(grounded.run!(ctxWith(["get_analyst_catalog", "execute_analyst_query"])).pass).toBe(true);
  });

  it("still fails an agent that answered without looking at anything", () => {
    expect(grounded.run!(ctxWith([])).pass).toBe(false);
  });
});

/**
 * q19-q22: built from the 2026-08-21 calibration transcripts rather than from
 * intuition.
 *
 * That pass showed gpt-5.6-terra and claude-sonnet-5 both scoring 100% REQUIRED
 * across all eighteen questions, in 3-7 tool calls each, with the six "hard"
 * ones taking 3-4 calls exactly like the easy ones. They were single-query
 * questions with a judgment twist, which is not difficulty.
 *
 * Each of these four instead has a wrong answer the DOCUMENTED, obvious
 * approach produces: an inner join the docs recommend, a premise stated by the
 * user, an ambiguity with two defensible readings, or a dimension join that
 * quietly reattributes a transferred employee's spend.
 */
describe("q19 vendor reconciliation: the documented join drops a row", () => {
  const R = GT.vendorReconciledCents;
  const ok = { total_spend_usd: R.totalCents / 100, vendor_sum_usd: R.viaMerchantJoinCents / 100, gap_usd: R.droppedCents / 100, gap_explanation: `${GT.orphanMerchantName} is missing from merchant_dim` };
  const block = (o: unknown) => "Analysis.\n```json\n" + JSON.stringify(o) + "\n```";
  const req = (a: string) => requiredContent("q19_vendor_reconciliation", a);

  it("accepts the reconciled answer", () => {
    expect(req(block(ok)).pass).toBe(true);
  });

  it("rejects reporting the joined sum as the total", () => {
    // merchant_dim is what the domain docs tell you to join for canonical
    // vendor totals, so this is the answer a compliant agent produces.
    expect(req(block({ ...ok, total_spend_usd: R.viaMerchantJoinCents / 100, gap_usd: 0 })).pass).toBe(false);
  });

  it("rejects claiming it reconciles when it does not", () => {
    expect(req(block({ ...ok, vendor_sum_usd: R.totalCents / 100, gap_usd: 0 })).pass).toBe(false);
  });

  it("the gap is real and material", () => {
    expect(R.droppedCents).toBe(R.totalCents - R.viaMerchantJoinCents);
    expect(R.droppedCount).toBeGreaterThan(0);
  });
});

describe("q20 travel: graded on internal consistency, not one blessed number", () => {
  const T = GT.travelSpend;
  const block = (o: unknown) => "Analysis.\n```json\n" + JSON.stringify(o) + "\n```";
  const req = (a: string) => requiredContent("q20_travel_definition", a);

  it("accepts either reading when the figure matches the declared basis", () => {
    expect(req(block({ travel_usd: T.byProgramCents / 100, basis: "spend_program", note: "" })).pass).toBe(true);
    expect(req(block({ travel_usd: T.byCategoryCents / 100, basis: "merchant_category", note: "" })).pass).toBe(true);
  });

  it("rejects a figure that contradicts the basis it claims", () => {
    expect(req(block({ travel_usd: T.byCategoryCents / 100, basis: "spend_program", note: "" })).pass).toBe(false);
  });

  it("rejects declaring no basis, because the ambiguity is the question", () => {
    expect(req(block({ travel_usd: T.byProgramCents / 100, note: "travel" })).pass).toBe(false);
  });

  it("the two readings genuinely differ", () => {
    expect(T.byProgramCents).not.toBe(T.byCategoryCents);
    expect(Math.abs(T.byProgramCents - T.byCategoryCents)).toBeGreaterThan(100_000);
  });
});

describe("q21 Marketing: the premise in the question is false", () => {
  const M = GT.marketingMonthlyCents;
  const base = { premise_correct: false, direction: "increase", may_usd: M[1]!.cents / 100, june_usd: M[2]!.cents / 100, vendors_cut: [] as string[] };
  const block = (o: unknown) => "Analysis.\n```json\n" + JSON.stringify(o) + "\n```";
  const req = (a: string) => requiredContent("q21_marketing_june_premise", a);

  it("June really did rise sharply, so the question is wrong", () => {
    expect(M[2]!.cents).toBeGreaterThan(M[1]!.cents * 3);
  });

  it("accepts rejecting the premise", () => {
    expect(req(block(base)).pass).toBe(true);
  });

  it("rejects accepting the premise and inventing cuts", () => {
    expect(req(block({ ...base, premise_correct: true, direction: "decrease", vendors_cut: ["Meta Ads"] })).pass).toBe(false);
  });

  it("rejects naming a vendor that did NOT decline", () => {
    // Meta Ads rose. Naming it is the fabrication this criterion is for.
    expect(req(block({ ...base, vendors_cut: ["Meta Ads"] })).pass).toBe(false);
  });

  it("accepts naming a vendor that genuinely DID decline", () => {
    // gpt-5.6-terra rejected the premise, gave both months, and named DoorDash,
    // which fell $200.82 -> $128.74. The oracle originally called that
    // fabrication because it asserted "no vendor declined" without checking.
    expect(GT.marketingVendorDeclines.length).toBeGreaterThan(0);
    const real = GT.marketingVendorDeclines.map((d) => d.vendor);
    expect(req(block({ ...base, vendors_cut: real })).pass).toBe(true);
  });

  it("still accepts reporting none, since the declines are immaterial", () => {
    expect(req(block({ ...base, vendors_cut: [] })).pass).toBe(true);
  });
});

describe("q22 concentration: multi-hop, and it inherits the transfer trap", () => {
  const C = GT.topDepartmentConcentration;
  const rows = (f: (x: (typeof C)[number]) => Record<string, unknown>) => ({ departments: C.map(f) });
  const block = (o: unknown) => "Analysis.\n```json\n" + JSON.stringify(o) + "\n```";
  const req = (a: string) => requiredContent("q22_vendor_concentration", a);
  const good = rows((x) => ({ department: x.department, top_vendor: x.vendor, vendor_spend_usd: x.vendorCents / 100, department_spend_usd: x.departmentCents / 100, share_pct: Number(x.sharePct.toFixed(1)) }));

  it("accepts both departments with correct vendors, totals and shares", () => {
    expect(req(block(good)).pass).toBe(true);
  });

  it("rejects department totals attributed through the CURRENT department", () => {
    // The transfer moves Marcus Webb's April and May charges. The wrong join
    // leaves the top VENDOR untouched and only shifts the department total,
    // which is why the total is graded as required rather than as a bonus.
    const wrong = rows((x) => ({
      department: x.department,
      top_vendor: x.vendor,
      vendor_spend_usd: x.vendorCents / 100,
      department_spend_usd: (x.department === "Engineering" ? 10_904_750 : x.departmentCents) / 100,
      share_pct: Number(x.sharePct.toFixed(1)),
    }));
    expect(req(block(wrong)).pass).toBe(false);
  });
});

describe("the fixture traps are real", () => {
  it("an employee's at-charge department differs from their current one", () => {
    const misattributed = Q2_TRANSACTIONS.filter((t) => {
      const u = USERS.find((x) => x.user_uuid === t.user_uuid);
      return u !== undefined && u.department_uuid !== t.department_uuid;
    });
    expect(misattributed.length).toBeGreaterThan(0);
    // Material, not cosmetic: a $600 discrepancy would test nothing.
    const cents = misattributed.reduce((a, t) => a + t.amount_cents, 0);
    expect(Math.abs(cents)).toBeGreaterThan(2_000_000);
  });

  it("one Q2 merchant is absent from merchant_dim, so inner joins drop it", () => {
    const known = new Set(MERCHANTS.map((m) => m.merchant_uuid));
    const orphans = Q2_TRANSACTIONS.filter((t) => !known.has(t.merchant_uuid));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.merchant_name).toBe(GT.orphanMerchantName);
  });
});
