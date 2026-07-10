import { describe, expect, it } from "vitest";
import type { Trajectory } from "../agent/types.js";
import {
  parseStructured,
  structIntEquals,
  structItemsContain,
  structItemsExact,
  structScalarUsd,
  structStringSet,
  structTopEntry,
  structVectorUsd,
} from "./structured.js";

const emptyTraj: Trajectory = { question: "", steps: [], notes: [], finalAnswer: "", hitStepCap: false, modelLabel: "x" };
const ctx = (finalAnswer: string) => ({ question: "", finalAnswer, trajectory: emptyTraj });
const block = (obj: unknown) => `Here is my analysis.\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

describe("parseStructured", () => {
  it("reads the last fenced json block", () => {
    expect(parseStructured(block({ a: 1 }))).toEqual({ a: 1 });
  });
  it("returns null when there is no object", () => {
    expect(parseStructured("no json here")).toBeNull();
  });
});

describe("scalar / int equality", () => {
  it("matches an exact dollar value (dotted path ok)", () => {
    expect(structScalarUsd(ctx(block({ spike: { to_usd: 50000 } })), "spike.to_usd", 5000000).pass).toBe(true);
  });
  it("fails a wrong value", () => {
    expect(structScalarUsd(ctx(block({ net_spend_usd: 2184.5 })), "net_spend_usd", 18892560).pass).toBe(false);
  });
  it("fails when the JSON block is absent", () => {
    expect(structScalarUsd(ctx("I think it was about $188,925.60"), "net_spend_usd", 18892560).pass).toBe(false);
  });
  it("int equality", () => {
    expect(structIntEquals(ctx(block({ active_users: 13 })), "active_users", 13).pass).toBe(true);
    expect(structIntEquals(ctx(block({ active_users: 15 })), "active_users", 13).pass).toBe(false);
  });
});

describe("top entry + vector", () => {
  it("top entry needs both name and value right", () => {
    expect(structTopEntry(ctx(block({ top_vendor: { name: "Google Ads", spend_usd: 42500 } })), "top_vendor", "name", "spend_usd", "Google Ads", 4250000).pass).toBe(true);
    expect(structTopEntry(ctx(block({ top_vendor: { name: "Datadog", spend_usd: 33600 } })), "top_vendor", "name", "spend_usd", "Google Ads", 4250000).pass).toBe(false);
  });
  it("vector requires every entry to match and no extras", () => {
    const expected = [{ key: "Engineering", cents: 100000 }, { key: "Sales", cents: 50000 }];
    expect(structVectorUsd(ctx(block({ v: [{ d: "Engineering", s: 1000 }, { d: "Sales", s: 500 }] })), "v", "d", "s", expected).pass).toBe(true);
    expect(structVectorUsd(ctx(block({ v: [{ d: "Engineering", s: 1000 }] })), "v", "d", "s", expected).pass).toBe(false);
  });
});

describe("item sets (the q04 closer)", () => {
  const expected = [{ merchant: "Datadog", cents: 840000, dates: ["2026-05-12", "2026-05-15"] }];

  it("an empty duplicates array FAILS containment (the false-negative)", () => {
    expect(structItemsContain(ctx(block({ duplicates: [] })), "duplicates", "merchant", "amount_usd", [{ merchant: "Datadog", cents: 840000 }]).pass).toBe(false);
  });
  it("the correct pair passes containment and exact", () => {
    const answer = ctx(block({ duplicates: [{ merchant: "Datadog", amount_usd: 8400, dates: ["2026-05-12", "2026-05-15"] }] }));
    expect(structItemsContain(answer, "duplicates", "merchant", "amount_usd", expected).pass).toBe(true);
    expect(structItemsExact(answer, "duplicates", "merchant", "amount_usd", expected).pass).toBe(true);
  });
  it("a spurious extra fails exact but not containment", () => {
    const answer = ctx(block({ duplicates: [{ merchant: "Datadog", amount_usd: 8400, dates: ["2026-05-12", "2026-05-15"] }, { merchant: "Uber", amount_usd: 35.93, dates: ["2026-06-10", "2026-06-17"] }] }));
    expect(structItemsContain(answer, "duplicates", "merchant", "amount_usd", expected).pass).toBe(true);
    expect(structItemsExact(answer, "duplicates", "merchant", "amount_usd", expected).pass).toBe(false);
  });
});

describe("string set (variants)", () => {
  it("requires every expected spelling", () => {
    expect(structStringSet(ctx(block({ variants: ["Delta Air Lines", "Delta Airlines"] })), "variants", ["Delta Air Lines", "Delta Airlines"]).pass).toBe(true);
    expect(structStringSet(ctx(block({ variants: ["Delta Air Lines"] })), "variants", ["Delta Air Lines", "Delta Airlines"]).pass).toBe(false);
  });
});
