/**
 * Money helpers.
 *
 * Everything is stored and summed as integer cents so aggregates are exact:
 * no float drift, ever. We only cross into other representations at the edges:
 *
 *   - The `get_user_transactions` tool mirrors Ramp's wire format, where card
 *     transaction amounts are formatted strings: "$1,048.25", "-$259.49".
 *   - The analyst DuckDB layer (`analyst.spend_facts`) stores DECIMAL dollars,
 *     matching how Ramp's analyst artifact represents money.
 *
 * The two formats diverging is a real Ramp gotcha (transactions = strings,
 * bills = numbers), so the fixture reproduces it and the eval checks the agent
 * formats money correctly in its final answer.
 */

/** Cents -> a signed accounting string, e.g. 104825 -> "$1,048.25", -25949 -> "-$259.49". */
export function centsToDisplay(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const grouped = dollars.toLocaleString("en-US");
  return `${sign}$${grouped}.${rem.toString().padStart(2, "0")}`;
}

/** Cents -> a plain dollar number (may carry float imprecision; only for DECIMAL bind / display). */
export function centsToDollars(cents: number): number {
  return cents / 100;
}

/** Dollars (number, as returned by DuckDB DECIMAL) -> cents, rounded. */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/**
 * Parse a Ramp-style money string ("$1,048.25", "-$259.49", "$8.00") back to
 * cents. Used by checkers that need to compare a value the agent quoted in the
 * wire format against the cents ground truth.
 */
export function displayToCents(display: string): number {
  const trimmed = display.trim();
  const negative = trimmed.startsWith("-");
  const digits = trimmed.replace(/[^0-9.]/g, "");
  const value = Math.round(Number.parseFloat(digits) * 100);
  return negative ? -value : value;
}

/** Extract every dollar amount mentioned in free text, as cents. Order-preserving. */
export function extractAmountsCents(text: string): number[] {
  const out: number[] = [];
  const re = /(-?)\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const sign = m[1] === "-" ? -1 : 1;
    const value = Math.round(Number.parseFloat(m[2].replace(/,/g, "")) * 100);
    out.push(sign * value);
  }
  return out;
}
