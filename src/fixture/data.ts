/**
 * The synthetic company: this repo's ground truth.
 *
 * One demo business ("Vela Robotics"), ~15 users across 6 departments, and
 * ~200 card transactions over Q2 2026 (2026-04-01 .. 2026-06-30), plus a few
 * vendors and AP bills. Everything is generated deterministically (fixed seed),
 * so `npm test`, `npm run ground-truth`, and every eval run see byte-identical
 * data. Amounts are integer cents internally, no float drift.
 *
 * Four checkable patterns are PLANTED so the analyst has something real to find,
 * and so every eval question has an exact expected answer (computed by the
 * independent oracle in ./ground-truth.ts, never by the agent's own SQL path):
 *
 *   (a) DUPLICATE CHARGE:    Datadog $8,400.00 hits twice, 2026-05-12 & -05-15.
 *   (b) VENDOR VARIANT:      "Delta Air Lines" and "Delta Airlines" are the same
 *                            airline under two un-normalized spellings.
 *   (c) OUT-OF-POLICY:       a $6,750.00 Nobu dinner, flagged out_of_policy
 *                            (Meals policy caps single transactions at $500).
 *   (d) MONTH-OVER-MONTH:    Advertising spend jumps May $12,500 -> June $50,000
 *       SPIKE                (4.0x), driven by a June Google Ads campaign.
 */

// ─── Deterministic primitives ───────────────────────────────────────────────

/** mulberry32: a tiny deterministic PRNG. Same seed => same stream, forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string -> 32-bit unsigned int. Used to mint stable ids. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic UUID-shaped id from a stable key (looks real, is reproducible). */
function uuidFrom(key: string): string {
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  const a = hex(hash32(key));
  const b = hex(hash32(key + ":1"));
  const c = hex(hash32(key + ":2"));
  const d = hex(hash32(key + ":3"));
  const raw = (a + b + c + d).slice(0, 32);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
}

// ─── Record shapes (schema-faithful to the analyst artifact / agent-tool wire) ─

export interface DepartmentRecord {
  department_uuid: string;
  department_id: number;
  department_name: string;
}

export interface UserRecord {
  user_uuid: string;
  user_id: number;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
  is_active: boolean;
  department_uuid: string;
  department_name: string;
  location_name: string;
}

export interface MerchantRecord {
  merchant_uuid: string;
  merchant_name: string; // raw, un-normalized (this is what spend_facts stores)
  normalized_merchant_name: string; // canonical grouping key (merchant_dim only)
  merchant_category: string;
}

/** A card transaction, unified into analyst.spend_facts (source = card). */
export interface TxnRecord {
  spend_event_uuid: string;
  spend_event_id: number;
  transaction_date: string; // YYYY-MM-DD
  transaction_time: string; // ISO 8601
  amount_cents: number; // signed; negative = refund
  currency: string;
  merchant_uuid: string;
  merchant_name: string;
  merchant_category: string;
  user_uuid: string;
  department_uuid: string;
  policy_status: "in_policy" | "out_of_policy";
  spend_program: string;
  reason_or_justification: string;
}

export interface BillRecord {
  bill_uuid: string;
  payee_uuid: string;
  payee_name: string;
  amount_cents: number; // numeric dollars on the wire; cents internally
  currency: string;
  invoice_number: string;
  payment_status: "PAID" | "OPEN";
  issue_date: string;
  due_date: string;
  payment_date: string | null;
}

export interface VendorRecord {
  id: string;
  name: string;
  is_draft: boolean;
}

export const COMPANY = { name: "Vela Robotics", currency: "USD" } as const;
export const PERIOD = { start: "2026-04-01", end: "2026-06-30", label: "Q2 2026" } as const;

// ─── Departments ────────────────────────────────────────────────────────────

const DEPT_DEFS: Array<[string, string]> = [
  ["eng", "Engineering"],
  ["sales", "Sales"],
  ["mkt", "Marketing"],
  ["fin", "Finance"],
  ["ops", "Operations"],
  ["exec", "Executive"],
];

export const DEPARTMENTS: DepartmentRecord[] = DEPT_DEFS.map(([key, name], i) => ({
  department_uuid: uuidFrom(`dept:${key}`),
  department_id: 4300 + i,
  department_name: name,
}));

