import { describe, expect, it } from "vitest";
import { centsToDisplay, displayToCents, dollarsToCents, extractAmountsCents } from "./money.js";

describe("money", () => {
  it("formats cents as Ramp-style accounting strings", () => {
    expect(centsToDisplay(104825)).toBe("$1,048.25");
    expect(centsToDisplay(-25949)).toBe("-$259.49");
    expect(centsToDisplay(800)).toBe("$8.00");
    expect(centsToDisplay(5000000)).toBe("$50,000.00");
  });

  it("round-trips display -> cents", () => {
    expect(displayToCents("$1,048.25")).toBe(104825);
    expect(displayToCents("-$259.49")).toBe(-25949);
    expect(dollarsToCents(8400)).toBe(840000);
  });

  it("extracts every dollar amount from prose, signed", () => {
    const cents = extractAmountsCents("Net was $188,925.60 after a -$259.49 refund and an $8.00 charge.");
    expect(cents).toEqual([18892560, -25949, 800]);
  });

  it("does not drift on large sums (integer cents)", () => {
    const total = [840000, 840000, 840000, 840000].reduce((a, b) => a + b, 0);
    expect(centsToDisplay(total)).toBe("$33,600.00");
  });
});
