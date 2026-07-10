/**
 * Bedrock judge transport — verified offline with a mocked fetch (no network,
 * no key). Covers the Converse request shape, response parsing, usage capture,
 * env resolution, and that an OpenAI agent + Bedrock judge reads as cross-family.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJudgeClient, judgeSharesFamilyWithAgent, resolveJudgeModel, toBedrockRequest } from "./provider.js";
import type { Message } from "./types.js";

const ENV_KEYS = [
  "JUDGE_TRANSPORT", "JUDGE_MODEL", "JUDGE_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK", "JUDGE_API_KEY",
  "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "AGENT_MODEL",
];

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("toBedrockRequest", () => {
  it("maps to the Converse shape: system top-level, content arrays, no temperature", () => {
    const messages: Message[] = [
      { role: "system", content: "You are a judge." },
      { role: "user", content: "Grade this." },
    ];
    const body = toBedrockRequest(messages, 500);
    expect(body.system).toEqual([{ text: "You are a judge." }]);
    expect(body.messages).toEqual([{ role: "user", content: [{ text: "Grade this." }] }]);
    expect(body.inferenceConfig).toEqual({ maxTokens: 500 });
    expect(JSON.stringify(body)).not.toContain("temperature");
  });
});

describe("resolveJudgeModel — bedrock", () => {
  it("resolves the cross-region inference profile from AWS_BEARER_TOKEN_BEDROCK", () => {
    process.env.JUDGE_TRANSPORT = "bedrock";
    process.env.AWS_BEARER_TOKEN_BEDROCK = "tok";
    const r = resolveJudgeModel();
    expect(r).toMatchObject({ transport: "bedrock", model: "us.anthropic.claude-sonnet-4-6", apiKey: "tok" });
    expect(r?.baseUrl).toContain("bedrock-runtime.us-east-1.amazonaws.com");
  });

  it("is null when the Bedrock token is absent", () => {
    process.env.JUDGE_TRANSPORT = "bedrock";
    expect(resolveJudgeModel()).toBeNull();
  });

  it("an OpenAI agent with a Bedrock judge is cross-family", () => {
    process.env.OPENAI_API_KEY = "sk-agent";
    process.env.JUDGE_TRANSPORT = "bedrock";
    process.env.AWS_BEARER_TOKEN_BEDROCK = "tok";
    expect(judgeSharesFamilyWithAgent()).toBe(false);
  });
});

describe("Bedrock judge client — full path (mocked fetch)", () => {
  it("sends the right Converse request and parses text + usage", async () => {
    process.env.JUDGE_TRANSPORT = "bedrock";
    process.env.AWS_BEARER_TOKEN_BEDROCK = "tok-123";
    process.env.JUDGE_MODEL = "us.anthropic.claude-sonnet-4-6";

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const payload = {
        output: { message: { content: [{ text: '{"pass": true, "reason": "grounded and correct"}' }] } },
        usage: { inputTokens: 120, outputTokens: 8 },
      };
      return { ok: true, status: 200, async json() { return payload; }, async text() { return ""; } } as unknown as Response;
    });

    const judge = createJudgeClient({ maxTokens: 500 });
    expect(judge).not.toBeNull();

    const turn = await judge!.chat(
      [{ role: "system", content: "grade" }, { role: "user", content: "Q" }],
      [],
    );

    expect(turn.text).toBe('{"pass": true, "reason": "grounded and correct"}');
    expect(turn.toolCalls).toEqual([]);

    const { url, init } = calls[0]!;
    expect(url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-6/converse");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.system).toEqual([{ text: "grade" }]);
    expect((body.messages as Array<{ content: Array<{ text: string }> }>)[0]!.content[0]!.text).toBe("Q");
    expect(body).not.toHaveProperty("temperature");

    expect(judge!.usage.promptTokens).toBe(120);
    expect(judge!.usage.completionTokens).toBe(8);
    expect(judge!.usage.calls).toBe(1);
  });

  it("throws with the status on a non-2xx response", async () => {
    process.env.JUDGE_TRANSPORT = "bedrock";
    process.env.AWS_BEARER_TOKEN_BEDROCK = "tok";
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 403, async json() { return {}; }, async text() { return "forbidden"; } } as unknown as Response));
    const judge = createJudgeClient()!;
    await expect(judge.chat([{ role: "user", content: "Q" }], [])).rejects.toThrow(/bedrock 403/);
  });
});
