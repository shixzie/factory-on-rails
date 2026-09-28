import type { RunEvent } from "@factory/core";
import { truncateStrings, truncateText } from "./agent-stream.js";

/**
 * Turns Codex's `codex exec --json` output into the same run events Claude
 * Code's stream-json becomes (see agent-stream.ts), so the run page, its
 * subagent cards and the flow map work the same for both agents.
 *
 * Codex prints one JSON event per line: `thread.started`, `turn.started`,
 * `item.started` / `item.updated` / `item.completed` around each thread item,
 * then `turn.completed` or `turn.failed`, plus top-level `error`s. Each item
 * maps onto the Claude Code tool it stands for:
 *
 * | Codex item          | run event                                          |
 * |---------------------|----------------------------------------------------|
 * | agent_message       | message                                            |
 * | reasoning           | thinking                                           |
 * | command_execution   | tool_call `Bash` { command } and its tool_result    |
 * | file_change         | tool_call `FileChange` { changes: [{ path, kind }] } |
 * | mcp_tool_call       | tool_call `mcp__<server>__<tool>` (ask_user included) |
 * | web_search          | tool_call `WebSearch` { query }                     |
 * | todo_list           | tool_call `TodoWrite` { todos } on every change     |
 * | collab spawn_agent  | tool_call `Agent` { description, prompt }           |
 * | error               | error (Codex's own warnings are dropped)           |
 *
 * The schema is `ThreadEvent` in codex-rs/exec/src/exec_events.rs.
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : "");

const EVENT_TYPES = new Set(["thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed", "error"]);

/** Codex's notices about flags the factory passes on purpose, and transport retries it recovers from. */
const NOISE = [/--dangerously-bypass-hook-trust/, /^Reconnecting\.\.\./, /^Falling back from WebSockets/];

