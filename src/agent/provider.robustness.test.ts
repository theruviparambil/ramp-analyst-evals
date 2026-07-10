/**
 * Harness robustness: a slow/flaky request is infrastructure, not a wrong answer.
 * These verify the configurable timeout, transient-error classification, and the
 * retry loop — all offline with a mocked fetch, no key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderClient, isTransientError, resolveTimeoutMs, TransportError } from "./provider.js";
import type { ToolSpec } from "./types.js";

const ENV_KEYS = [
  "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "AWS_BEARER_TOKEN_BEDROCK",
  "AGENT_MODEL", "AGENT_TRANSPORT", "AGENT_TIMEOUT_MS", "AGENT_MAX_RETRIES", "AGENT_RETRY_BACKOFF_MS",
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.unstubAllGlobals();
});

describe("resolveTimeoutMs", () => {
  it("uses the env override when positive", () => {
    process.env.AGENT_TIMEOUT_MS = "300000";
    expect(resolveTimeoutMs("AGENT_TIMEOUT_MS", 240_000)).toBe(300_000);
  });
  it("falls back when unset, non-numeric, or non-positive", () => {
    expect(resolveTimeoutMs("AGENT_TIMEOUT_MS", 240_000)).toBe(240_000);
    process.env.AGENT_TIMEOUT_MS = "nope";
    expect(resolveTimeoutMs("AGENT_TIMEOUT_MS", 240_000)).toBe(240_000);
    process.env.AGENT_TIMEOUT_MS = "0";
    expect(resolveTimeoutMs("AGENT_TIMEOUT_MS", 240_000)).toBe(240_000);
  });
});

describe("isTransientError", () => {
  it("treats timeouts, 5xx, and 429 as transient", () => {
    expect(isTransientError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(isTransientError(new TransportError("openai 503", 503, true))).toBe(true);
    expect(isTransientError(new TransportError("openai 429", 429, true))).toBe(true);
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
  });
  it("treats 4xx and unknown errors as permanent", () => {
    expect(isTransientError(new TransportError("openai 400", 400, false))).toBe(false);
    expect(isTransientError(new Error("some logic bug"))).toBe(false);
  });
});

const OK_RESPONSE = {
  ok: true, status: 200,
  async json() { return { choices: [{ message: { content: "answer" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }; },
  async text() { return ""; },
} as unknown as Response;
const errResponse = (status: number) => ({ ok: false, status, async json() { return {}; }, async text() { return "err"; } } as unknown as Response);

function openaiAgent() {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.AGENT_MODEL = "gpt-4.1";
  process.env.AGENT_MAX_RETRIES = "2";
  process.env.AGENT_RETRY_BACKOFF_MS = "0"; // no real waiting in tests
  return createProviderClient({ maxTokens: 100 });
}
const NO_TOOLS: ToolSpec[] = [];

describe("retry loop — infra failures are retried, not scored as answers", () => {
  it("retries a transient 503 then succeeds; usage counts only the success", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => { n += 1; return n === 1 ? errResponse(503) : OK_RESPONSE; });
    const agent = openaiAgent();
    const turn = await agent.chat([{ role: "user", content: "q" }], NO_TOOLS);
    expect(turn.text).toBe("answer");
    expect(n).toBe(2);
    expect(agent.usage.calls).toBe(1);
    expect(agent.usage.promptTokens).toBe(5);
  });

  it("retries a timeout/abort then succeeds", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => { n += 1; if (n === 1) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" }); return OK_RESPONSE; });
    const agent = openaiAgent();
    const turn = await agent.chat([{ role: "user", content: "q" }], NO_TOOLS);
    expect(turn.text).toBe("answer");
    expect(n).toBe(2);
  });

  it("does NOT retry a permanent 400, and surfaces it", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => { n += 1; return errResponse(400); });
    const agent = openaiAgent();
    await expect(agent.chat([{ role: "user", content: "q" }], NO_TOOLS)).rejects.toThrow(/openai 400/);
    expect(n).toBe(1); // no retry on a client error
  });

  it("gives up after exhausting retries on a persistent transient error", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async () => { n += 1; return errResponse(503); });
    const agent = openaiAgent();
    await expect(agent.chat([{ role: "user", content: "q" }], NO_TOOLS)).rejects.toThrow(/openai 503/);
    expect(n).toBe(3); // 1 attempt + 2 retries
    expect(agent.usage.calls).toBe(0); // nothing succeeded
  });
});
