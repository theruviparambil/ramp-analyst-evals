/**
 * Every number in the README, checked against the code and receipts that
 * produce it.
 *
 * This exists because the same guard in judgecheck caught a real error during
 * a README rewrite: claims were reworded into a state where they were no
 * longer checkable, and the suite said so. A README is the first thing a
 * reader trusts and the last thing anyone re-verifies, so its numbers are
 * pinned like any other output.
 *
 * Each assertion looks the claim up by PATTERN and fails if the pattern is
 * gone, so deleting a number is as loud as changing one.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GOLDEN } from "./golden.js";
import { GRADING_FILES, gradingHash } from "./provenance.js";
import * as GT from "../fixture/ground-truth.js";
import { TRANSACTIONS } from "../fixture/data.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const README = readFileSync(resolve(ROOT, "README.md"), "utf8");

function find(pattern: RegExp): RegExpMatchArray {
  const m = README.match(pattern);
  expect(m, `README no longer contains a claim matching: ${pattern}`).not.toBeNull();
  return m!;
}

const receipt = (dir: string) =>
  JSON.parse(readFileSync(resolve(ROOT, "out", dir, "summary.json"), "utf8")) as {
    model: string;
    requiredTier: { mean: number; perSample: number[] };
    additionalTier: { mean: number; perSample: number[] };
    usage: { totalCostUsd: number };
    harness: { gradingHash: string };
    perQuestion: Array<{ id: string; requiredPass: number; samples: number }>;
  };

describe("README claims: the headline result", () => {
  const terra = receipt("gpt-5.6-terra");
  const sonnet = receipt("claude-sonnet-5");

  it("the two receipts really are a matched pair", () => {
    // The whole comparison rests on this. If the hashes diverge the table is
    // comparing rubric versions, not models.
    expect(terra.harness.gradingHash).toBe(sonnet.harness.gradingHash);
    expect(terra.harness.gradingHash).toBe(gradingHash());
  });

  it("the question count is right", () => {
    const [, n] = find(/(\d+) questions, \*\*3 samples each\*\*/);
    expect(Number(n)).toBe(GOLDEN.length);
    expect(README).toContain(`golden%20set-${GOLDEN.length}%20questions`);
  });

  it.each([
    ["gpt-5.6-terra", "gpt-5.6-terra"],
    ["claude-sonnet-5", "claude-sonnet-5"],
  ])("tier percentages for %s match the receipt", (_label, dir) => {
    const r = receipt(dir);
    const pct = (x: number) => (x * 100).toFixed(1);
    expect(README).toContain(`**${pct(r.requiredTier.mean)}%**`);
    expect(README).toContain(`**${pct(r.additionalTier.mean)}%**`);
    // Compared numerically: the README writes a clean 100 where toFixed(1)
    // would give 100.0, and that formatting choice is not a claim.
    const shown = find(new RegExp(`\\*\\*${pct(r.requiredTier.mean)}%\\*\\* \\(([^)]+)\\)`))[1]!;
    const nums = shown.split("/").map((x) => Number(x.trim()));
    expect(nums).toEqual(r.requiredTier.perSample.map((x) => Number((x * 100).toFixed(1))));
  });

  it("the per-question failure table matches the receipts", () => {
    const pass = (r: ReturnType<typeof receipt>, id: string) =>
      r.perQuestion.find((p) => p.id.startsWith(id))!;

    // The finding the README leads with: a deterministic blind spot vs variance.
    expect(pass(terra, "q09").requiredPass).toBe(0);
    expect(pass(sonnet, "q09").requiredPass).toBe(3);
    expect(pass(sonnet, "q19").requiredPass).toBe(2);
    expect(pass(sonnet, "q20").requiredPass).toBe(2);
    expect(pass(terra, "q19").requiredPass).toBe(3);
    expect(pass(terra, "q20").requiredPass).toBe(3);
    find(/q09 software total \| \*\*0\/3\*\* \| 3\/3/);
  });

  it("'the other 19' is arithmetic, not a guess", () => {
    const [, n] = find(/the other (\d+) \| 3\/3 \| 3\/3/);
    const discriminating = new Set<string>();
    for (const r of [terra, sonnet]) {
      for (const p of r.perQuestion) if (p.requiredPass !== p.samples) discriminating.add(p.id);
    }
    expect(Number(n)).toBe(GOLDEN.length - discriminating.size);
    find(new RegExp(`${GOLDEN.length - discriminating.size} of ${GOLDEN.length} questions are 3/3`));
  });

  it("the stated costs match the receipts", () => {
    for (const r of [terra, sonnet]) {
      expect(README).toContain(`$${r.usage.totalCostUsd.toFixed(2)}`);
    }
  });
});

