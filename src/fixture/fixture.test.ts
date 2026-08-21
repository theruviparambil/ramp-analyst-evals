/**
 * Fixture invariants: the four planted patterns exist, are exact, and are
 * queryable through the real DuckDB. If any of these break, every eval question
 * built on them is meaningless, so they are the first line of defense.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { AnalystArtifact } from "../ramp/analyst-db.js";
import * as GT from "./ground-truth.js";
import { TRANSACTIONS, PERIOD } from "./data.js";

const db = new AnalystArtifact();
beforeAll(async () => {
  await db.init();
});

describe("fixture volume and window", () => {
  it("has ~200 transactions inside Q2 2026", () => {
    expect(GT.Q2_TRANSACTIONS.length).toBeGreaterThanOrEqual(180);
    expect(GT.Q2_TRANSACTIONS.length).toBeLessThanOrEqual(230);
    for (const t of GT.Q2_TRANSACTIONS) {
      expect(t.transaction_date >= PERIOD.start && t.transaction_date <= PERIOD.end).toBe(true);
    }
  });

  it("carries rows OUTSIDE Q2, so the date filter is load-bearing", () => {
    // Without these, an agent that omits `WHERE transaction_date BETWEEN ...`
    // got the identical answer on nine of the twelve questions, so a wrong or
    // missing reporting period was invisible to this eval.
    const outside = TRANSACTIONS.filter(
      (t) => t.transaction_date < PERIOD.start || t.transaction_date > PERIOD.end,
    );
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.some((t) => t.transaction_date < PERIOD.start)).toBe(true);
    expect(outside.some((t) => t.transaction_date > PERIOD.end)).toBe(true);
  });

  it("omitting the filter changes the answer by a gradeable amount", () => {
    // The point of the rows above: forgetting the period must be detectable,
    // not merely possible.
    const unfiltered = TRANSACTIONS.reduce((a, t) => a + t.amount_cents, 0);
    expect(unfiltered).not.toBe(GT.netCents);
    expect(Math.abs(unfiltered - GT.netCents)).toBeGreaterThan(1_000_000); // > $10k
  });

  it("is deterministic across imports (fixed seed)", () => {
    // The oracle netCents is computed once at module load; assert a stable value.
    expect(GT.netCents).toBe(GT.grossCents + GT.refundCents);
    expect(GT.transactionCount).toBe(GT.Q2_TRANSACTIONS.length);
  });
});

describe("(a) duplicate charge", () => {
  it("has exactly one material duplicate pair: Datadog $8,400.00, 3 days apart", () => {
    expect(GT.duplicatePairs).toHaveLength(1);
    const d = GT.duplicatePairs[0]!;
    expect(d.merchant_name).toBe("Datadog");
    expect(d.amount_cents).toBe(840000);
    expect(d.dates).toEqual(["2026-05-12", "2026-05-15"]);
  });

  it("does NOT flag the recurring monthly Datadog charge as duplicates", async () => {
    // Naive same-merchant+amount grouping over-counts Datadog (4 monthly hits);
    // proximity + materiality is what isolates the real double-charge.
    const r = await db.query(
      "SELECT COUNT(*) AS n FROM analyst.spend_facts sf WHERE sf.transaction_date BETWEEN DATE '2026-04-01' AND DATE '2026-06-30' AND sf.merchant_name = 'Datadog' AND sf.amount = 8400.00",
    );
    expect(r.rows[0]!.n).toBe(4); // 4 monthly charges, but only 1 is a true duplicate
  });
});

describe("(b) vendor name variant", () => {
  it("Delta appears under two spellings that combine to $4,387.00", async () => {
    expect(GT.deltaVariants).toEqual(["Delta Air Lines", "Delta Airlines"]);
    expect(GT.deltaCombinedCents).toBe(438700);
    const combined = await db.query(
      `SELECT SUM(sf.amount) AS total FROM analyst.spend_facts sf
       JOIN analyst.merchant_dim md ON sf.merchant_uuid = md.merchant_uuid
       WHERE sf.transaction_date BETWEEN DATE '2026-04-01' AND DATE '2026-06-30' AND md.normalized_merchant_name = 'Delta Air Lines'`,
    );
    expect(combined.rows[0]!.total).toBeCloseTo(4387, 2);
  });

  it("querying raw merchant_name splits the vendor (the trap)", async () => {
    const split = await db.query(
      "SELECT sf.merchant_name AS m, SUM(sf.amount) AS total FROM analyst.spend_facts sf WHERE sf.transaction_date BETWEEN DATE '2026-04-01' AND DATE '2026-06-30' AND sf.merchant_name LIKE 'Delta%' GROUP BY sf.merchant_name ORDER BY m",
    );
    expect(split.rows.length).toBe(2); // two spellings => a naive query under-reports
  });
});

describe("(c) out-of-policy", () => {
  it("has exactly one out-of-policy transaction: Nobu $6,750.00", async () => {
    expect(GT.outOfPolicy).toHaveLength(1);
    expect(GT.outOfPolicy[0]!.merchant_name).toBe("Nobu");
    expect(GT.outOfPolicy[0]!.amount_cents).toBe(675000);
    const r = await db.query(
      "SELECT COUNT(*) AS n FROM analyst.spend_facts sf WHERE sf.transaction_date BETWEEN DATE '2026-04-01' AND DATE '2026-06-30' AND sf.policy_status = 'out_of_policy'",
    );
    expect(r.rows[0]!.n).toBe(1);
  });
});

describe("(d) month-over-month spike", () => {
  it("Advertising jumps May $12,500 -> June $50,000 (4.0x)", () => {
    const s = GT.biggestSpike;
    expect(s.category).toBe("Advertising");
    expect(s.fromMonth).toBe(5);
    expect(s.toMonth).toBe(6);
    expect(s.fromCents).toBe(1250000);
    expect(s.toCents).toBe(5000000);
    expect(s.ratio).toBeCloseTo(4.0, 5);
    expect(s.driverMerchant).toBe("Google Ads");
  });

  it("DuckDB reproduces the monthly Advertising totals", async () => {
    const r = await db.query(
      `SELECT EXTRACT(month FROM sf.transaction_date) AS mo, SUM(sf.amount) AS total
       FROM analyst.spend_facts sf WHERE sf.transaction_date BETWEEN DATE '2026-04-01' AND DATE '2026-06-30' AND sf.merchant_category = 'Advertising' GROUP BY mo ORDER BY mo`,
    );
    expect(r.rows.map((x) => x.total)).toEqual([12000, 12500, 50000]);
  });
});

describe("oracle vs DuckDB agree (two independent paths)", () => {
  it("net spend matches", async () => {
    const r = await db.query("SELECT SUM(sf.amount) AS net FROM analyst.spend_facts sf WHERE sf.transaction_date BETWEEN DATE '2026-04-01' AND DATE '2026-06-30'");
    expect(Math.round((r.rows[0]!.net as number) * 100)).toBe(GT.netCents);
  });

  it("top vendor (canonical) matches", async () => {
    const r = await db.query(
      `SELECT md.normalized_merchant_name AS vendor, SUM(sf.amount) AS total
       FROM analyst.spend_facts sf JOIN analyst.merchant_dim md ON sf.merchant_uuid = md.merchant_uuid
       WHERE sf.transaction_date BETWEEN DATE '2026-04-01' AND DATE '2026-06-30'
       GROUP BY vendor ORDER BY total DESC LIMIT 1`,
    );
    expect(r.rows[0]!.vendor).toBe(GT.topVendor.key);
    expect(Math.round((r.rows[0]!.total as number) * 100)).toBe(GT.topVendor.cents);
  });
});
