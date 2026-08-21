import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { receiptCollision, writeArtifacts } from "./run.js";
import { harnessProvenance } from "./provenance.js";

/**
 * `out/` holds committed receipts and is the DEFAULT output directory, so an
 * unguarded run overwrites published numbers in the working tree. These pin the
 * exact case that motivated the guard: `npm run demo` over the headline run.
 */
describe("receipt overwrite guard", () => {
  const headline = { model: "openai:gpt-5.1", tag: "eval", questions: 12 };

  it("blocks a 6-question demo from clobbering the 12-question headline run", () => {
    const differs = receiptCollision(headline, "openai:gpt-5.1", "demo", 6);
    expect(differs).toHaveLength(2);
    expect(differs.join(" ")).toContain("tag eval -> demo");
    expect(differs.join(" ")).toContain("questions 12 -> 6");
  });

  it("blocks a different model writing into another model's directory", () => {
    expect(receiptCollision(headline, "bedrock:claude-sonnet-4-6", "eval", 12)).toEqual([
      "model openai:gpt-5.1 -> bedrock:claude-sonnet-4-6",
    ]);
  });

  it("allows re-running the identical configuration", () => {
    expect(receiptCollision(headline, "openai:gpt-5.1", "eval", 12)).toEqual([]);
  });

  it("does not block on fields an older receipt never recorded", () => {
    // summary.json gained `questions` on 2026-08-21; receipts written before it
    // must still be re-runnable without --force.
    expect(receiptCollision({ model: "openai:gpt-5.1", tag: "eval" }, "openai:gpt-5.1", "eval", 12)).toEqual([]);
    expect(receiptCollision({}, "anything", "any", 1)).toEqual([]);
  });
});


/**
 * The write path runs after every API call has been paid for, so a failure here
 * throws away the whole run. These exercise it against a real temp directory.
 */
describe("writeArtifacts", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ramp-eval-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const score = (id: string, pass: boolean) =>
    ({
      id, question: "q", expected: "e", finalAnswer: "a", results: [],
      requiredTotal: 1, requiredPassed: pass ? 1 : 0, requiredPass: pass,
      additionalTotal: 0, additionalEvaluated: 0, additionalPassed: 0, additionalPass: true,
      steps: 1, hitStepCap: false,
    }) as never;

  it("persists every sample, stamped with a 1-based sample index", async () => {
    const samples = [
      { scores: [score("q01", true), score("q02", true)] },
      { scores: [score("q01", false), score("q02", true)] },
      { scores: [score("q01", true), score("q02", false)] },
    ];
    await writeArtifacts(dir, { model: "m" }, samples, ["t"]);
    const lines = (await readFile(resolve(dir, "results.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(6); // 3 samples x 2 questions, not just the last 2
    const rows = lines.map((l) => JSON.parse(l) as { sample: number; id: string; requiredPass: boolean });
    expect(rows.map((r) => r.sample)).toEqual([1, 1, 2, 2, 3, 3]);
    // The variance a multi-sample run is paid for must survive into the file.
    expect(rows.filter((r) => r.id === "q01").map((r) => r.requiredPass)).toEqual([true, false, true]);
  });

  it("writes a summary carrying the harness fingerprint", async () => {
    const meta = { model: "openai:x", harness: harnessProvenance() };
    await writeArtifacts(dir, meta, [{ scores: [score("q01", true)] }], ["t"]);
    const written = JSON.parse(await readFile(resolve(dir, "summary.json"), "utf8")) as { harness?: { gradingHash?: string } };
    expect(written.harness?.gradingHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("creates the output directory if it does not exist", async () => {
    const nested = resolve(dir, "a", "b");
    await writeArtifacts(nested, {}, [{ scores: [score("q01", true)] }], ["t"]);
    expect(await readFile(resolve(nested, "transcripts.md"), "utf8")).toBe("t");
  });
});