const deptByKey = (key: string): DepartmentRecord =>
  DEPARTMENTS[DEPT_DEFS.findIndex(([k]) => k === key)]!;

// ─── Users (15; two inactive) ───────────────────────────────────────────────

interface UserSeed {
  first: string;
  last: string;
  dept: string;
  role: string;
  active?: boolean;
}

const USER_SEEDS: UserSeed[] = [
  { first: "Priya", last: "Nair", dept: "eng", role: "ADMIN" },
  { first: "Marcus", last: "Webb", dept: "eng", role: "MEMBER" },
  { first: "Dana", last: "Liu", dept: "eng", role: "MEMBER" },
  { first: "Sam", last: "Okoro", dept: "eng", role: "MEMBER" },
  { first: "Jordan", last: "Reyes", dept: "sales", role: "MEMBER" },
  { first: "Elena", last: "Fisher", dept: "sales", role: "MEMBER" },
  { first: "Tom", last: "Bradley", dept: "sales", role: "MEMBER", active: false },
  { first: "Aisha", last: "Khan", dept: "mkt", role: "ADMIN" },
  { first: "Leo", last: "Martins", dept: "mkt", role: "MEMBER" },
  { first: "Grace", last: "Chen", dept: "fin", role: "ADMIN" },
  { first: "Victor", last: "Osei", dept: "fin", role: "BOOKKEEPER" },
  { first: "Nina", last: "Patel", dept: "ops", role: "MEMBER" },
  { first: "Ravi", last: "Shah", dept: "ops", role: "MEMBER", active: false },
  { first: "Alex", last: "Moreau", dept: "exec", role: "OWNER" },
  { first: "Sophia", last: "Wright", dept: "exec", role: "ADMIN" },
];

export const USERS: UserRecord[] = USER_SEEDS.map((u, i) => {
  const dept = deptByKey(u.dept);
  return {
    user_uuid: uuidFrom(`user:${u.first}.${u.last}`),
    user_id: 90100 + i,
    first_name: u.first,
    last_name: u.last,
    email: `${u.first.toLowerCase()}.${u.last.toLowerCase()}@velarobotics.com`,
    role: u.role,
    is_active: u.active !== false,
    department_uuid: dept.department_uuid,
    department_name: dept.department_name,
    location_name: "San Francisco HQ",
  };
});

const userByName = (first: string, last: string): UserRecord =>
  USERS.find((u) => u.first_name === first && u.last_name === last)!;

/** Active users in a department, for deterministic round-robin assignment. */
const activeUsersInDept = (deptKey: string): UserRecord[] =>
  USERS.filter((u) => u.is_active && u.department_uuid === deptByKey(deptKey).department_uuid);

// ─── Merchants ──────────────────────────────────────────────────────────────

interface MerchantSeed {
  name: string;
  category: string;
  normalized?: string; // when several raw names collapse to one canonical vendor
}

const MERCHANT_SEEDS: MerchantSeed[] = [
  { name: "Figma", category: "SaaS / Software" },
  { name: "Notion", category: "SaaS / Software" },
  { name: "Linear", category: "SaaS / Software" },
  { name: "GitHub", category: "SaaS / Software" },
  { name: "Datadog", category: "SaaS / Software" },
  { name: "1Password", category: "SaaS / Software" },
  { name: "Amazon Web Services", category: "Cloud Infrastructure" },
  { name: "Cloudflare", category: "Cloud Infrastructure" },
  { name: "Google Cloud", category: "Cloud Infrastructure" },
  { name: "Delta Air Lines", category: "Airlines", normalized: "Delta Air Lines" },
  { name: "Delta Airlines", category: "Airlines", normalized: "Delta Air Lines" },
  { name: "United Airlines", category: "Airlines" },
  { name: "Google Ads", category: "Advertising" },
  { name: "LinkedIn Ads", category: "Advertising" },
  { name: "Meta Ads", category: "Advertising" },
  { name: "Sweetgreen", category: "Restaurants" },
  { name: "Chipotle", category: "Restaurants" },
  { name: "DoorDash", category: "Restaurants" },
  { name: "Nobu", category: "Restaurants" },
  { name: "Marriott", category: "Lodging" },
  { name: "Airbnb", category: "Lodging" },
  { name: "Uber", category: "Rideshare" },
  { name: "Lyft", category: "Rideshare" },
  { name: "Staples", category: "Office Supplies" },
  { name: "Amazon", category: "Office Supplies" },
  { name: "Apple", category: "Computer Hardware" },
  { name: "Dell", category: "Computer Hardware" },
];

