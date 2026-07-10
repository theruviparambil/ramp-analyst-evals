/**
 * The oracle.
 *
 * Every expected answer in the golden set is computed here, in plain
 * TypeScript, straight from the fixture arrays, deliberately NOT through the
 * agent's DuckDB path. So when a deterministic checker says the agent got
 * $181,203.00, that number was derived by a second, independent code path.
 * A match means two implementations agree, which is what makes it evidence.
 *
 * Because we own the fixture, these are exact, not approximate.
 */

import {
  BILLS,
  MERCHANTS,
  TRANSACTIONS,
  USERS,
  type TxnRecord,
} from "./data.js";

const nameByUserUuid = new Map(USERS.map((u) => [u.user_uuid, `${u.first_name} ${u.last_name}`]));
const deptNameByUuid = new Map(USERS.map((u) => [u.department_uuid, u.department_name]));
const normalizedByRawMerchant = new Map(MERCHANTS.map((m) => [m.merchant_name, m.normalized_merchant_name]));
const categoryByMerchant = new Map(MERCHANTS.map((m) => [m.merchant_name, m.merchant_category]));

const monthOf = (t: TxnRecord): number => Number.parseInt(t.transaction_date.slice(5, 7), 10);
const sumCents = (xs: TxnRecord[]): number => xs.reduce((a, t) => a + t.amount_cents, 0);
const positives = TRANSACTIONS.filter((t) => t.amount_cents > 0);
const negatives = TRANSACTIONS.filter((t) => t.amount_cents < 0);

// ─── Totals ─────────────────────────────────────────────────────────────────

export const grossCents = sumCents(positives);
export const refundCents = sumCents(negatives); // negative
export const netCents = sumCents(TRANSACTIONS);
export const transactionCount = TRANSACTIONS.length;

// ─── Group-bys ──────────────────────────────────────────────────────────────

function groupSum<T>(rows: TxnRecord[], keyOf: (t: TxnRecord) => T): Map<T, number> {
  const m = new Map<T, number>();
  for (const t of rows) m.set(keyOf(t), (m.get(keyOf(t)) ?? 0) + t.amount_cents);
  return m;
}

function rank(map: Map<string, number>): Array<{ key: string; cents: number }> {
  return [...map.entries()].map(([key, cents]) => ({ key, cents })).sort((a, b) => b.cents - a.cents);
}

/** Spend by department (net), ranked descending. */
export const departmentSpend = rank(groupSum(TRANSACTIONS, (t) => deptNameByUuid.get(t.department_uuid)!));
export const topDepartment = departmentSpend[0]!;

/** Spend by spender (net), ranked descending. */
export const userSpend = rank(groupSum(TRANSACTIONS, (t) => nameByUserUuid.get(t.user_uuid)!));
export const topSpender = userSpend[0]!;

/** Spend by CANONICAL vendor (net): raw merchant names collapsed via merchant_dim. */
export const vendorSpend = rank(groupSum(TRANSACTIONS, (t) => normalizedByRawMerchant.get(t.merchant_name) ?? t.merchant_name));
export const topVendor = vendorSpend[0]!;

/** Spend by category (net), ranked descending. */
export const categorySpend = rank(groupSum(TRANSACTIONS, (t) => t.merchant_category));
export function categoryTotalCents(category: string): number {
  return categorySpend.find((c) => c.key === category)?.cents ?? 0;
}

// ─── (a) Duplicate charge ─────────────────────────────────────────────────────
// Same merchant + same amount, within a short window, above a materiality floor.
// Two rules keep this crisp and business-realistic:
//   - the window (<= 5 days) excludes the recurring monthly Datadog charge, whose
//     other hits are weeks apart: only the May 12 / May 15 pair is close enough;
//   - the floor ($500) excludes coincidental small repeats (two $35 rideshares a
//     few days apart are two real rides, not a double-charge worth investigating).
// The result is exactly the planted Datadog pair.

const DUP_WINDOW_DAYS = 5;
const DUP_MATERIALITY_CENTS = 50_000;
const dayNumber = (d: string): number => Math.round(new Date(`${d}T00:00:00Z`).getTime() / 86_400_000);

export interface DuplicatePair {
  merchant_name: string;
  amount_cents: number;
  dates: [string, string];
  user_name: string;
}

