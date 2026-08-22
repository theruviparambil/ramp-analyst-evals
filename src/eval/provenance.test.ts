import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  it("a run's own untracked artifacts do not mark the harness dirty", () => {
    // The run creates out/<tag>/ before provenance is captured, so counting
    // untracked files made EVERY run report dirty:true and the flag useless.
    // Asserting dirty===false would only test whether this working tree is
    // clean, so the property is tested directly: creating an untracked file
    // must not change the answer.
    const before = harnessProvenance().dirty;
    const scratch = resolve(HERE, "..", "..", "out", "__provenance_probe__");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(resolve(scratch, "artifact.json"), "{}");
    try {
      expect(harnessProvenance().dirty).toBe(before);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    // The behavioural check above passes trivially when the tree is already
    // dirty from tracked edits, so the flag is also pinned structurally.
    const src = readFileSync(resolve(HERE, "provenance.ts"), "utf8");
    // Match the CALL, not the comment above it: an earlier version of this
    // assertion matched the explanatory comment and could never fail.
    expect(src).toMatch(/git\(\[\s*"status"[^\]]*--untracked-files=no/);
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
