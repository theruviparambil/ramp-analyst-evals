/**
 * Provider-agnostic LLM client with tool-calling, built on `fetch`, no vendor
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
 * touch the network: they use the scripted client, or a mocked fetch.
 */

import type { AssistantTurn, LLMClient, Message, ToolCallRequest, ToolSpec } from "./types.js";

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};

const envNum = (k: string): number | undefined => {
  const v = env(k);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

/** Positive env override, else fallback. Exported so the timeout policy is unit-testable. */
export function resolveTimeoutMs(envKey: string, fallback: number): number {
  const v = envNum(envKey);
  return v !== undefined && v > 0 ? v : fallback;
}

/**
 * A transport-level failure. `transient` marks the retryable ones (5xx, 429):
 * infrastructure hiccups, not the model getting the answer wrong. Timeouts and
 * network drops are detected separately in isTransientError.
 */
export class TransportError extends Error {
  constructor(message: string, readonly status: number | undefined, readonly transient: boolean) {
    super(message);
    this.name = "TransportError";
  }
}

/** Should this failure be retried rather than surfaced as a (wrong) answer? */
export function isTransientError(err: unknown): boolean {
  if (err instanceof TransportError) return err.transient;
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true; // our own timeout abort
    if (/fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang ?up|terminated/i.test(err.message)) return true;
  }
  return false;
}

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
  // Explicit transport wins over key-presence order. Without this the branches
  // below are a PRIORITY LIST, so a machine holding both an OpenAI and an
  // Anthropic key can only ever run the OpenAI agent: the Anthropic run is
  // unreachable except by unsetting a key in the shell. For a repo whose
  // receipts are supposed to be reproducible from documented env alone, that is
  // a silently-wrong-model bug, not an inconvenience.
  const transport = env("AGENT_TRANSPORT");
  if (transport === "anthropic") {
    const key = env("ANTHROPIC_API_KEY");
    if (!key) return null;
    return { transport: "anthropic", model: override ?? "claude-sonnet-5", apiKey: key, baseUrl: env("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com", label: "anthropic" };
  }
  if (transport === "openai") {
    const key = env("OPENAI_API_KEY");
    if (!key) return null;
    return { transport: "openai", model: override ?? "gpt-5.6-terra", apiKey: key, baseUrl: env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1", label: "openai" };
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

/**
 * A model deliberately different from the agent's, to blunt (not remove)
 * self-preference when no separate judge is configured.
 *
 * These ids are PINNED and therefore go stale. They already did once: the
 * fallbacks were gpt-4.1 and claude-3-5-haiku-latest, a generation behind, so
 * an unconfigured judge would have failed every call against a model that no
 * longer exists, and the run would have reported the additional tier as
 * unevaluated rather than as broken.
 *
 * Staleness here cannot be prevented, only made visible, so resolveJudgeModel
 * warns whenever this fallback is what picked the judge. The supported path is
 * an explicit JUDGE_MODEL, and a cross-FAMILY judge via JUDGE_TRANSPORT.
 */
const JUDGE_FALLBACKS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/gpt-|\bo[134]\b|codex/i, ["gpt-5.6-luna", "gpt-5.6-terra"]],
  [/claude/i, ["claude-haiku-4-5", "claude-sonnet-5"]],
];

/**
 * Two candidates per family, because one is not enough: when the agent already
 * IS the fallback, a single-candidate table falls through and returns the
 * agent's own model, which is self-grading with extra steps rather than a
 * different judge. A test pins that case.
 */
function differentFromAgent(agentModel: string): string {
  const same = (a: string) => a.toLowerCase() === agentModel.toLowerCase();
  for (const [re, candidates] of JUDGE_FALLBACKS) {
    if (!re.test(agentModel)) continue;
    const pick = candidates.find((c) => !same(c));
    if (pick) return pick;
  }
  return agentModel;
}

/** Test seam for the pinned fallback table. Not part of the runtime path. */
export const differentFromAgentForTest = differentFromAgent;

/** True when the judge model came from the pinned fallback rather than config. */
export function judgeModelIsFallback(): boolean {
  if (env("JUDGE_MODEL") || env("JUDGE_TRANSPORT") || env("JUDGE_API_KEY")) return false;
  const agent = resolveAgentModel();
  return agent !== null && differentFromAgent(agent.model) !== agent.model;
}

/**
 * Resolve the JUDGE model. One-env-var swap for a truly independent judge:
 *   - JUDGE_TRANSPORT=bedrock runs the judge on AWS Bedrock (Converse API) with
 *     AWS_BEARER_TOKEN_BEDROCK, a real cross-FAMILY judge (e.g. Claude judging
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

/**
 * Which lab TRAINED the model, which is not the same as who hosts it.
 *
 * Self-preference is a property of the model, not the endpoint. Bedrock serves
 * both Anthropic and OpenAI models, so a Claude judge grading a GPT agent is a
 * genuine cross-family pairing even when both calls go to the same host, same
 * region and same credential. Deciding this from the transport (as this module
 * used to) would stamp `judgeSharesFamily: true` on exactly that setup and
 * publish a self-preference warning that is not true.
 *
 * Vendor prefixes are matched first because Bedrock ids carry them explicitly
 * (`us.anthropic.claude-...`, `us.openai.gpt-5.6-sol`); bare model names are a
 * fallback for direct first-party APIs.
 */
export type ModelFamily = "openai" | "anthropic" | "meta" | "mistral" | "cohere" | "amazon" | "deepseek" | "unknown";

export function modelFamily(model: string): ModelFamily {
  const m = model.toLowerCase();
  const vendor: Array<[RegExp, ModelFamily]> = [
    [/\bopenai\b/, "openai"],
    [/\banthropic\b/, "anthropic"],
    [/\bmeta\b/, "meta"],
    [/\bmistral\b/, "mistral"],
    [/\bcohere\b/, "cohere"],
    [/\bdeepseek\b/, "deepseek"],
    [/\bamazon\b|\bnova\b|\btitan\b/, "amazon"],
  ];
  for (const [re, fam] of vendor) if (re.test(m)) return fam;
  const name: Array<[RegExp, ModelFamily]> = [
    [/\bgpt-|\bo[134]\b|\bcodex\b/, "openai"],
    [/\bclaude\b/, "anthropic"],
    [/\bllama\b/, "meta"],
  ];
  for (const [re, fam] of name) if (re.test(m)) return fam;
  return "unknown";
}

/**
 * Whether the judge shares the agent's model family (self-preference risk).
 *
 * An unrecognized model on either side means independence cannot be VERIFIED,
 * so it is reported as shared. Over-warning is the safe direction: the cost is
 * a caveat on a run that did not need one, versus publishing an unearned claim
 * of judge independence.
 */
export function judgeSharesFamilyWithAgent(): boolean {
  const a = resolveAgentModel();
  const j = resolveJudgeModel();
  if (!a || !j) return false;
  const fa = modelFamily(a.model);
  const fj = modelFamily(j.model);
  if (fa === "unknown" || fj === "unknown") return true;
  return fa === fj;
}

export interface ProviderOptions {
  maxTokens?: number;
  timeoutMs?: number;
  /** Transient-error retries (in addition to the first attempt). */
  maxRetries?: number;
  /** Base backoff between retries; grows linearly per attempt. */
  backoffMs?: number;
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
  const timeoutMs = opts.timeoutMs ?? 240_000; // reasoning models are legitimately slow
  const maxRetries = opts.maxRetries ?? 2;
  const backoffMs = opts.backoffMs ?? 800;
  const usage: Usage = { promptTokens: 0, completionTokens: 0, calls: 0 };

  const dispatch = (messages: Message[], tools: ToolSpec[], signal: AbortSignal): Promise<TransportResult> =>
    resolved.transport === "bedrock"
      ? chatBedrock(resolved, messages, tools, maxTokens, signal)
      : resolved.transport === "anthropic"
        ? chatAnthropic(resolved, messages, tools, maxTokens, signal)
        : chatOpenAI(resolved, messages, tools, maxTokens, signal);

  return {
    label: `${resolved.label}:${resolved.model}`,
    usage,
    async chat(messages: Message[], tools: ToolSpec[]): Promise<AssistantTurn> {
      let lastErr: unknown;
      // A timeout or 5xx is infrastructure, not a wrong answer: retry with backoff.
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const { turn, prompt, completion } = await dispatch(messages, tools, controller.signal);
          usage.promptTokens += prompt;
          usage.completionTokens += completion;
          usage.calls += 1;
          return turn;
        } catch (err) {
          lastErr = err;
          if (attempt >= maxRetries || !isTransientError(err)) throw err;
          await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastErr; // unreachable (loop returns or throws), keeps TS happy
    },
  };
}

export function createProviderClient(opts: ProviderOptions = {}): ProviderClient {
  const resolved = resolveAgentModel();
  if (!resolved) {
    throw new Error("no LLM key set: provide OPENROUTER_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY (see .env.example)");
  }
  return buildClient(resolved, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? resolveTimeoutMs("AGENT_TIMEOUT_MS", 240_000),
    maxRetries: opts.maxRetries ?? envNum("AGENT_MAX_RETRIES"),
    backoffMs: opts.backoffMs ?? envNum("AGENT_RETRY_BACKOFF_MS"),
  });
}

