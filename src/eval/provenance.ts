/**
 * Which harness produced a result file.
 *
 * A score is only comparable to another score if the same rubric produced both.
 * On 2026-08-21 the grading changed materially (exact entity matching, absolute
 * money tolerance, precision required on the anomaly questions) and every
 * previously written summary.json was, by its own contents, indistinguishable
 * from one written after. That is a receipt that cannot be audited.
 *
 * So each run records a fingerprint. The git commit is recorded when available,
 * but the load-bearing field is `gradingHash`: a digest of the files that decide
 * pass/fail. It is what actually changes when the bar moves, it is correct in a
 * dirty tree or a tarball with no .git, and two runs sharing it were graded by
 * identical rules whatever their commits say.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Every file whose contents can change whether a criterion passes. The fixture
 * and its oracle are included: regenerating the data moves the right answers,
 * which invalidates comparison exactly as surely as changing a threshold.
 */
export const GRADING_FILES = [
  "eval/golden.ts",
  "eval/structured.ts",
  "eval/checkers.ts",
  "eval/rubric.ts",
  "eval/trajectory.ts",
  "eval/spec.ts",
  "eval/judge.ts",
  "fixture/ground-truth.ts",
  "fixture/data.ts",
] as const;

export interface HarnessProvenance {
  commit: string | null;
  dirty: boolean | null;
  gradingHash: string;
  gradingFiles: number;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: HERE, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null; // not a checkout, or git is unavailable: not fatal, gradingHash still stands
  }
}

export function gradingHash(): string {
  const h = createHash("sha256");
  for (const rel of GRADING_FILES) {
    // Path and contents both, so moving logic between files changes the digest.
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(resolve(HERE, "..", rel)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

export function harnessProvenance(): HarnessProvenance {
  const commit = git(["rev-parse", "--short", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  return {
    commit,
    dirty: status === null ? null : status.length > 0,
    gradingHash: gradingHash(),
    gradingFiles: GRADING_FILES.length,
  };
}
