/**
 * Provider-agnostic LLM client with tool-calling — built on `fetch`, no vendor
 * SDKs (mirroring veriva-eval's zero-SDK ethos). Three transports cover the field:
 *
 *   - openai:    OpenAI-compatible /chat/completions with `tools` (also serves
 *                OpenRouter, and any OpenAI-compatible gateway).
 *   - anthropic: the Anthropic Messages API with `tools` / tool_use blocks.
 *   - bedrock:   AWS Bedrock Converse API with tool-calling (toolConfig /
 *                toolUse / toolResult). Auth is a Bearer token, so it still fits
 *                the no-SDK fetch ethos. It serves BOTH the judge (Claude judging
 *                GPT) and the agent (Claude driving the tool loop), enabling a
 *                two-way cross-FAMILY comparison.
 *
 * The agent model is resolved from the environment: AGENT_TRANSPORT=bedrock (with
 * AWS_BEARER_TOKEN_BEDROCK) selects Claude on Bedrock; otherwise precedence is
 * OPENROUTER > OPENAI > ANTHROPIC, with AGENT_MODEL as an override. Tests never
 * touch the network — they use the scripted client, or a mocked fetch.
 */

import type { AssistantTurn, LLMClient, Message, ToolCallRequest, ToolSpec } from "./types.js";

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};

type Transport = "openai" | "anthropic" | "bedrock";

interface Resolved {
  transport: Transport;
  model: string;
  apiKey: string;
  baseUrl: string;
  label: string;
}