export const duplicatePairs: DuplicatePair[] = (() => {
  const out: DuplicatePair[] = [];
  const byKey = new Map<string, TxnRecord[]>();
  for (const t of positives) {
    if (t.amount_cents < DUP_MATERIALITY_CENTS) continue;
    const k = `${t.merchant_name}|${t.amount_cents}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(t);
  }
  for (const rows of byKey.values()) {
    const sorted = [...rows].sort((a, b) => dayNumber(a.transaction_date) - dayNumber(b.transaction_date));
    for (let i = 1; i < sorted.length; i++) {
      if (dayNumber(sorted[i]!.transaction_date) - dayNumber(sorted[i - 1]!.transaction_date) <= DUP_WINDOW_DAYS) {
        out.push({
          merchant_name: sorted[i]!.merchant_name,
          amount_cents: sorted[i]!.amount_cents,
          dates: [sorted[i - 1]!.transaction_date, sorted[i]!.transaction_date],
          user_name: nameByUserUuid.get(sorted[i]!.user_uuid)!,
        });
      }
    }
  }
  return out;
})();

// ─── (b) Vendor name variant ──────────────────────────────────────────────────

export const deltaVariants: string[] = [
  ...new Set(TRANSACTIONS.filter((t) => (normalizedByRawMerchant.get(t.merchant_name) ?? "") === "Delta Air Lines").map((t) => t.merchant_name)),
].sort();
export const deltaCombinedCents = sumCents(
  TRANSACTIONS.filter((t) => (normalizedByRawMerchant.get(t.merchant_name) ?? "") === "Delta Air Lines"),
);

// ─── (c) Out-of-policy ─────────────────────────────────────────────────────────

export interface FlaggedTxn {
  merchant_name: string;
  amount_cents: number;
  user_name: string;
  date: string;
}

export const outOfPolicy: FlaggedTxn[] = TRANSACTIONS.filter((t) => t.policy_status === "out_of_policy").map((t) => ({
  merchant_name: t.merchant_name,
  amount_cents: t.amount_cents,
  user_name: nameByUserUuid.get(t.user_uuid)!,
  date: t.transaction_date,
}));

// ─── (d) Month-over-month category spike ──────────────────────────────────────

export interface MonthlyCategory {
  category: string;
  monthly: Record<number, number>; // month -> cents
}

const categoriesMonthly: MonthlyCategory[] = [...new Set(TRANSACTIONS.map((t) => t.merchant_category))].map((category) => {
  const monthly: Record<number, number> = { 4: 0, 5: 0, 6: 0 };
  for (const t of TRANSACTIONS.filter((x) => x.merchant_category === category)) monthly[monthOf(t)] += t.amount_cents;
  return { category, monthly };
});

export interface Spike {
  category: string;
  fromMonth: number;
  toMonth: number;
  fromCents: number;
  toCents: number;
  deltaCents: number;
  ratio: number; // toCents / fromCents
  driverMerchant: string;
}

export const biggestSpike: Spike = (() => {
  let best: Spike | null = null;
  for (const c of categoriesMonthly) {
    for (const [from, to] of [[4, 5], [5, 6]] as const) {
      const fromCents = c.monthly[from]!;
      const toCents = c.monthly[to]!;
      const deltaCents = toCents - fromCents;
      if (fromCents <= 0 || deltaCents <= 0) continue;
      if (!best || deltaCents > best.deltaCents) {
        // biggest driver merchant in the "to" month for this category
        const driver = rank(
          groupSum(
            TRANSACTIONS.filter((t) => t.merchant_category === c.category && monthOf(t) === to),
            (t) => t.merchant_name,
          ),
        )[0]!.key;
        best = { category: c.category, fromMonth: from, toMonth: to, fromCents, toCents, deltaCents, ratio: toCents / fromCents, driverMerchant: driver };
      }
    }
  }
  return best!;
})();

// ─── Bills (AP) ────────────────────────────────────────────────────────────────

export const openBillsCents = BILLS.filter((b) => b.payment_status === "OPEN").reduce((a, b) => a + b.amount_cents, 0);
export const paidBillsCents = BILLS.filter((b) => b.payment_status === "PAID").reduce((a, b) => a + b.amount_cents, 0);
export const openBillCount = BILLS.filter((b) => b.payment_status === "OPEN").length;

// ─── Users ───────────────────────────────────────────────────────────────────

export const activeUserCount = USERS.filter((u) => u.is_active).length;
export const inactiveUserCount = USERS.filter((u) => !u.is_active).length;
export const avgSpendPerActiveUserCents = Math.round(netCents / activeUserCount);

// ─── Bundle for reporting / --ground-truth ─────────────────────────────────────

export const GROUND_TRUTH = {
  transactionCount,
  grossCents,
  refundCents,
  netCents,
  topVendor,
  topDepartment,
  topSpender,
  categorySpend,
  duplicatePairs,
  deltaVariants,
  deltaCombinedCents,
  outOfPolicy,
  biggestSpike,
  openBillsCents,
  paidBillsCents,
  openBillCount,
  activeUserCount,
  inactiveUserCount,
  avgSpendPerActiveUserCents,
} as const;