/** Codex runs commands as `bash -lc '<command>'`; show the command itself. */
export function unwrapShell(command: string): string {
  const m = /^(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(command.trim());
  if (!m) return command;
  return m[1] === "'" ? m[2]!.replace(/'\\''/g, "'") : m[2]!.replace(/\\(["\\$`])/g, "$1");
}

/** The text blocks of an MCP tool result. */
function mcpResultText(result: unknown): string {
  if (!isObject(result) || !Array.isArray(result.content)) return "";
  return result.content
    .map((block) => (isObject(block) && block.type === "text" ? str(block.text) : isObject(block) && block.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

const CHANGE_VERBS: Record<string, string> = { add: "Added", delete: "Deleted", update: "Updated" };

/**
 * A parser for one run of `codex exec --json`. It keeps a little state (which
 * items already have a tool call on the page, the plan so far, the last
 * message for the closing result), so make a new one per agent run.
 */
export function makeCodexParser(now: () => number = Date.now) {
  const called = new Set<string>();
  const plans = new Map<string, string>();
  let planUpdates = 0;
  let lastMessage = "";
  let turnStartedAt: number | undefined;

  const call = (id: string, name: string, input: Json): RunEvent => {
    called.add(id);
    return { kind: "tool_call", message: name, data: { id, name, input: truncateStrings(input) } };
  };
  const result = (id: string, text: string, isError: boolean): RunEvent => ({
    kind: "tool_result",
    message: truncateText(text),
    data: { toolUseId: id, isError },
  });

  const item = (phase: "started" | "updated" | "completed", it: Json): RunEvent[] => {
    const id = str(it.id);
    const done = phase === "completed";
    const failed = it.status === "failed" || it.status === "declined";
    switch (it.type) {
      case "agent_message": {
        if (!done || !str(it.text).trim()) return [];
        lastMessage = str(it.text);
        return [{ kind: "message", message: lastMessage, data: null }];
      }
      case "reasoning":
        return done && str(it.text).trim() ? [{ kind: "thinking", message: str(it.text), data: null }] : [];
      case "command_execution": {
        const events = called.has(id) ? [] : [call(id, "Bash", { command: unwrapShell(str(it.command)) })];
        if (!done) return events;
        const exitCode = typeof it.exit_code === "number" ? it.exit_code : null;
        const output = str(it.aggregated_output);
        const text = exitCode !== null && exitCode !== 0 ? `${output}${output && !output.endsWith("\n") ? "\n" : ""}Exit code ${exitCode}` : output;
        return [...events, result(id, text, failed || (exitCode !== null && exitCode !== 0))];
      }
      case "file_change": {
        if (!done) return [];
        const changes = (Array.isArray(it.changes) ? it.changes : []).filter(isObject).map((c) => ({ path: str(c.path), kind: str(c.kind) }));
        const summary = changes.map((c) => `${CHANGE_VERBS[c.kind] ?? "Changed"} ${c.path}`).join("\n");
        return [call(id, "FileChange", { changes }), result(id, failed ? `Could not apply the change.\n${summary}` : summary, failed)];
      }
      case "mcp_tool_call": {
        const events = called.has(id) ? [] : [call(id, `mcp__${str(it.server)}__${str(it.tool)}`, isObject(it.arguments) ? it.arguments : {})];
        if (!done) return events;
        const error = isObject(it.error) ? str(it.error.message) : "";
        return [...events, result(id, error || mcpResultText(it.result), failed || !!error)];
      }
      case "web_search": {
        // The query can be filled in only once the search has run.
        if (!done) return [];
        const results = Array.isArray(it.results) ? it.results.length : undefined;
        return [
          call(id, "WebSearch", { query: str(it.query) }),
          result(id, results === undefined ? "" : `${results} result${results === 1 ? "" : "s"}`, false),
        ];
      }
      case "todo_list": {
        const items = (Array.isArray(it.items) ? it.items : []).filter(isObject);
        const firstOpen = items.findIndex((t) => t.completed !== true);
        const todos = items.map((t, i) => ({
          content: str(t.text),
          status: t.completed === true ? "completed" : i === firstOpen ? "in_progress" : "pending",
        }));
        const key = JSON.stringify(todos);
        if (todos.length === 0 || plans.get(id) === key) return [];
        plans.set(id, key);
        const planId = `${id}#${++planUpdates}`;
        return [call(planId, "TodoWrite", { todos }), result(planId, "", false)];
      }
      case "collab_tool_call": {
        if (it.tool !== "spawn_agent") return [];
        const prompt = str(it.prompt);
        const events = called.has(id) ? [] : [call(id, "Agent", { description: prompt.split("\n")[0]!.slice(0, 80), prompt })];
        if (!done) return events;
        const states = isObject(it.agents_states) ? Object.values(it.agents_states).filter(isObject) : [];
        const text = states.map((s) => str(s.message)).filter(Boolean).join("\n\n");
        return [...events, result(id, text, failed || states.some((s) => s.status === "errored"))];
      }
      case "error": {
        const message = str(it.message);
        return !done || NOISE.some((re) => re.test(message)) ? [] : [{ kind: "error", message }];
      }
      default:
        return [];
    }
  };

  /**
   * Parses one line of `codex exec --json` output: the events it stands for
   * (possibly none), or `undefined` when it is not Codex JSON and should be
   * kept as plain output.
   */
  return (line: string): RunEvent[] | undefined => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return undefined;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (!isObject(msg) || typeof msg.type !== "string" || !EVENT_TYPES.has(msg.type)) return undefined;
    switch (msg.type) {
      case "thread.started":
        return [{ kind: "info", message: "Agent started (Codex)" }];
      case "turn.started":
        turnStartedAt = now();
        lastMessage = "";
        return [];
      case "turn.completed":
      case "turn.failed": {
        const failed = msg.type === "turn.failed";
        const data: Json = { isError: failed, subtype: failed ? "error" : "success" };
        if (turnStartedAt !== undefined) data.durationMs = now() - turnStartedAt;
        if (isObject(msg.usage)) data.usage = msg.usage;
        const error = isObject(msg.error) ? str(msg.error.message) : str(msg.error);
        return [{ kind: "agent_result", message: failed ? error || "Codex stopped with an error" : lastMessage, data }];
      }
      case "error": {
        const message = str(msg.message);
        return NOISE.some((re) => re.test(message)) ? [] : [{ kind: "error", message }];
      }
      default:
        return isObject(msg.item) ? item(msg.type.slice("item.".length) as "started" | "updated" | "completed", msg.item) : [];
    }
  };
}
