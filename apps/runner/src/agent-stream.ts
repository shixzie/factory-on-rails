import type { RunEvent } from "@factory/core";

/**
 * Turns the agent's stdout into structured run events.
 *
 * The default agent (Claude Code with `--output-format stream-json`) prints
 * one JSON object per line: `system` (init), `assistant` (text, thinking and
 * tool calls), `user` (tool results) and a final `result`. Those become
 * `message`, `thinking`, `tool_call`, `tool_result` and `agent_result`
 * events. Any other line is passed through as plain output, so an agent CLI
 * that prints text still gets a log.
 */

/** Longest tool output or tool input string stored per event. */
export const MAX_TOOL_TEXT = 16 * 1024;

/** The tool (from the factory's MCP server in the sandbox) the agent calls to ask the user something. */
export const ASK_USER_TOOL = "mcp__factory__ask_user";

const STREAM_TYPES = new Set(["system", "assistant", "user", "result", "stream_event"]);

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export function truncateText(text: string, max = MAX_TOOL_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters not shown]` : text;
}

/** Caps every string inside a tool's input so one large Write can't dominate the log. */
export function truncateStrings(value: unknown, max = MAX_TOOL_TEXT): unknown {
  if (typeof value === "string") return truncateText(value, max);
  if (Array.isArray(value)) return value.map((v) => truncateStrings(v, max));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateStrings(v, max)]));
  return value;
}

/** A tool result's content is a string or a list of blocks; keep the text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isObject(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Parses one line of agent stdout. Returns the events it stands for (possibly
 * none, for stream messages we don't show), or `undefined` when the line is
 * not agent JSON and should be kept as plain output.
 */
export function parseAgentLine(line: string): RunEvent[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isObject(msg) || typeof msg.type !== "string" || !STREAM_TYPES.has(msg.type)) return undefined;

  const parentToolUseId = typeof msg.parent_tool_use_id === "string" ? msg.parent_tool_use_id : null;
  const nested = parentToolUseId ? { parentToolUseId } : {};

  switch (msg.type) {
    case "system": {
      if (msg.subtype !== "init") return [];
      const events: RunEvent[] = [
        { kind: "info", message: typeof msg.model === "string" ? `Agent started (${msg.model})` : "Agent started" },
      ];
      const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers.filter(isObject) : [];
      const factory = servers.find((s) => s.name === "factory");
      if (factory && factory.status !== "connected") {
        events.push({ kind: "error", message: `The ask-the-user tool did not start (${String(factory.status)}), so the agent cannot ask questions` });
      }
      return events;
    }
    case "assistant": {
      const content = isObject(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
      const events: RunEvent[] = [];
      for (const block of content) {
        if (!isObject(block)) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          events.push({ kind: "message", message: block.text, data: parentToolUseId ? nested : null });
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          events.push({ kind: "thinking", message: block.thinking, data: parentToolUseId ? nested : null });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          events.push({
            kind: "tool_call",
            message: block.name,
            data: { id: String(block.id ?? ""), name: block.name, input: truncateStrings(block.input ?? {}), ...nested },
          });
        }
      }
      return events;
    }
    case "user": {
      const content = isObject(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
      const events: RunEvent[] = [];
      for (const block of content) {
        if (!isObject(block) || block.type !== "tool_result") continue;
        events.push({
          kind: "tool_result",
          message: truncateText(toolResultText(block.content)),
          data: { toolUseId: String(block.tool_use_id ?? ""), isError: block.is_error === true, ...nested },
        });
      }
      return events;
    }
    case "result": {
      const data: Json = { isError: msg.is_error === true, subtype: msg.subtype ?? null };
      if (typeof msg.num_turns === "number") data.turns = msg.num_turns;
      if (typeof msg.duration_ms === "number") data.durationMs = msg.duration_ms;
      if (typeof msg.total_cost_usd === "number") data.costUsd = msg.total_cost_usd;
      return [{ kind: "agent_result", message: typeof msg.result === "string" ? msg.result : "", data }];
    }
    default:
      return [];
  }
}

export interface AgentStreamSink {
  /** A structured event parsed from the stream. */
  readonly event: (event: RunEvent) => void;
  /** Output that isn't agent JSON, passed through as-is. */
  readonly output: (stream: "stdout" | "stderr", text: string) => void;
}

/**
 * Splits streamed stdout into lines (chunks can end mid-line) and parses each.
 * stderr is passed straight through. Call `end` when the command exits to
 * flush a last line without a newline.
 */
export function makeAgentStream(sink: AgentStreamSink) {
  let buffer = "";
  const line = (text: string) => {
    const events = parseAgentLine(text);
    if (events) events.forEach(sink.event);
    else sink.output("stdout", `${text}\n`);
  };
  return {
    write: (stream: "stdout" | "stderr", chunk: string) => {
      if (stream === "stderr") return sink.output("stderr", chunk);
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    },
    end: () => {
      if (buffer) line(buffer);
      buffer = "";
    },
  };
}