export const MERCHANTS: MerchantRecord[] = MERCHANT_SEEDS.map((m) => ({
  merchant_uuid: uuidFrom(`merchant:${m.name}`),
  merchant_name: m.name,
  normalized_merchant_name: m.normalized ?? m.name,
  merchant_category: m.category,
}));

const merchantByName = (name: string): MerchantRecord =>
  MERCHANTS.find((m) => m.merchant_name === name)!;

// ─── Transaction assembly ───────────────────────────────────────────────────

const rng = mulberry32(0x5eed1234);
let seq = 0;

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

interface TxnInput {
  merchant: string;
  month: number; // 4, 5, 6
  day: number;
  amountCents: number;
  user: UserRecord;
  program: string;
  memo: string;
  policy?: "in_policy" | "out_of_policy";
}

const TXNS: TxnRecord[] = [];

function addTxn(t: TxnInput): void {
  const m = merchantByName(t.merchant);
  const date = isoDate(2026, t.month, t.day);
  const hour = 8 + Math.floor(rng() * 11);
  const minute = Math.floor(rng() * 60);
  seq += 1;
  TXNS.push({
    spend_event_uuid: uuidFrom(`txn:${seq}:${t.merchant}:${date}`),
    spend_event_id: 5_000_000 + seq,
    transaction_date: date,
    transaction_time: `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`,
    amount_cents: t.amountCents,
    currency: "USD",
    merchant_uuid: m.merchant_uuid,
    merchant_name: m.merchant_name,
    merchant_category: m.merchant_category,
    user_uuid: t.user.user_uuid,
    department_uuid: t.user.department_uuid,
    policy_status: t.policy ?? "in_policy",
    spend_program: t.program,
    reason_or_justification: t.memo,
  });
}