/** Resolve the agent model from the environment, or null if no key is set. */
export function resolveAgentModel(): Resolved | null {
  const override = env("AGENT_MODEL");
  if (env("AGENT_TRANSPORT") === "bedrock") {
    const key = env("AWS_BEARER_TOKEN_BEDROCK");
    if (!key) return null;
    return {
      transport: "bedrock",
      model: override ?? "us.anthropic.claude-sonnet-4-6",
      apiKey: key,
      baseUrl: env("BEDROCK_BASE_URL") ?? "https://bedrock-runtime.us-east-1.amazonaws.com",
      label: "bedrock",
    };
  }
  if (env("OPENROUTER_API_KEY")) {
    return { transport: "openai", model: override ?? "openai/gpt-5.1", apiKey: env("OPENROUTER_API_KEY")!, baseUrl: "https://openrouter.ai/api/v1", label: "openrouter" };
  }
  if (env("OPENAI_API_KEY")) {
    return { transport: "openai", model: override ?? "gpt-5.1", apiKey: env("OPENAI_API_KEY")!, baseUrl: env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1", label: "openai" };
  }
  if (env("ANTHROPIC_API_KEY")) {
    return { transport: "anthropic", model: override ?? "claude-sonnet-4-6", apiKey: env("ANTHROPIC_API_KEY")!, baseUrl: "https://api.anthropic.com", label: "anthropic" };
  }
  return null;
}

/** A model deliberately different from the agent's, to blunt (not remove) self-preference. */
function differentFromAgent(agentModel: string): string {
  if (/gpt-5/i.test(agentModel)) return "gpt-4.1";
  if (/gpt-4/i.test(agentModel)) return "gpt-4.1-mini";
  if (/claude/i.test(agentModel)) return "claude-3-5-haiku-latest";
  return agentModel;
}

/**
 * Resolve the JUDGE model. One-env-var swap for a truly independent judge:
 *   - JUDGE_TRANSPORT=bedrock runs the judge on AWS Bedrock (Converse API) with
 *     AWS_BEARER_TOKEN_BEDROCK — a real cross-FAMILY judge (e.g. Claude judging
 *     GPT). JUDGE_MODEL defaults to the cross-region inference profile
 *     `us.anthropic.claude-sonnet-4-6` (the `us.` prefix is required).
 *   - JUDGE_API_KEY (+ optional JUDGE_TRANSPORT=anthropic, JUDGE_BASE_URL) runs
 *     the judge on a separate OpenAI-compatible or Anthropic provider.
 *   - Otherwise the judge reuses the agent's key/provider but defaults to a
 *     DIFFERENT model than the agent (self-preference mitigation, not removal).
 *   - JUDGE_MODEL overrides the model id in every case.
 * Returns null if no key at all.
 */
export function resolveJudgeModel(): Resolved | null {
  const judgeModel = env("JUDGE_MODEL");
  const transportEnv = env("JUDGE_TRANSPORT");
  if (transportEnv === "bedrock") {
    const key = env("AWS_BEARER_TOKEN_BEDROCK") ?? env("JUDGE_API_KEY");
    if (!key) return null;
    return {
      transport: "bedrock",
      model: judgeModel ?? "us.anthropic.claude-sonnet-4-6",
      apiKey: key,
      baseUrl: env("JUDGE_BASE_URL") ?? "https://bedrock-runtime.us-east-1.amazonaws.com",
      label: "bedrock",
    };
  }
  const judgeKey = env("JUDGE_API_KEY");
  if (judgeKey) {
    const transport: Transport = transportEnv === "anthropic" ? "anthropic" : "openai";
    const baseUrl = env("JUDGE_BASE_URL") ?? (transport === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1");
    return { transport, model: judgeModel ?? (transport === "anthropic" ? "claude-sonnet-4-6" : "gpt-4.1"), apiKey: judgeKey, baseUrl, label: "judge" };
  }
  const agent = resolveAgentModel();
  if (!agent) return null;
  return { ...agent, model: judgeModel ?? differentFromAgent(agent.model), label: "judge" };
}

/** Whether the judge shares the agent's provider family (self-preference risk). */
export function judgeSharesFamilyWithAgent(): boolean {
  const a = resolveAgentModel();
  const j = resolveJudgeModel();
  if (!a || !j) return false;
  return a.transport === j.transport && a.baseUrl === j.baseUrl;
}

export interface ProviderOptions {
  maxTokens?: number;
  timeoutMs?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

/** A provider client that also accumulates token usage across calls. */
export interface ProviderClient extends LLMClient {
  readonly usage: Usage;
}

function buildClient(resolved: Resolved, opts: ProviderOptions): ProviderClient {
  const maxTokens = opts.maxTokens ?? 1200;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const usage: Usage = { promptTokens: 0, completionTokens: 0, calls: 0 };

  return {
    label: `${resolved.label}:${resolved.model}`,
    usage,
    async chat(messages: Message[], tools: ToolSpec[]): Promise<AssistantTurn> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const { turn, prompt, completion } =
          resolved.transport === "bedrock"
            ? await chatBedrock(resolved, messages, tools, maxTokens, controller.signal)
            : resolved.transport === "anthropic"
              ? await chatAnthropic(resolved, messages, tools, maxTokens, controller.signal)
              : await chatOpenAI(resolved, messages, tools, maxTokens, controller.signal);
        usage.promptTokens += prompt;
        usage.completionTokens += completion;
        usage.calls += 1;
        return turn;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createProviderClient(opts: ProviderOptions = {}): ProviderClient {
  const resolved = resolveAgentModel();
  if (!resolved) {
    throw new Error("no LLM key set — provide OPENROUTER_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY (see .env.example)");
  }
  return buildClient(resolved, opts);
}

/** The judge client — a separate model (and optionally a separate provider). Null if no key. */
export function createJudgeClient(opts: ProviderOptions = {}): ProviderClient | null {
  const resolved = resolveJudgeModel();
  return resolved ? buildClient(resolved, opts) : null;
}

interface TransportResult {
  turn: AssistantTurn;
  prompt: number;
  completion: number;
}

// ─── OpenAI-compatible transport ──────────────────────────────────────────────

function toOpenAIMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.text || null,
          ...(m.toolCalls.length
            ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

/** Reasoning families (gpt-5*, o*) reject temperature and spend hidden reasoning tokens. */
function isReasoningModel(model: string): boolean {
  return /(^|\/)(o\d|gpt-5)/i.test(model);
}

async function chatOpenAI(r: Resolved, messages: Message[], tools: ToolSpec[], maxTokens: number, signal: AbortSignal): Promise<TransportResult> {
  const reasoning = isReasoningModel(r.model);
  const body: Record<string, unknown> = {
    model: r.model,
    // Reasoning models only accept the default temperature; give them more room
    // for hidden reasoning tokens.
    max_completion_tokens: reasoning ? Math.max(maxTokens, 4000) : maxTokens,
    messages: toOpenAIMessages(messages),
  };
  if (!reasoning) body.temperature = 0;
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = "auto";
  }
  const res = await fetch(`${r.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${r.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const msg = json.choices?.[0]?.message ?? {};
  const toolCalls: ToolCallRequest[] = (msg.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: safeJson(tc.function.arguments),
  }));
  return {
    turn: { text: (msg.content ?? "").trim(), toolCalls },
    prompt: json.usage?.prompt_tokens ?? 0,
    completion: json.usage?.completion_tokens ?? 0,
  };
}

// ─── Anthropic transport ──────────────────────────────────────────────────────

function toAnthropicMessages(messages: Message[]): { system: string; messages: unknown[] } {
  const systemParts: string[] = [];
  const out: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.content }] });
    } else if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.text) content.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls) content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      out.push({ role: "assistant", content });
    } else {
      // tool result -> a user message; merge consecutive tool results into one.
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && (last.content[0] as { type?: string })?.type === "tool_result") {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

async function chatAnthropic(r: Resolved, messages: Message[], tools: ToolSpec[], maxTokens: number, signal: AbortSignal): Promise<TransportResult> {
  const { system, messages: amsgs } = toAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model: r.model,
    max_tokens: maxTokens,
    temperature: 0,
    system,
    messages: amsgs,
  };
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  const res = await fetch(`${r.baseUrl}/v1/messages`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-api-key": r.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const blocks = json.content ?? [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  const toolCalls: ToolCallRequest[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id!, name: b.name!, args: b.input ?? {} }));
  return {
    turn: { text, toolCalls },
    prompt: json.usage?.input_tokens ?? 0,
    completion: json.usage?.output_tokens ?? 0,
  };
}

// ─── AWS Bedrock Converse transport (agent tool-calling + judge text) ──────────

type BedrockTextBlock = { text: string };
type BedrockToolUseBlock = { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } };
type BedrockToolResultBlock = { toolResult: { toolUseId: string; content: BedrockTextBlock[] } };
type BedrockContentBlock = BedrockTextBlock | BedrockToolUseBlock | BedrockToolResultBlock;

export interface BedrockRequestBody {
  messages: Array<{ role: "user" | "assistant"; content: BedrockContentBlock[] }>;
  system?: BedrockTextBlock[];
  inferenceConfig: { maxTokens: number };
  toolConfig?: { tools: Array<{ toolSpec: { name: string; description: string; inputSchema: { json: Record<string, unknown> } } }> };
}

/**
 * Map normalized messages into the Bedrock Converse shape. `content` is an ARRAY
 * of blocks (`text`, `toolUse`, `toolResult`); `system` is a TOP-LEVEL array; and
 * no temperature is sent (reasoning models reject non-default). When `tools` are
 * given, they become `toolConfig.tools` so Claude can drive the agent loop.
 * Exported for tests.
 */
export function toBedrockRequest(messages: Message[], maxTokens: number, tools: ToolSpec[] = []): BedrockRequestBody {
  const systemParts: string[] = [];
  const out: BedrockRequestBody["messages"] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else if (m.role === "user") {
      out.push({ role: "user", content: [{ text: m.content }] });
    } else if (m.role === "assistant") {
      const content: BedrockContentBlock[] = [];
      if (m.text) content.push({ text: m.text });
      for (const tc of m.toolCalls) content.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: tc.args } });
      if (content.length) out.push({ role: "assistant", content }); // Converse rejects empty content
    } else {
      // Tool result -> a user message with a toolResult block; merge a run of them.
      const block: BedrockToolResultBlock = { toolResult: { toolUseId: m.toolCallId, content: [{ text: m.content }] } };
      const last = out[out.length - 1];
      if (last && last.role === "user" && last.content.every((b) => "toolResult" in b)) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  const body: BedrockRequestBody = { messages: out, inferenceConfig: { maxTokens } };
  if (systemParts.length) body.system = systemParts.map((t) => ({ text: t }));
  if (tools.length) {
    body.toolConfig = { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } } })) };
  }
  return body;
}

async function chatBedrock(r: Resolved, messages: Message[], tools: ToolSpec[], maxTokens: number, signal: AbortSignal): Promise<TransportResult> {
  const url = `${r.baseUrl.replace(/\/$/, "")}/model/${r.model}/converse`;
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${r.apiKey}` },
    body: JSON.stringify(toBedrockRequest(messages, maxTokens, tools)),
  });
  if (!res.ok) throw new Error(`bedrock ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    output?: { message?: { content?: Array<{ text?: string; toolUse?: { toolUseId: string; name: string; input?: Record<string, unknown> } }> } };
    usage?: { inputTokens?: number; outputTokens?: number };
  };
  const blocks = json.output?.message?.content ?? [];
  const text = blocks.filter((b) => typeof b.text === "string").map((b) => b.text ?? "").join("").trim();
  const toolCalls: ToolCallRequest[] = blocks
    .filter((b): b is { toolUse: { toolUseId: string; name: string; input?: Record<string, unknown> } } => !!b.toolUse)
    .map((b) => ({ id: b.toolUse.toolUseId, name: b.toolUse.name, args: b.toolUse.input ?? {} }));
  return { turn: { text, toolCalls }, prompt: json.usage?.inputTokens ?? 0, completion: json.usage?.outputTokens ?? 0 };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
