/**
 * Turns a run's events into the blocks the run page shows, the way t3code
 * lays out a turn: the agent's prose as messages, runs of tool calls and
 * command output grouped into work logs, questions the agent asked, messages
 * the user sent, and the agent's closing result.
 */
import type { ApiRunEvent } from "@factory/core/api";

/** The tool the agent calls to ask the user something (the factory's MCP server in the sandbox). */
export const ASK_USER_TOOL = "mcp__factory__ask_user";

/** Claude Code's tool for starting a subagent ("Task" in older versions, "Agent" in newer ones). */
export const isSubagentTool = (name: string) => name === "Task" || name === "Agent";

/** What a subagent reported about itself when it finished, when the agent CLI says. */
export interface SubagentStats {
  durationMs?: number;
  tokens?: number;
  toolUses?: number;
}

export interface ToolCall {
  type: "tool";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set once the tool has returned. */
  result?: { text: string; isError: boolean };
  /** The subagent (Task) call this one ran under, if any. */
  parentId?: string;
  /** For a subagent call: everything the subagent did, in order. */
  children?: WorkItem[];
  stats?: SubagentStats;
  /** When the call was made and when its result came back. */
  at: Date;
  doneAt?: Date;
}

export type WorkItem =
  | { type: "step"; id: string; kind: "info" | "error"; text: string }
  | { type: "output"; id: string; chunks: { kind: "stdout" | "stderr"; text: string }[] }
  | { type: "thinking"; id: string; text: string; parentId?: string }
  | { type: "note"; id: string; text: string; parentId?: string }
  | ToolCall;

export type Block =
  | { type: "work"; id: string; items: WorkItem[] }
  | { type: "message"; id: string; text: string }
  | { type: "user"; id: string; text: string; at: Date }
  | { type: "question"; id: string; call: ToolCall }
  | { type: "result"; id: string; text: string; isError: boolean; turns?: number; durationMs?: number; costUsd?: number };

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

export function toBlocks(events: ReadonlyArray<ApiRunEvent>): Block[] {
  const blocks: Block[] = [];
  const calls = new Map<string, ToolCall>();
  // A subagent's own steps go inside the call that started it, not the main log.
  const home = (id: string, parentId: string | undefined): WorkItem[] => {
    const parent = parentId ? calls.get(parentId) : undefined;
    if (parent) return (parent.children ??= []);
    return work(id);
  };
  const work = (id: string) => {
    const last = blocks.at(-1);
    if (last?.type === "work") return last.items;
    const block: Block = { type: "work", id, items: [] };
    blocks.push(block);
    return block.items;
  };

  for (const e of events) {
    const data = e.data ?? {};
    const parentId = str(data.parentToolUseId);
    switch (e.kind) {
      case "info":
      case "error":
        work(e.id).push({ type: "step", id: e.id, kind: e.kind, text: e.message });
        break;
      case "stdout":
      case "stderr": {
        const items = work(e.id);
        const last = items.at(-1);
        if (last?.type === "output") last.chunks.push({ kind: e.kind, text: e.message });
        else items.push({ type: "output", id: e.id, chunks: [{ kind: e.kind, text: e.message }] });
        break;
      }
      case "thinking":
        home(e.id, parentId).push({ type: "thinking", id: e.id, text: e.message, parentId });
        break;
      case "message":
        // A subagent's prose stays with its work; the main agent's is the conversation.
        if (parentId) home(e.id, parentId).push({ type: "note", id: e.id, text: e.message, parentId });
        else blocks.push({ type: "message", id: e.id, text: e.message });
        break;
      case "tool_call": {
        const input = typeof data.input === "object" && data.input !== null ? (data.input as Record<string, unknown>) : {};
        const name = str(data.name) ?? e.message;
        const call: ToolCall = { type: "tool", id: str(data.id) || e.id, name, input, parentId, at: e.at };
        if (isSubagentTool(name)) call.children = [];
        calls.set(call.id, call);
        if (call.name === ASK_USER_TOOL && !parentId) blocks.push({ type: "question", id: e.id, call });
        else home(e.id, parentId).push(call);
        break;
      }
      case "tool_result": {
        const call = calls.get(str(data.toolUseId) ?? "");
        if (call) {
          call.result = { text: e.message, isError: data.isError === true };
          call.doneAt = e.at;
          const stats = typeof data.stats === "object" && data.stats !== null ? (data.stats as Record<string, unknown>) : undefined;
          if (stats) call.stats = { durationMs: num(stats.durationMs), tokens: num(stats.tokens), toolUses: num(stats.toolUses) };
        }
        break;
      }
      case "user_message":
        blocks.push({ type: "user", id: e.id, text: e.message, at: e.at });
        break;
      case "agent_result":
        blocks.push({
          type: "result",
          id: e.id,
          text: e.message,
          isError: data.isError === true,
          turns: num(data.turns),
          durationMs: num(data.durationMs),
          costUsd: num(data.costUsd),
        });
        break;
    }
  }
  return blocks;
}

/** The question the agent is waiting on, if any. */
export function openQuestion(blocks: ReadonlyArray<Block>): ToolCall | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.type === "question" && !b.call.result) return b.call;
  }
  return undefined;
}

/** Paths inside the sandbox's checkout, shown relative to the repository. */
export function repoPath(path: string): string {
  return path.replace(/^\/workspace\/repo\//, "");
}

/** What ask_user returned, without the wrapper sentence the tool adds. */
export function answerText(result: string): string {
  return result.replace(/^The user answered:\s*/, "");
}
