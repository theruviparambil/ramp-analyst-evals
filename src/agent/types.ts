/**
 * Shared agent types: the conversation protocol, the LLM client interface, and
 * the trajectory the agent emits (which is what the eval actually grades).
 */

/** A tool call the model wants to make. */
export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** One assistant step: optional text plus zero or more tool calls. No tool calls => final answer. */
export interface AssistantTurn {
  text: string;
  toolCalls: ToolCallRequest[];
}

/** Normalized conversation message, mapped per-provider inside the client. */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** Function/tool definition handed to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Anything that can take a conversation + tools and return the next assistant turn. */
export interface LLMClient {
  readonly label: string;
  chat(messages: Message[], tools: ToolSpec[]): Promise<AssistantTurn>;
}

/** One executed tool call, recorded for grading. */
export interface TrajectoryStep {
  index: number;
  name: string;
  kind: "read" | "write" | "unknown";
  rationale: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Compact, JSON-safe view of the result (or the error text). */
  resultSummary: unknown;
  isError: boolean;
}

/** The full record of one agent run over one question. */
export interface Trajectory {
  question: string;
  steps: TrajectoryStep[];
  /** Assistant text emitted along the way (planning / narration). */
  notes: string[];
  finalAnswer: string;
  /** True if the loop hit the step cap without a final answer. */
  hitStepCap: boolean;
  modelLabel: string;
}

export interface AgentResult {
  trajectory: Trajectory;
  finalAnswer: string;
}
