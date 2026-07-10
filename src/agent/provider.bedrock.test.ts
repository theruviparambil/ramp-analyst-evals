/**
 * Bedrock judge transport — verified offline with a mocked fetch (no network,
 * no key). Covers the Converse request shape, response parsing, usage capture,
 * env resolution, and that an OpenAI agent + Bedrock judge reads as cross-family.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJudgeClient, createProviderClient, judgeSharesFamilyWithAgent, resolveAgentModel, resolveJudgeModel, toBedrockRequest, type BedrockRequestBody } from "./provider.js";
import type { Message, ToolSpec } from "./types.js";

const ENV_KEYS = [
  "JUDGE_TRANSPORT", "JUDGE_MODEL", "JUDGE_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK", "JUDGE_API_KEY",
  "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "AGENT_MODEL", "AGENT_TRANSPORT", "BEDROCK_BASE_URL",
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

// ─── Agent tool-calling on Bedrock (Claude driving the loop) ───────────────────

const toolResultId = (block: unknown): string | undefined =>
  block && typeof block === "object" && "toolResult" in block
    ? (block as { toolResult: { toolUseId: string } }).toolResult.toolUseId
    : undefined;

describe("toBedrockRequest — tool-calling shape", () => {
  it("builds toolConfig and maps toolUse (assistant) + toolResult (user) blocks", () => {
    const tools: ToolSpec[] = [
      { name: "execute_analyst_query", description: "run sql", parameters: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
    ];
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q" },
      { role: "assistant", text: "let me query", toolCalls: [{ id: "t1", name: "execute_analyst_query", args: { sql: "SELECT 1" } }] },
      { role: "tool", toolCallId: "t1", name: "execute_analyst_query", content: '{"rows":[]}' },
    ];
    const body = toBedrockRequest(messages, 1000, tools);

    expect(body.toolConfig?.tools[0]!.toolSpec).toMatchObject({
      name: "execute_analyst_query",
      description: "run sql",
      inputSchema: { json: tools[0]!.parameters },
    });
    const asst = body.messages.find((m) => m.role === "assistant")!;
    expect(asst.content).toEqual([
      { text: "let me query" },
      { toolUse: { toolUseId: "t1", name: "execute_analyst_query", input: { sql: "SELECT 1" } } },
    ]);
    const lastUser = body.messages[body.messages.length - 1]!;
    expect(lastUser.role).toBe("user");
    expect(lastUser.content[0]).toEqual({ toolResult: { toolUseId: "t1", content: [{ text: '{"rows":[]}' }] } });
  });

  it("merges a run of tool results into one user message", () => {
    const messages: Message[] = [
      { role: "assistant", text: "", toolCalls: [{ id: "a", name: "x", args: {} }, { id: "b", name: "y", args: {} }] },
      { role: "tool", toolCallId: "a", name: "x", content: "ra" },
      { role: "tool", toolCallId: "b", name: "y", content: "rb" },
    ];
    const body = toBedrockRequest(messages, 100, []);
    const userMsgs = body.messages.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]!.content).toHaveLength(2);
    expect(body.toolConfig).toBeUndefined(); // no tools -> no toolConfig
  });
});

describe("resolveAgentModel — Bedrock agent", () => {
  it("selects Claude on Bedrock under AGENT_TRANSPORT=bedrock", () => {
    process.env.AGENT_TRANSPORT = "bedrock";
    process.env.AWS_BEARER_TOKEN_BEDROCK = "tok";
    expect(resolveAgentModel()).toMatchObject({ transport: "bedrock", model: "us.anthropic.claude-sonnet-4-6", apiKey: "tok" });
  });

  it("a Claude agent with an OpenAI judge is cross-family", () => {
    process.env.AGENT_TRANSPORT = "bedrock";
    process.env.AWS_BEARER_TOKEN_BEDROCK = "tok";
    process.env.JUDGE_API_KEY = "sk-judge";
    process.env.JUDGE_MODEL = "gpt-5.1";
    expect(judgeSharesFamilyWithAgent()).toBe(false);
  });
});

describe("Bedrock agent — tool-use round trip (mocked fetch)", () => {
  it("emits toolConfig, returns a toolUse, then answers after a toolResult", async () => {
    process.env.AGENT_TRANSPORT = "bedrock";
    process.env.AWS_BEARER_TOKEN_BEDROCK = "tok";
    process.env.AGENT_MODEL = "us.anthropic.claude-sonnet-4-6";

    const bodies: BedrockRequestBody[] = [];
    let n = 0;
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string) as BedrockRequestBody);
      n += 1;
      const payload = n === 1
        ? { output: { message: { content: [{ text: "I'll check the catalog." }, { toolUse: { toolUseId: "tu1", name: "get_analyst_catalog", input: { rationale: "discover" } } }] } }, stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 20 } }
        : { output: { message: { content: [{ text: "Top vendor is Google Ads, $42,500.00." }] } }, stopReason: "end_turn", usage: { inputTokens: 150, outputTokens: 10 } };
      return { ok: true, status: 200, async json() { return payload; }, async text() { return ""; } } as unknown as Response;
    });

    const agent = createProviderClient({ maxTokens: 1000 });
    const tools: ToolSpec[] = [{ name: "get_analyst_catalog", description: "catalog", parameters: { type: "object", properties: {}, required: [] } }];

    const turn1 = await agent.chat([{ role: "system", content: "s" }, { role: "user", content: "top vendor?" }], tools);
    expect(turn1.toolCalls).toEqual([{ id: "tu1", name: "get_analyst_catalog", args: { rationale: "discover" } }]);
    expect(turn1.text).toBe("I'll check the catalog.");
    expect(bodies[0]!.toolConfig?.tools[0]!.toolSpec.name).toBe("get_analyst_catalog");

    const turn2 = await agent.chat([
      { role: "system", content: "s" },
      { role: "user", content: "top vendor?" },
      { role: "assistant", text: turn1.text, toolCalls: turn1.toolCalls },
      { role: "tool", toolCallId: "tu1", name: "get_analyst_catalog", content: '{"analyst_tables":[]}' },
    ], tools);
    expect(turn2.toolCalls).toEqual([]);
    expect(turn2.text).toContain("$42,500.00");

    const lastMsg = bodies[1]!.messages[bodies[1]!.messages.length - 1]!;
    expect(lastMsg.role).toBe("user");
    expect(toolResultId(lastMsg.content[0])).toBe("tu1");

    expect(agent.usage.calls).toBe(2);
    expect(agent.usage.promptTokens).toBe(250);
    expect(agent.usage.completionTokens).toBe(30);
  });
});