/** The judge client, a separate model (and optionally a separate provider). Null if no key. */
export function createJudgeClient(opts: ProviderOptions = {}): ProviderClient | null {
  const resolved = resolveJudgeModel();
  if (!resolved) return null;
  return buildClient(resolved, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? resolveTimeoutMs("JUDGE_TIMEOUT_MS", 240_000),
    maxRetries: opts.maxRetries ?? envNum("JUDGE_MAX_RETRIES"),
    backoffMs: opts.backoffMs ?? envNum("JUDGE_RETRY_BACKOFF_MS"),
  });
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

/**
 * Map the normalized conversation onto the Responses API `input` array.
 *
 * Unlike /chat/completions, tool traffic is NOT carried on message objects: a
 * tool call is a top-level `function_call` item and its result is a top-level
 * `function_call_output`, correlated by `call_id`. An assistant turn that both
 * spoke and called tools therefore becomes several items, not one message.
 */
function toOpenAIResponsesInput(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
      case "user":
        out.push({ role: m.role, content: m.content });
        break;
      case "assistant":
        if (m.text) out.push({ role: "assistant", content: m.text });
        for (const tc of m.toolCalls) {
          out.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.args) });
        }
        break;
      case "tool":
        out.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
        break;
    }
  }
  return out;
}

