/**
 * `npm run ground-truth`: print the fixture's planted patterns and headline
 * aggregates, so a reviewer can eyeball what the analyst is expected to find
 * without reading any SQL.
 */
import { centsToDisplay } from "../money.js";
import { COMPANY, PERIOD, USERS, BILLS, VENDORS } from "./data.js";
import * as GT from "./ground-truth.js";

const line = (s = "") => console.log(s);
const money = centsToDisplay;

line(`${COMPANY.name}: ${PERIOD.label} (${PERIOD.start} .. ${PERIOD.end})`);
line("=".repeat(64));
line(`transactions: ${GT.transactionCount}   users: ${USERS.length} (${GT.activeUserCount} active, ${GT.inactiveUserCount} inactive)   bills: ${BILLS.length}   vendors: ${VENDORS.length}`);
line(`gross spend:  ${money(GT.grossCents)}`);
line(`refunds:      ${money(GT.refundCents)}`);
line(`net spend:    ${money(GT.netCents)}`);
line();

line("Top vendors (canonical):");
for (const v of GT.vendorSpend.slice(0, 5)) line(`  ${v.key.padEnd(24)} ${money(v.cents)}`);
line();

line("Spend by department:");
for (const d of GT.departmentSpend) line(`  ${d.key.padEnd(24)} ${money(d.cents)}`);
line();

line("Spend by category:");
for (const c of GT.categorySpend) line(`  ${c.key.padEnd(24)} ${money(c.cents)}`);
line();

line(`Top spender: ${GT.topSpender.key} (${money(GT.topSpender.cents)})`);
line(`Avg spend / active user: ${money(GT.avgSpendPerActiveUserCents)}`);
line();

line("PLANTED PATTERNS");
line("-".repeat(64));
line("(a) Duplicate charge:");
for (const d of GT.duplicatePairs) line(`    ${d.merchant_name} ${money(d.amount_cents)} on ${d.dates[0]} & ${d.dates[1]} (${d.user_name})`);
line();
line("(b) Vendor name variant:");
line(`    variants: ${GT.deltaVariants.join(" / ")}`);
line(`    combined Delta spend: ${money(GT.deltaCombinedCents)}`);
line();
line("(c) Out-of-policy:");
for (const o of GT.outOfPolicy) line(`    ${o.merchant_name} ${money(o.amount_cents)}, ${o.user_name} on ${o.date}`);
line();
line("(d) Month-over-month spike:");
const s = GT.biggestSpike;
line(`    ${s.category}: ${money(s.fromCents)} (M${s.fromMonth}) -> ${money(s.toCents)} (M${s.toMonth})  = +${money(s.deltaCents)} (${s.ratio.toFixed(1)}x)`);
line(`    driver: ${s.driverMerchant}`);
line();
line("Bills (AP):");
line(`    open:  ${money(GT.openBillsCents)} (${GT.openBillCount} bills)`);
line(`    paid:  ${money(GT.paidBillsCents)}`);
