import type { RunEvent } from "@factory/core";
import { OPENCODE_TOOL_START } from "./agent-tools.js";
import { truncateStrings, truncateText, withMedia, type AgentEvent } from "./agent-stream.js";

/**
 * Turns OpenCode's `opencode run --format json` output into the same run
 * events Claude Code's stream-json becomes (see agent-stream.ts), so the run
 * page, its tool cards and the flow map work the same for every agent.
 *
 * OpenCode prints one JSON event per line, each with the `sessionID` it
 * belongs to and a message `part`: `step_start` and `step_finish` around each
 * model step (the finish carries tokens and cost, and a `reason` other than
 * `tool-calls` when the agent is done), `text`, `reasoning` (with
 * `--thinking`), `tool_use` once a tool has finished or failed, and `error`.
 * OpenCode reports a tool only when it is done, so the factory's plugin (see
 * agent-tools.ts) also prints a `factory_tool_start` line as each one starts;
 * that is how the run page sees a question while it waits for an answer.
 * Lines from subagents' own sessions are skipped, as OpenCode itself does.
 *
 * Each OpenCode tool maps onto the Claude Code tool it stands for:
 *
 * | OpenCode tool        | run event tool_call                              |
 * |----------------------|--------------------------------------------------|
 * | bash                 | `Bash` { command, description }                  |
 * | read / write / edit  | `Read` / `Write` / `Edit` { file_path, ... }     |
 * | multiedit            | `MultiEdit` { file_path, edits }                 |
 * | apply_patch / patch  | `FileChange` { changes: [{ path, kind }] }       |
 * | grep / glob / list   | `Grep` / `Glob` / `LS`                           |
 * | webfetch / websearch | `WebFetch` { url } / `WebSearch` { query }       |
 * | todowrite            | `TodoWrite` { todos }                            |
 * | task                 | `Agent` { description, prompt, subagent_type }   |
 * | <server>_<tool>      | `mcp__<server>__<tool>` (ask_user included)      |
 *
 * The schema is `MessageV2.Part` in packages/opencode/src/session/message-v2.ts
 * and the emitter is packages/opencode/src/cli/cmd/run.ts.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const EVENT_TYPES = new Set(["step_start", "step_finish", "text", "reasoning", "tool_use", "error", OPENCODE_TOOL_START]);

const PATCH_KINDS: Record<string, string> = { Add: "add", Update: "update", Delete: "delete" };

/** The files an apply_patch envelope touches (`*** Update File: <path>` and friends). */
export function patchChanges(patch: string): Array<{ path: string; kind: string }> {
  const changes: Array<{ path: string; kind: string }> = [];
  for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) changes.push({ path: m[2]!.trim(), kind: PATCH_KINDS[m[1]!]! });
  return changes;
}

const TODO_STATUS: Record<string, string> = { pending: "pending", in_progress: "in_progress", completed: "completed", cancelled: "completed" };

/** An OpenCode tool call as the Claude Code tool the run page knows. */
export function toolCall(tool: string, input: Json, mcpServers: ReadonlyArray<string> = []): { name: string; input: Json } {
  switch (tool) {
    case "bash":
      return { name: "Bash", input: { command: str(input.command), ...(input.description ? { description: str(input.description) } : {}) } };
    case "read":
      return { name: "Read", input: { file_path: str(input.filePath), ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) } };
    case "write":
      return { name: "Write", input: { file_path: str(input.filePath), content: str(input.content) } };
    case "edit":
      return { name: "Edit", input: { file_path: str(input.filePath), old_string: str(input.oldString), new_string: str(input.newString), ...(input.replaceAll ? { replace_all: true } : {}) } };
    case "multiedit":
      return {
        name: "MultiEdit",
        input: {
          file_path: str(input.filePath),
          edits: (Array.isArray(input.edits) ? input.edits : []).filter(isObject).map((e) => ({ old_string: str(e.oldString), new_string: str(e.newString) })),
        },
      };
    case "apply_patch":
    case "patch":
      return { name: "FileChange", input: { changes: patchChanges(str(input.patchText ?? input.patch)) } };
    case "grep":
      return { name: "Grep", input: { pattern: str(input.pattern), ...(input.path ? { path: str(input.path) } : {}), ...(input.include ? { glob: str(input.include) } : {}) } };
    case "glob":
      return { name: "Glob", input: { pattern: str(input.pattern), ...(input.path ? { path: str(input.path) } : {}) } };
    case "list":
      return { name: "LS", input: { path: str(input.path) } };
    case "webfetch":
      return { name: "WebFetch", input: { url: str(input.url) } };
    case "websearch":
    case "codesearch":
      return { name: "WebSearch", input: { query: str(input.query) } };
    case "todowrite":
      return {
        name: "TodoWrite",
        input: {
          todos: (Array.isArray(input.todos) ? input.todos : []).filter(isObject).map((t) => ({ content: str(t.content), status: TODO_STATUS[str(t.status)] ?? "pending" })),
        },
      };
    case "task":
      return { name: "Agent", input: { description: str(input.description), prompt: str(input.prompt), ...(input.subagent_type ? { subagent_type: str(input.subagent_type) } : {}) } };
    default: {
      // MCP tools are `<server>_<tool>`; the longest matching server name wins.
      const server = [...mcpServers].sort((a, b) => b.length - a.length).find((s) => tool.startsWith(`${s}_`));
      return server ? { name: `mcp__${server}__${tool.slice(server.length + 1)}`, input } : { name: tool, input };
    }
  }
}

