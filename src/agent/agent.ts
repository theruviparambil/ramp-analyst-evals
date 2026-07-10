/**
 * The agent loop.
 *
 * Given a finance question, it plans and calls Ramp tools until it can answer,
 * then stops. It self-corrects on the two failure modes the real analyst surface
 * produces (a docs_required handshake response and a genuine DuckDB SQL error)
 * by feeding the tool result back to the model and letting it retry. It only
 * ever holds READ tools, and it records every call (name, rationale, args,
 * result) into a Trajectory, which is what the eval grades. Provider-agnostic:
 * the LLMClient is injected, so tests pass a scripted client and the live demo
 * passes the real provider.
 */

import { agentToolDefs, getToolDef } from "../ramp/tools.js";
import type { RampToolSurface } from "../ramp/tools.js";
import type { AgentResult, LLMClient, Message, Trajectory, TrajectoryStep } from "./types.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";

export interface RunAgentOptions {
  client: LLMClient;
  surface: RampToolSurface;
  /** Max total tool executions before the loop gives up. Default 18. */
  maxToolCalls?: number;
  system?: string;
}

export async function runAgent(question: string, opts: RunAgentOptions): Promise<AgentResult> {
  const { client, surface } = opts;
  const maxToolCalls = opts.maxToolCalls ?? 18;
  const tools = agentToolDefs();

  const messages: Message[] = [
    { role: "system", content: opts.system ?? SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  const trajectory: Trajectory = {
    question,
    steps: [],
    notes: [],
    finalAnswer: "",
    hitStepCap: false,
    modelLabel: client.label,
  };

  let toolCallCount = 0;
  // Rounds are bounded generously; the real cap is on tool executions.
  const maxRounds = maxToolCalls + 4;

  for (let round = 0; round < maxRounds; round++) {
    const turn = await client.chat(messages, tools);
    if (turn.text) trajectory.notes.push(turn.text);
    messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });

    if (turn.toolCalls.length === 0) {
      trajectory.finalAnswer = turn.text.trim();
      return { trajectory, finalAnswer: trajectory.finalAnswer };
    }

    for (const tc of turn.toolCalls) {
      if (toolCallCount >= maxToolCalls) {
        trajectory.hitStepCap = true;
        messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: JSON.stringify({ error: "tool-call budget exhausted; summarize your findings and answer now" }) });
        continue;
      }
      toolCallCount += 1;
      const def = getToolDef(tc.name);
      const rationale = typeof tc.args?.rationale === "string" ? tc.args.rationale : "";
      const result = await surface.call(tc.name, tc.args);
      const step: TrajectoryStep = {
        index: trajectory.steps.length,
        name: tc.name,
        kind: def?.kind ?? "unknown",
        rationale,
        args: tc.args,
        ok: result.ok,
        resultSummary: summarize(result.ok ? result.data : { error: result.error }),
        isError: !result.ok,
      };
      trajectory.steps.push(step);
      const content = JSON.stringify(result.ok ? result.data : { error: result.error });
      messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content });
    }

    if (trajectory.hitStepCap) {
      // Give the model one final chance to answer with what it has.
      const turnFinal = await client.chat(messages, tools);
      trajectory.finalAnswer = turnFinal.text.trim();
      if (turnFinal.text) trajectory.notes.push(turnFinal.text);
      return { trajectory, finalAnswer: trajectory.finalAnswer };
    }
  }

  trajectory.hitStepCap = true;
  trajectory.finalAnswer = trajectory.notes[trajectory.notes.length - 1]?.trim() ?? "";
  return { trajectory, finalAnswer: trajectory.finalAnswer };
}

/** Compact, JSON-safe view of a tool result for the trajectory record. */
function summarize(data: unknown): unknown {
  if (data === null || typeof data !== "object") return data;
  const obj = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length > 20) {
      out[k] = [...v.slice(0, 20), `…(+${v.length - 20} more)`];
    } else if (typeof v === "string" && v.length > 1200) {
      out[k] = `${v.slice(0, 1200)}…`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