describe("README claims: the planted traps", () => {
  it("the orphaned-merchant gap is what the oracle computes", () => {
    const [, gap] = find(/one \$([\d,]+) charge to a merchant missing from/);
    expect(Number(gap.replace(/,/g, "")) * 100).toBe(GT.vendorReconciledCents.droppedCents);
  });

  it("the q09 numbers are the real wrong and right answers", () => {
    const [, wrong, right] = find(/reports \$([\d,.]+) against a true \$([\d,.]+)/);
    const software = GT.categoryTotalCents("SaaS / Software");
    expect(Math.round(Number(right.replace(/,/g, "")) * 100)).toBe(software);
    expect(Math.round(Number(wrong.replace(/,/g, "")) * 100)).toBe(software - GT.vendorReconciledCents.droppedCents);
  });

  it("the department-transfer misattribution is real", () => {
    const [, wrong, right] = find(/reports Sales\s*\n?\s*at \$([\d,.]+) against a true \$([\d,.]+)/);
    const sales = GT.departmentSpend.find((d) => d.key === "Sales")!;
    expect(Math.round(Number(right.replace(/,/g, "")) * 100)).toBe(sales.cents);
    expect(Number(wrong.replace(/,/g, ""))).toBeGreaterThan(Number(right.replace(/,/g, "")));
  });

  it("mean and median match the oracle", () => {
    const [, mean, median] = find(/mean \$([\d,.]+) vs median \$([\d,.]+)/);
    expect(Math.round(Number(mean.replace(/,/g, "")) * 100)).toBe(GT.typicalPurchase.meanCents);
    expect(Math.round(Number(median.replace(/,/g, "")) * 100)).toBe(GT.typicalPurchase.medianCents);
  });

  it("the tie really is a tie, at the stated size", () => {
    const [, a, b, n] = find(/(\w+) and (\w+) \*\*tie\*\* at (\d+) departments/);
    expect([...GT.widestReachPrograms].sort()).toEqual([a, b].sort());
    expect(GT.programDepartmentReach[0]!.departments).toBe(Number(n));
  });

  it("the open-bill and travel-gap figures match", () => {
    const [, open] = find(/\$([\d,]+) of OPEN bills are commitments/);
    expect(Number(open.replace(/,/g, "")) * 100).toBe(GT.openBillsCents);
    const [, gap] = find(/Two defensible readings \$([\d,]+) apart/);
    expect(Number(gap.replace(/,/g, "")) * 100).toBe(GT.travelSpend.byProgramCents - GT.travelSpend.byCategoryCents);
  });

  it("the refund and transaction counts match the fixture", () => {
    const [, refunds] = find(/(\d+) refunds exist, one outside the quarter/);
    expect(Number(refunds)).toBe(GT.refundsAllTimeCount);
    const [, txns] = find(/(\d+) synthetic transactions with/);
    expect(Number(txns)).toBe(TRANSACTIONS.length);
  });

  it("q17 really has no budget column to find", () => {
    find(/\*\*Unanswerable\.\*\* No budget column exists/);
    expect(GOLDEN.some((q) => q.id === "q17_unanswerable_budget")).toBe(true);
  });
});

describe("README claims: the harness", () => {
  it("the gradingHash file count is right", () => {
    const [, n] = find(/digest of\s*\n?\s*the (\w+) files that decide pass or fail/);
    const words: Record<string, number> = { seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11 };
    expect(words[n]).toBe(GRADING_FILES.length);
  });

  it("the advertised test count is the real one", () => {
    const [, badge] = find(/tests-(\d+)-brightgreen/);
    const [, prose] = find(/npm test\s+# (\d+) tests, fully offline/);
    expect(badge).toBe(prose);
    // Pinned against the suite itself: `vitest list` counts the real tests, so
    // the badge cannot drift as tests are added.
    const listed = execFileSync("npx", ["vitest", "list"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024,
    });
    const actual = listed.trim().split("\n").filter((l) => l.includes(" > ")).length;
    expect(Number(badge)).toBe(actual);
  });
});