/** Images and PDFs a tool result carried (an image the agent read), as MCP-shaped blocks for withMedia. */
function attachmentBlocks(attachments: unknown): Json[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter(isObject).flatMap((a) => {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(str(a.url));
    if (!m) return [];
    return [{ type: m[1]!.startsWith("image/") ? "image" : "document", mimeType: m[1], data: m[2] }];
  });
}

export interface OpenCodeParserOptions {
  /** The MCP servers the agent has, so their tools get Claude Code's `mcp__` names. */
  readonly mcpServers?: ReadonlyArray<string>;
  readonly now?: () => number;
}

/**
 * A parser for one agent command's `opencode run --format json` output. It
 * keeps a little state (the session, which tools already have a call on the
 * page, the last message and usage for the closing result), so make a new
 * one per agent run.
 */
export function makeOpenCodeParser(options: OpenCodeParserOptions = {}) {
  const mcpServers = ["factory", ...(options.mcpServers ?? [])];
  const now = options.now ?? Date.now;
  const called = new Set<string>();
  let session: string | undefined;
  let started = false;
  let lastMessage = "";
  let turnStartedAt: number | undefined;
  let usage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let cost = 0;

  const call = (id: string, tool: string, input: Json): RunEvent => {
    called.add(id);
    const mapped = toolCall(tool, input, mcpServers);
    return { kind: "tool_call", message: mapped.name, data: { id, name: mapped.name, input: truncateStrings(mapped.input) } };
  };

  const toolUse = (part: Json): AgentEvent[] => {
    const id = str(part.callID);
    const state = isObject(part.state) ? part.state : {};
    const input = isObject(state.input) ? state.input : {};
    const events: AgentEvent[] = called.has(id) ? [] : [call(id, str(part.tool), input)];
    const metadata = isObject(state.metadata) ? state.metadata : {};
    if (state.status === "error") {
      return [...events, { kind: "tool_result", message: truncateText(str(state.error)), data: { toolUseId: id, isError: true } }];
    }
    const exit = typeof metadata.exit === "number" ? metadata.exit : null;
    let text = str(state.output);
    if (exit !== null && exit !== 0) text = `${text}${text && !text.endsWith("\n") ? "\n" : ""}Exit code ${exit}`;
    const result: RunEvent = { kind: "tool_result", message: truncateText(text), data: { toolUseId: id, isError: exit !== null && exit !== 0 } };
    return [...events, withMedia(result, attachmentBlocks(state.attachments))];
  };

  /**
   * Parses one line of `opencode run --format json` output: the events it
   * stands for (possibly none), or `undefined` when it is not OpenCode JSON
   * and should be kept as plain output.
   */
  const parse = (line: string): AgentEvent[] | undefined => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return undefined;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (!isObject(msg) || typeof msg.type !== "string" || !EVENT_TYPES.has(msg.type)) return undefined;
    // OpenCode only prints its own session's events; the plugin sees subagents' too,
    // which can only start after the agent's own first tool call.
    session ??= str(msg.sessionID) || undefined;
    if (str(msg.sessionID) !== session) return [];
    // The plugin's line for a step's first tool can land before OpenCode's own step_start.
    const events: AgentEvent[] = started ? [] : [{ kind: "info", message: "Agent started (OpenCode)" }];
    started = true;
    return [...events, ...event(msg)];
  };

  const event = (msg: Json): AgentEvent[] => {
    const part = isObject(msg.part) ? msg.part : {};
    switch (msg.type) {
      case OPENCODE_TOOL_START: {
        turnStartedAt ??= now();
        const id = str(msg.callID);
        return !id || called.has(id) ? [] : [call(id, str(msg.tool), isObject(msg.args) ? msg.args : {})];
      }
      case "step_start":
        turnStartedAt ??= now();
        return [];
      case "text": {
        const text = str(part.text);
        if (!text.trim()) return [];
        lastMessage = text;
        return [{ kind: "message", message: text, data: null }];
      }
      case "reasoning":
        return str(part.text).trim() ? [{ kind: "thinking", message: str(part.text), data: null }] : [];
      case "tool_use":
        return toolUse(part);
      case "step_finish": {
        const tokens = isObject(part.tokens) ? part.tokens : {};
        const cache = isObject(tokens.cache) ? tokens.cache : {};
        usage = {
          input_tokens: usage.input_tokens + num(tokens.input),
          output_tokens: usage.output_tokens + num(tokens.output),
          reasoning_tokens: usage.reasoning_tokens + num(tokens.reasoning),
          cache_read_input_tokens: usage.cache_read_input_tokens + num(cache.read),
          cache_creation_input_tokens: usage.cache_creation_input_tokens + num(cache.write),
        };
        cost += num(part.cost);
        if (part.reason === "tool-calls") return [];
        const data: Json = { isError: false, subtype: "success", usage, costUsd: cost };
        if (turnStartedAt !== undefined) data.durationMs = now() - turnStartedAt;
        const result: AgentEvent = { kind: "agent_result", message: lastMessage, data };
        // The next prompt (a message from the user) starts a new turn.
        turnStartedAt = undefined;
        lastMessage = "";
        usage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        cost = 0;
        return [result];
      }
      case "error": {
        const error = isObject(msg.error) ? msg.error : {};
        const data = isObject(error.data) ? error.data : {};
        return [{ kind: "error", message: str(data.message) || str(error.name) || "OpenCode stopped with an error" }];
      }
      default:
        return [];
    }
  };

  return parse;
}