/** Deterministic day-of-month in [lo, hi]. */
function pickDay(lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// -- Recurring software subscriptions (Engineering owns the infra cards) ------
const priya = userByName("Priya", "Nair");
const marcus = userByName("Marcus", "Webb");
const dana = userByName("Dana", "Liu");

const SOFTWARE_MONTHLY: Array<[string, number, UserRecord]> = [
  ["Figma", 18000, dana],
  ["Notion", 12000, marcus],
  ["Linear", 9600, marcus],
  ["GitHub", 21000, priya],
  ["1Password", 6000, dana],
];
for (const month of [4, 5, 6]) {
  for (const [merchant, cents, user] of SOFTWARE_MONTHLY) {
    addTxn({ merchant, month, day: pickDay(2, 6), amountCents: cents, user, program: "Software", memo: `${merchant} monthly subscription` });
  }
}

// -- Datadog: normal monthly $8,400, but PLANTED DUPLICATE in May -------------
addTxn({ merchant: "Datadog", month: 4, day: 3, amountCents: 840000, user: priya, program: "Software", memo: "Datadog observability, monthly" });
addTxn({ merchant: "Datadog", month: 5, day: 12, amountCents: 840000, user: priya, program: "Software", memo: "Datadog observability, monthly" });
addTxn({ merchant: "Datadog", month: 5, day: 15, amountCents: 840000, user: priya, program: "Software", memo: "Datadog observability, monthly" }); // (a) duplicate charge
addTxn({ merchant: "Datadog", month: 6, day: 4, amountCents: 840000, user: priya, program: "Software", memo: "Datadog observability, monthly" });

// -- Cloud infrastructure (Engineering) ---------------------------------------
const CLOUD: Array<[string, number[], UserRecord]> = [
  ["Amazon Web Services", [920000, 980000, 1040000], priya],
  ["Cloudflare", [200000, 200000, 200000], priya],
  ["Google Cloud", [310000, 330000, 350000], priya],
];
for (const [merchant, monthly, user] of CLOUD) {
  monthly.forEach((cents, i) => {
    addTxn({ merchant, month: 4 + i, day: pickDay(2, 8), amountCents: cents, user, program: "Cloud", memo: `${merchant} usage` });
  });
}

// -- Advertising: PLANTED month-over-month spike (May $12,500 -> June $50,000) -
const aisha = userByName("Aisha", "Khan");
const leo = userByName("Leo", "Martins");
const ADVERTISING: Array<[string, [number, number, number], UserRecord]> = [
  // [merchant, [Apr, May, Jun] cents, owner]
  ["Google Ads", [600000, 650000, 3000000], aisha], // June launch campaign = the driver
  ["LinkedIn Ads", [400000, 400000, 1200000], leo],
  ["Meta Ads", [200000, 200000, 800000], leo],
];
for (const [merchant, [apr, may, jun], user] of ADVERTISING) {
  addTxn({ merchant, month: 4, day: pickDay(5, 12), amountCents: apr, user, program: "Marketing", memo: `${merchant}: brand & demand` });
  addTxn({ merchant, month: 5, day: pickDay(5, 12), amountCents: may, user, program: "Marketing", memo: `${merchant}: brand & demand` });
  addTxn({ merchant, month: 6, day: pickDay(10, 20), amountCents: jun, user, program: "Marketing", memo: merchant === "Google Ads" ? "Google Ads: Q3 product launch campaign" : `${merchant}: launch support` });
}

// -- Airlines incl. PLANTED Delta variant (two spellings, same airline) -------
const jordan = userByName("Jordan", "Reyes");
const elena = userByName("Elena", "Fisher");
const alex = userByName("Alex", "Moreau");
addTxn({ merchant: "Delta Air Lines", month: 4, day: 9, amountCents: 120450, user: jordan, program: "Travel", memo: "Flight: customer visit (ATL)" });
addTxn({ merchant: "Delta Air Lines", month: 5, day: 21, amountCents: 98000, user: alex, program: "Travel", memo: "Flight: board offsite" });
addTxn({ merchant: "Delta Airlines", month: 4, day: 17, amountCents: 64230, user: elena, program: "Travel", memo: "Flight: prospect onsite" }); // (b) variant spelling
addTxn({ merchant: "Delta Airlines", month: 5, day: 6, amountCents: 115000, user: jordan, program: "Travel", memo: "Flight: regional sales tour" });
addTxn({ merchant: "Delta Airlines", month: 6, day: 12, amountCents: 41020, user: elena, program: "Travel", memo: "Flight: conference" });
addTxn({ merchant: "United Airlines", month: 4, day: 14, amountCents: 82000, user: alex, program: "Travel", memo: "Flight: investor meeting" });
addTxn({ merchant: "United Airlines", month: 5, day: 19, amountCents: 134000, user: jordan, program: "Travel", memo: "Flight: sales kickoff" });
addTxn({ merchant: "United Airlines", month: 6, day: 8, amountCents: 56000, user: elena, program: "Travel", memo: "Flight: customer QBR" });

// -- PLANTED out-of-policy dinner ---------------------------------------------
addTxn({
  merchant: "Nobu",
  month: 6,
  day: 18,
  amountCents: 675000,
  user: jordan,
  program: "Travel",
  memo: "Client dinner: enterprise prospect (8 guests)",
  policy: "out_of_policy",
}); // (c) out-of-policy: exceeds the $500 single-transaction meals cap

// -- Background noise: small, deterministic, spread across the quarter ---------
// Amounts vary within a band via the seeded PRNG; the oracle computes exact
// totals from whatever is generated, so these numbers never need to be "round".
interface NoiseSpec {
  merchant: string;
  program: string;
  perMonth: number;
  band: [number, number]; // cents range
  deptPool: string[]; // department keys whose active users can hold this card
  memo: string;
}

const NOISE: NoiseSpec[] = [
  { merchant: "Sweetgreen", program: "Meals", perMonth: 8, band: [1100, 2400], deptPool: ["eng", "sales", "mkt"], memo: "Team lunch" },
  { merchant: "Chipotle", program: "Meals", perMonth: 7, band: [900, 1800], deptPool: ["eng", "ops"], memo: "Lunch" },
  { merchant: "DoorDash", program: "Meals", perMonth: 7, band: [3200, 7200], deptPool: ["eng", "sales", "mkt", "ops"], memo: "Team meal delivery" },
  { merchant: "Uber", program: "Travel", perMonth: 9, band: [1400, 6800], deptPool: ["sales", "exec", "mkt"], memo: "Rideshare" },
  { merchant: "Lyft", program: "Travel", perMonth: 6, band: [1200, 5200], deptPool: ["sales", "exec"], memo: "Rideshare" },
  { merchant: "Marriott", program: "Travel", perMonth: 2, band: [24000, 62000], deptPool: ["sales", "exec"], memo: "Hotel: business travel" },
  { merchant: "Airbnb", program: "Travel", perMonth: 2, band: [18000, 44000], deptPool: ["eng", "mkt"], memo: "Lodging: offsite" },
  { merchant: "Staples", program: "G&A", perMonth: 4, band: [4000, 16000], deptPool: ["ops", "fin"], memo: "Office supplies" },
  { merchant: "Amazon", program: "G&A", perMonth: 6, band: [2500, 18000], deptPool: ["ops", "fin", "eng"], memo: "Office / equipment" },
  { merchant: "Apple", program: "Equipment", perMonth: 1, band: [120000, 260000], deptPool: ["eng", "exec"], memo: "Hardware: laptop" },
  { merchant: "Dell", program: "Equipment", perMonth: 1, band: [90000, 180000], deptPool: ["eng", "ops"], memo: "Hardware: workstation" },
];

for (const spec of NOISE) {
  const pool = spec.deptPool.flatMap((d) => activeUsersInDept(d));
  for (const month of [4, 5, 6]) {
    for (let i = 0; i < spec.perMonth; i++) {
      const amount = spec.band[0] + Math.floor(rng() * (spec.band[1] - spec.band[0] + 1));
      const user = pool[Math.floor(rng() * pool.length)]!;
      addTxn({ merchant: spec.merchant, month, day: pickDay(1, 27), amountCents: amount, user, program: spec.program, memo: spec.memo });
    }
  }
}

// -- Two refunds (negative amounts) -------------------------------------------
addTxn({ merchant: "Marriott", month: 4, day: 22, amountCents: -41200, user: alex, program: "Travel", memo: "Refund: cancelled hotel night" });
addTxn({ merchant: "Amazon", month: 5, day: 9, amountCents: -8950, user: userByName("Nina", "Patel"), program: "G&A", memo: "Refund: returned office chair" });

// -- Outside Q2, so the reporting period is load-bearing ----------------------
//
// Every row above falls in 2026-04-01 .. 2026-06-27. That made the date filter
// dead weight: an agent that omitted `WHERE transaction_date BETWEEN ...` got
// the identical answer on nine of the twelve questions, so a wrong or missing
// period filter -- the most common real analyst-agent bug -- was invisible.
//
// These sit in Q1 and Q3 and are deliberately large enough that including them
// changes every headline total. They are appended last so no uuid or timestamp
// above shifts. The oracle filters to Q2 in ground-truth.ts; an agent that does
// not will now disagree with it.
addTxn({ merchant: "Google Ads", month: 3, day: 11, amountCents: 2_150_000, user: userByName("Priya", "Nair"), program: "Marketing", memo: "Q1 search campaign, prior quarter" });
addTxn({ merchant: "Amazon Web Services", month: 3, day: 18, amountCents: 1_480_000, user: userByName("Priya", "Nair"), program: "Engineering", memo: "March cloud spend, prior quarter" });
addTxn({ merchant: "Datadog", month: 3, day: 22, amountCents: 840_000, user: userByName("Priya", "Nair"), program: "Engineering", memo: "March observability, prior quarter" });
addTxn({ merchant: "Delta Air Lines", month: 3, day: 26, amountCents: 128_400, user: alex, program: "Travel", memo: "Q1 offsite flight, prior quarter" });
addTxn({ merchant: "Marriott", month: 3, day: 27, amountCents: 96_500, user: alex, program: "Travel", memo: "Q1 offsite lodging, prior quarter" });
addTxn({ merchant: "Google Ads", month: 7, day: 6, amountCents: 1_920_000, user: userByName("Priya", "Nair"), program: "Marketing", memo: "Q3 search campaign, next quarter" });
addTxn({ merchant: "Amazon Web Services", month: 7, day: 9, amountCents: 1_610_000, user: userByName("Priya", "Nair"), program: "Engineering", memo: "July cloud spend, next quarter" });
addTxn({ merchant: "Notion", month: 7, day: 14, amountCents: 372_000, user: userByName("Nina", "Patel"), program: "G&A", memo: "Q3 seats renewal, next quarter" });
addTxn({ merchant: "Uber", month: 7, day: 17, amountCents: 18_450, user: userByName("Marcus", "Webb"), program: "Sales", memo: "Q3 client visit, next quarter" });
addTxn({ merchant: "Amazon", month: 7, day: 21, amountCents: -24_600, user: userByName("Nina", "Patel"), program: "G&A", memo: "Refund: Q3 returned monitor, next quarter" });

export const TRANSACTIONS: TxnRecord[] = TXNS;

// ─── AP bills (numeric dollars on the wire; a few, some open) ────────────────

interface BillSeed {
  payee: string;
  cents: number;
  status: "PAID" | "OPEN";
  issue: string;
  due: string;
  paid: string | null;
  invoice: string;
}

const BILL_SEEDS: BillSeed[] = [
  { payee: "Acme Legal LLP", cents: 1_850_000, status: "OPEN", issue: "2026-06-20", due: "2026-07-15", paid: null, invoice: "AL-20416" },
  { payee: "Meridian Office Leasing", cents: 1_200_000, status: "PAID", issue: "2026-05-25", due: "2026-06-01", paid: "2026-06-01", invoice: "MOL-0605" },
  { payee: "Brightpath Consulting", cents: 725_000, status: "OPEN", issue: "2026-06-28", due: "2026-07-20", paid: null, invoice: "BP-3391" },
  { payee: "Kraft Facilities Services", cents: 340_000, status: "PAID", issue: "2026-04-28", due: "2026-05-05", paid: "2026-05-05", invoice: "KFS-1188" },
];

export const BILLS: BillRecord[] = BILL_SEEDS.map((b) => ({
  bill_uuid: uuidFrom(`bill:${b.invoice}`),
  payee_uuid: uuidFrom(`payee:${b.payee}`),
  payee_name: b.payee,
  amount_cents: b.cents,
  currency: "USD",
  invoice_number: b.invoice,
  payment_status: b.status,
  issue_date: b.issue,
  due_date: b.due,
  payment_date: b.paid,
}));

// ─── Vendors (payees) for search_vendors: bill payees + notable merchants ────

const VENDOR_NAMES: string[] = [
  ...BILL_SEEDS.map((b) => b.payee),
  "Datadog",
  "Amazon Web Services",
  "Delta Air Lines",
  "Delta Airlines", // both spellings exist as distinct payee records, the variant, visible here too
  "Google Ads",
  "Figma",
];

export const VENDORS: VendorRecord[] = VENDOR_NAMES.map((name) => ({
  id: uuidFrom(`payee:${name}`),
  name,
  is_draft: false,
}));

// ─── Expense policy knowledge base (answer_policy_question) ───────────────────

export interface PolicyEntry {
  keywords: string[];
  answer: string;
}

export const POLICY_KB: PolicyEntry[] = [
  {
    keywords: ["meal", "meals", "dinner", "lunch", "restaurant", "entertainment", "food"],
    answer:
      "Meals & Entertainment are reimbursable up to $75 per person. Any single transaction above $500 requires prior manager approval; without it the charge is flagged out-of-policy. Alcohol is reimbursable only as part of a client meal.",
  },
  {
    keywords: ["flight", "flights", "airfare", "airline", "airlines"],
    answer:
      "Domestic flights must be booked in economy. Flights over 6 hours may be premium economy with manager approval; business class requires VP approval. Book through the Ramp travel tool when possible.",
  },
  {
    keywords: ["software", "saas", "subscription", "tool", "license"],
    answer:
      "Software and SaaS purchases over $2,500 per year must be routed through Procurement for review. Recurring subscriptions require an assigned owner and a renewal date.",
  },
  {
    keywords: ["hotel", "lodging", "airbnb", "accommodation"],
    answer:
      "Lodging is reimbursable up to $350 per night in most metros ($450 in NYC/SF). Anything higher needs manager approval before booking.",
  },
];

export const FIXTURE = {
  company: COMPANY,
  period: PERIOD,
  departments: DEPARTMENTS,
  users: USERS,
  merchants: MERCHANTS,
  transactions: TRANSACTIONS,
  bills: BILLS,
  vendors: VENDORS,
  policy: POLICY_KB,
} as const;
