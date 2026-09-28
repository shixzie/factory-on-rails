import { describe, expect, it } from "vitest";
import { ASK_USER_TOOL } from "../src/agent-stream.js";
import { makeCodexParser, unwrapShell } from "../src/codex-stream.js";

/** Feeds `codex exec --json` events (objects or raw lines) through one parser. */
const parse = (...lines: (object | string)[]) => {
  let t = 0;
  const parser = makeCodexParser(() => (t += 1000));
  return lines.map((l) => parser(typeof l === "string" ? l : JSON.stringify(l)));
};
const flat = (...lines: (object | string)[]) => parse(...lines).flatMap((e) => e ?? []);

describe("Codex's JSON events", () => {
  it("keeps lines that aren't Codex JSON as plain output", () => {
    expect(parse("Reading additional input from stdin...", "{not json", '{"type":"system"}')).toEqual([undefined, undefined, undefined]);
  });

  it("turns messages, reasoning and the closing turn into run events", () => {
    expect(
      flat(
        { type: "thread.started", thread_id: "th_1" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Planning**" } },
        { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Done: added a README." } },
        { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
      ),
    ).toEqual([
      { kind: "info", message: "Agent started (Codex)" },
      { kind: "thinking", message: "**Planning**", data: null },
      { kind: "message", message: "Done: added a README.", data: null },
      {
        kind: "agent_result",
        message: "Done: added a README.",
        data: {
          isError: false,
          subtype: "success",
          durationMs: 1000,
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
        },
      },
    ]);
  });

  it("shows a command as a Bash call when it starts, and its output when it ends", () => {
    const [started, completed] = parse(
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "/bin/bash -lc 'ls -la'", aggregated_output: "", exit_code: null, status: "in_progress" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "/bin/bash -lc 'ls -la'", aggregated_output: "README.md\n", exit_code: 0, status: "completed" } },
    );
    expect(started).toEqual([{ kind: "tool_call", message: "Bash", data: { id: "c1", name: "Bash", input: { command: "ls -la" } } }]);
    expect(completed).toEqual([{ kind: "tool_result", message: "README.md\n", data: { toolUseId: "c1", isError: false } }]);
  });

  it("marks a failed command as an error and says its exit code", () => {
    const events = flat({
      type: "item.completed",
      item: { id: "c2", type: "command_execution", command: "bash -lc \"pnpm test\"", aggregated_output: "1 failed", exit_code: 1, status: "failed" },
    });
    expect(events[0]).toMatchObject({ kind: "tool_call", data: { input: { command: "pnpm test" } } });
    expect(events[1]).toEqual({ kind: "tool_result", message: "1 failed\nExit code 1", data: { toolUseId: "c2", isError: true } });
  });

  it("lists the files a patch changed", () => {
    expect(
      flat({
        type: "item.completed",
        item: { id: "p1", type: "file_change", changes: [{ path: "/workspace/repo/README.md", kind: "add" }, { path: "/workspace/repo/a.ts", kind: "update" }], status: "completed" },
      }),
    ).toEqual([
      {
        kind: "tool_call",
        message: "FileChange",
        data: { id: "p1", name: "FileChange", input: { changes: [{ path: "/workspace/repo/README.md", kind: "add" }, { path: "/workspace/repo/a.ts", kind: "update" }] } },
      },
      { kind: "tool_result", message: "Added /workspace/repo/README.md\nUpdated /workspace/repo/a.ts", data: { toolUseId: "p1", isError: false } },
    ]);
  });

  it("names MCP calls the way Claude Code does, so ask_user shows as a question", () => {
    const [started, completed] = parse(
      { type: "item.started", item: { id: "m1", type: "mcp_tool_call", server: "factory", tool: "ask_user", arguments: { question: "Which?" }, result: null, error: null, status: "in_progress" } },
      {
        type: "item.completed",
        item: { id: "m1", type: "mcp_tool_call", server: "factory", tool: "ask_user", arguments: { question: "Which?" }, result: { content: [{ type: "text", text: "The user answered: A" }], structured_content: null }, error: null, status: "completed" },
      },
    );
    expect(started).toEqual([{ kind: "tool_call", message: ASK_USER_TOOL, data: { id: "m1", name: ASK_USER_TOOL, input: { question: "Which?" } } }]);
    expect(completed).toEqual([{ kind: "tool_result", message: "The user answered: A", data: { toolUseId: "m1", isError: false } }]);
  });

  it("shows the plan as TodoWrite, once per change", () => {
    const todo = (phase: string, done: boolean) => ({
      type: `item.${phase}`,
      item: { id: "t1", type: "todo_list", items: [{ text: "Write it", completed: done }, { text: "Test it", completed: false }] },
    });
    const events = flat(todo("started", false), todo("updated", false), todo("updated", true));
    expect(events.filter((e) => e.kind === "tool_call").map((e) => e.data?.input)).toEqual([
      { todos: [{ content: "Write it", status: "in_progress" }, { content: "Test it", status: "pending" }] },
      { todos: [{ content: "Write it", status: "completed" }, { content: "Test it", status: "in_progress" }] },
    ]);
    // Each plan is complete as soon as it is shown, so it never looks pending.
    expect(events.filter((e) => e.kind === "tool_result")).toHaveLength(2);
  });

  it("shows a spawned agent as a subagent call with its report", () => {
    const item = (status: string, states: object) => ({
      id: "s1",
      type: "collab_tool_call",
      tool: "spawn_agent",
      sender_thread_id: "th_1",
      receiver_thread_ids: ["th_2"],
      prompt: "Check the tests\nand report back",
      agents_states: states,
      status,
    });
    const events = flat(
      { type: "item.started", item: item("in_progress", {}) },
      { type: "item.completed", item: item("completed", { th_2: { status: "completed", message: "All green." } }) },
    );
    expect(events).toEqual([
      { kind: "tool_call", message: "Agent", data: { id: "s1", name: "Agent", input: { description: "Check the tests", prompt: "Check the tests\nand report back" } } },
      { kind: "tool_result", message: "All green.", data: { toolUseId: "s1", isError: false } },
    ]);
  });

  it("drops Codex's notices about the factory's own flags and retries, and reports a failed turn", () => {
    expect(
      flat(
        { type: "item.completed", item: { id: "e0", type: "error", message: "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation." } },
        { type: "turn.started" },
        { type: "error", message: "Reconnecting... 2/5 (unexpected status 401 Unauthorized)" },
        { type: "item.completed", item: { id: "e1", type: "error", message: "Falling back from WebSockets to HTTPS transport." } },
        { type: "error", message: "unexpected status 401 Unauthorized: Incorrect API key provided" },
        { type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Incorrect API key provided" } },
      ),
    ).toEqual([
      { kind: "error", message: "unexpected status 401 Unauthorized: Incorrect API key provided" },
      {
        kind: "agent_result",
        message: "unexpected status 401 Unauthorized: Incorrect API key provided",
        data: { isError: true, subtype: "error", durationMs: 1000 },
      },
    ]);
  });

  it("unwraps the shell Codex runs commands in", () => {
    expect(unwrapShell("/bin/bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(unwrapShell('bash -lc "echo \\"$HOME\\""')).toBe('echo "$HOME"');
    expect(unwrapShell("git status")).toBe("git status");
  });
});
