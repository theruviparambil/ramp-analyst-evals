/**
 * Provider-agnostic LLM client with tool-calling — built on `fetch`, no vendor
 * SDKs (mirroring veriva-eval's zero-SDK ethos). Two transports cover the field:
 *
 *   - openai:    OpenAI-compatible /chat/completions with `tools` (also serves
 *                OpenRouter, and any OpenAI-compatible gateway).
 *   - anthropic: the Anthropic Messages API with `tools` / tool_use blocks.
 *
 * The model is resolved from whichever API key is present, precedence
 * OPENROUTER > OPENAI > ANTHROPIC, with AGENT_MODEL as an override. Tests never
 * touch this file — they use the scripted client.
 */

import type { AssistantTurn, LLMClient, Message, ToolCallRequest, ToolSpec } from "./types.js";

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};

type Transport = "openai" | "anthropic";

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

export function createProviderClient(opts: ProviderOptions = {}): ProviderClient {
  const resolved = resolveAgentModel();
  if (!resolved) {
    throw new Error("no LLM key set — provide OPENROUTER_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY (see .env.example)");
  }
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
        const { turn, prompt, completion } = resolved.transport === "anthropic"
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

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
