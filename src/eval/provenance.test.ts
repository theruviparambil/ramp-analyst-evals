import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GRADING_FILES, gradingHash, harnessProvenance } from "./provenance.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("harness provenance", () => {
  it("gradingHash is deterministic", () => {
    expect(gradingHash()).toBe(gradingHash());
    expect(gradingHash()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("every grading file is readable (a rename must break the build, not silently drop from the digest)", () => {
    expect(() => gradingHash()).not.toThrow();
    expect(GRADING_FILES.length).toBeGreaterThan(0);
  });

  it("summary provenance carries the hash even outside a git checkout", () => {
    const p = harnessProvenance();
    expect(p.gradingHash).toMatch(/^[0-9a-f]{16}$/);
    expect(p.gradingFiles).toBe(GRADING_FILES.length);
    // commit/dirty are best-effort; gradingHash is the load-bearing field.
    expect(p.commit === null || /^[0-9a-f]{7,}$/.test(p.commit)).toBe(true);
  });

  /**
   * Drift guard. A new module that decides pass/fail must be added to
   * GRADING_FILES, or two runs graded by different rules would share a
   * fingerprint. Anything genuinely not grading-related is listed here.
   */
  it("no eval module that affects grading is missing from GRADING_FILES", () => {
    const NOT_GRADING = new Set(["run.ts", "report.ts", "env.ts", "provenance.ts"]);
    const covered = new Set(GRADING_FILES.map((f) => f.replace(/^eval\//, "")));
    const uncovered = readdirSync(resolve(HERE))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => !NOT_GRADING.has(f) && !covered.has(f));
    expect(uncovered).toEqual([]);
  });
});