/**
 * Should this request go to /v1/responses instead of /chat/completions?
 *
 * It has to, for any current reasoning model that needs tools. gpt-5.6 rejects
 * the combination outright on /chat/completions:
 *
 *   "Function tools with reasoning_effort are not supported for gpt-5.6-terra
 *    in /v1/chat/completions. To use function tools, use /v1/responses or set
 *    reasoning_effort to 'none'."
 *
 * Omitting reasoning_effort does not help, because the model's default is not
 * 'none'. The other branch of that error message is a trap for an eval: setting
 * 'none' would benchmark a reasoning model with its reasoning switched off, and
 * publishing that next to a model running normally would be a rigged
 * comparison, not a cheap workaround.
 *
 * Gateways are excluded by host, since OpenRouter and friends expose
 * /chat/completions only. OPENAI_API_STYLE forces either path.
 */
export function usesResponsesApi(model: string, baseUrl: string, hasTools: boolean): boolean {
  const forced = env("OPENAI_API_STYLE");
  if (forced === "responses") return true;
  if (forced === "chat") return false;
  if (!hasTools) return false;
  if (!/(^|\.)api\.openai\.com$/i.test(safeHost(baseUrl))) return false;
  return isReasoningModel(model);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

async function chatOpenAIResponses(r: Resolved, messages: Message[], tools: ToolSpec[], maxTokens: number, signal: AbortSignal): Promise<TransportResult> {
  const body: Record<string, unknown> = {
    model: r.model,
    input: toOpenAIResponsesInput(messages),
    // Reasoning tokens come out of this budget, so the floor mirrors the
    // /chat/completions path rather than starving the visible answer.
    max_output_tokens: Math.max(maxTokens, 4000),
  };
  // Left at the model's DEFAULT unless asked. Picking an effort here would
  // quietly set the difficulty of every published comparison; the receipt
  // records what was used either way.
  const effort = env("OPENAI_REASONING_EFFORT");
  if (effort) body.reasoning = { effort };
  if (tools.length > 0) {
    // Responses flattens the function schema: no nested `function` object.
    body.tools = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
    body.tool_choice = "auto";
  }
  const res = await fetch(`${r.baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${r.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new TransportError(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, res.status >= 500 || res.status === 429);
  const json = (await res.json()) as {
    output?: Array<{ type?: string; name?: string; arguments?: string; call_id?: string; content?: Array<{ type?: string; text?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text: string[] = [];
  const toolCalls: ToolCallRequest[] = [];
  for (const item of json.output ?? []) {
    if (item.type === "function_call" && item.name) {
      toolCalls.push({ id: item.call_id ?? "", name: item.name, args: safeJson(item.arguments ?? "{}") });
    } else if (item.type === "message") {
      for (const c of item.content ?? []) if (c.text) text.push(c.text);
    }
    // "reasoning" items carry no user-visible content and are deliberately dropped.
  }
  return {
    turn: { text: text.join("").trim(), toolCalls },
    prompt: json.usage?.input_tokens ?? 0,
    completion: json.usage?.output_tokens ?? 0,
  };
}

async function chatOpenAI(r: Resolved, messages: Message[], tools: ToolSpec[], maxTokens: number, signal: AbortSignal): Promise<TransportResult> {
  if (usesResponsesApi(r.model, r.baseUrl, tools.length > 0)) {
    return chatOpenAIResponses(r, messages, tools, maxTokens, signal);
  }
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
  if (!res.ok) throw new TransportError(`openai ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, res.status >= 500 || res.status === 429);
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

/**
 * Does this Anthropic model still accept `temperature`?
 *
 * The Claude 5 family does not: it returns
 *   400 invalid_request_error "`temperature` is deprecated for this model."
 * and rejects the whole request. Sending it unconditionally made every judge
 * call fail, which surfaced as `add.faithful 0/0 n/a` rather than as an error,
 * because a judge failure is recorded as a SKIPPED criterion. A run would have
 * completed, looked healthy, and silently contained no judged verdicts at all.
 *
 * Matched by family rather than by an allowlist of ids, so the next Claude 5
 * model does not reintroduce it.
 */
export function anthropicAcceptsTemperature(model: string): boolean {
  return !/\b(opus|sonnet|haiku|fable)-5\b/i.test(model);
}

async function chatAnthropic(r: Resolved, messages: Message[], tools: ToolSpec[], maxTokens: number, signal: AbortSignal): Promise<TransportResult> {
  const { system, messages: amsgs } = toAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model: r.model,
    max_tokens: maxTokens,
    system,
    messages: amsgs,
  };
  if (anthropicAcceptsTemperature(r.model)) body.temperature = 0;
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  const res = await fetch(`${r.baseUrl}/v1/messages`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-api-key": r.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new TransportError(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, res.status >= 500 || res.status === 429);
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
  if (!res.ok) throw new TransportError(`bedrock ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status, res.status >= 500 || res.status === 429);
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
