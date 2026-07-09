/**
 * Scripted LLM client — the offline test double (promptfoo's _ScriptedClient
 * pattern). It plays back a fixed sequence of assistant turns, so the whole
 * agent loop — tool calls, self-correction, final answer — runs with no network
 * and no API key. The tools it "calls" still hit the real fixture backend and
 * real DuckDB, so a scripted run exercises the genuine handshake and SQL path.
 */

import type { AssistantTurn, LLMClient, Message, ToolCallRequest, ToolSpec } from "./types.js";

let counter = 0;
const nextId = (): string => `call_${(counter += 1)}`;

/** Build a turn that requests one or more tool calls (ids auto-assigned). */
export function toolTurn(text: string, calls: Array<{ name: string; args: Record<string, unknown> }>): AssistantTurn {
  return { text, toolCalls: calls.map((c) => ({ id: nextId(), name: c.name, args: c.args })) };
}

/** Build a final-answer turn (no tool calls). */
export function finalTurn(text: string): AssistantTurn {
  return { text, toolCalls: [] };
}

export type TurnScript = AssistantTurn[] | ((messages: Message[], step: number) => AssistantTurn);

export class ScriptedClient implements LLMClient {
  readonly label = "scripted";
  private step = 0;
  constructor(private script: TurnScript) {}

  async chat(messages: Message[], _tools: ToolSpec[]): Promise<AssistantTurn> {
    void _tools;
    const turn = Array.isArray(this.script)
      ? this.script[this.step]
      : this.script(messages, this.step);
    this.step += 1;
    if (!turn) {
      throw new Error(`ScriptedClient exhausted at step ${this.step - 1} — the script has no turn for this step`);
    }
    return turn;
  }
}

/** Convenience: a fresh tool-call request (id auto-assigned). */
export function call(name: string, args: Record<string, unknown>): ToolCallRequest {
  return { id: nextId(), name, args };
}
