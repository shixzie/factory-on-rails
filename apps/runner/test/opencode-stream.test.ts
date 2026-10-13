import { describe, expect, it } from "vitest";
import { ASK_USER_TOOL } from "../src/agent-stream.js";
import { makeOpenCodeParser, patchChanges, toolCall } from "../src/opencode-stream.js";

const S = "ses_root";

/** Feeds `opencode run --format json` events (objects or raw lines) through one parser. */
const parse = (...lines: (object | string)[]) => {
  let t = 0;
  const parser = makeOpenCodeParser({ mcpServers: ["docs-api", "docs"], now: () => (t += 1000) });
  return lines.map((l) => parser(typeof l === "string" ? l : JSON.stringify(l)));
};
const flat = (...lines: (object | string)[]) => parse(...lines).flatMap((e) => e ?? []);
const ev = (type: string, part: object, sessionID = S) => ({ type, timestamp: 1, sessionID, part });
const tool = (tool: string, id: string, state: object, sessionID = S) => ev("tool_use", { type: "tool", tool, id, state }, sessionID);
/** What OpenCode 2 says the model got back from a tool, and the tool's own metadata. */
const meta = (text: string, metadata: object = {}) => ({ metadata, content: [{ type: "text", text }] });

describe("OpenCode's JSON events", () => {
  it("keeps lines that aren't OpenCode JSON as plain output", () => {
    expect(parse("Performing one time database migration...", "{not json", '{"type":"system"}')).toEqual([undefined, undefined, undefined]);
  });

  it("turns a recorded run into messages, tool calls and a closing result", () => {
    // Recorded from `opencode run --standalone --format json --auto` 2.0.28, trimmed.
    const events = flat(
      ev("step_start", { type: "step-start" }),
      tool("read", "call_0", { status: "completed", input: { path: "/w/a.txt" }, output: "<path>/w/a.txt</path>\n<content>\n1: hello\n</content>", metadata: meta("<path>/w/a.txt</path>\n<content>\n1: hello\n</content>"), title: "a.txt" }),
      tool("shell", "call_1", { status: "completed", input: { command: "ls", description: "List files" }, output: "a.txt\n", metadata: meta("a.txt\n", { exit: 0 }) }),
      tool("write", "call_2", { status: "completed", input: { path: "/w/b.txt", content: "world" }, output: "Wrote file successfully.", metadata: meta("Wrote file successfully.") }),
      ev("step_finish", { type: "step-finish", reason: "tool-calls", tokens: { total: 11516, input: 9551, output: 129, reasoning: 44, cache: { write: 0, read: 1792 } }, cost: 0.01 }),
      ev("step_start", { type: "step-start" }),
      ev("reasoning", { type: "reasoning", text: "All three done." }),
      ev("text", { type: "text", messageID: "msg_2", text: "done" }),
      ev("step_finish", { type: "step-finish", reason: "stop", tokens: { total: 11601, input: 335, output: 2, reasoning: 0, cache: { write: 0, read: 11264 } }, cost: 0.002 }),
    );
    expect(events).toEqual([
      { kind: "info", message: "Agent started (OpenCode)" },
      { kind: "tool_call", message: "Read", data: { id: "call_0", name: "Read", input: { file_path: "/w/a.txt" } } },
      { kind: "tool_result", message: "<path>/w/a.txt</path>\n<content>\n1: hello\n</content>", data: { toolUseId: "call_0", isError: false } },
      { kind: "tool_call", message: "Bash", data: { id: "call_1", name: "Bash", input: { command: "ls", description: "List files" } } },
      { kind: "tool_result", message: "a.txt\n", data: { toolUseId: "call_1", isError: false } },
      { kind: "tool_call", message: "Write", data: { id: "call_2", name: "Write", input: { file_path: "/w/b.txt", content: "world" } } },
      { kind: "tool_result", message: "Wrote file successfully.", data: { toolUseId: "call_2", isError: false } },
      { kind: "thinking", message: "All three done.", data: null },
      { kind: "message", message: "done", data: null },
      {
        kind: "agent_result",
        message: "done",
        data: {
          isError: false,
          subtype: "success",
          durationMs: 1000,
          costUsd: 0.012,
          usage: { input_tokens: 9886, output_tokens: 131, reasoning_tokens: 44, cache_read_input_tokens: 13056, cache_creation_input_tokens: 0 },
        },
      },
    ]);
  });

  it("closes the turn after the run when OpenCode didn't print its last step's finish", () => {
    // Recorded from 2.0.28: the last step has no step_finish; the command's line follows the run.
    const events = flat(
      ev("step_start", {}),
      tool("glob", "call_g", { status: "completed", input: { pattern: "*.md" }, metadata: meta("README.md") }),
      ev("step_finish", { reason: "tool-calls", tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 50, write: 0 } }, cost: 0.001 }),
      ev("step_start", {}),
      ev("text", { messageID: "msg_2", text: "done" }),
      { type: "factory_turn_end" },
      { type: "factory_turn_end" },
    );
    expect(events.at(-2)).toEqual({ kind: "message", message: "done", data: null });
    expect(events.at(-1)).toEqual({
      kind: "agent_result",
      message: "done",
      data: {
        isError: false,
        subtype: "success",
        durationMs: 1000,
        costUsd: 0.001,
        usage: { input_tokens: 100, output_tokens: 10, reasoning_tokens: 0, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
      },
    });
  });

  it("shows a tool as soon as the plugin reports it starting, so a question is visible while it waits", () => {
    // Recorded: the plugin's line for a step's first tool arrives before OpenCode's own step_start.
    const [started, step, done] = parse(
      { type: "factory_tool_start", sessionID: S, callID: "call_q", tool: "factory_ask_user", args: { question: "Postgres or SQLite?" } },
      ev("step_start", {}),
      tool("factory_ask_user", "call_q", { status: "completed", input: { question: "Postgres or SQLite?" }, output: "The user answered:\n\nPostgres" }),
    );
    expect(started).toEqual([
      { kind: "info", message: "Agent started (OpenCode)" },
      { kind: "tool_call", message: ASK_USER_TOOL, data: { id: "call_q", name: ASK_USER_TOOL, input: { question: "Postgres or SQLite?" } } },
    ]);
    expect(step).toEqual([]);
    expect(done).toEqual([{ kind: "tool_result", message: "The user answered:\n\nPostgres", data: { toolUseId: "call_q", isError: false } }]);
  });

  it("skips subagents' own tool starts", () => {
    expect(flat(
      ev("step_start", {}),
      { type: "factory_tool_start", sessionID: "ses_child", callID: "call_c", tool: "shell", args: { command: "ls" } },
    )).toEqual([{ kind: "info", message: "Agent started (OpenCode)" }]);
  });

  it("marks failed tools and failing commands as errors", () => {
    const events = flat(
      ev("step_start", {}),
      tool("edit", "call_e", { status: "error", input: { path: "/w/a.ts", oldString: "a", newString: "b" }, error: { message: "oldString not found in content" } }),
      tool("shell", "call_b", { status: "completed", input: { command: "pnpm test" }, metadata: meta("1 failed", { exit: 1 }) }),
    ).slice(1);
    expect(events).toEqual([
      { kind: "tool_call", message: "Edit", data: { id: "call_e", name: "Edit", input: { file_path: "/w/a.ts", old_string: "a", new_string: "b" } } },
      { kind: "tool_result", message: "oldString not found in content", data: { toolUseId: "call_e", isError: true } },
      { kind: "tool_call", message: "Bash", data: { id: "call_b", name: "Bash", input: { command: "pnpm test" } } },
      { kind: "tool_result", message: "1 failed\nExit code 1", data: { toolUseId: "call_b", isError: true } },
    ]);
  });

  it("reports session errors", () => {
    expect(flat(
      ev("step_start", {}),
      { type: "error", sessionID: S, error: { name: "APIError", data: { message: "Invalid API key" } } },
    ).at(-1)).toEqual({ kind: "error", message: "Invalid API key" });
  });

  it("keeps images a tool showed the agent as previews", () => {
    const png = Buffer.from("not really a png").toString("base64");
    const [, result] = flat(
      ev("step_start", {}),
      tool("read", "call_i", { status: "completed", input: { path: "/w/shot.png" }, output: "Image read successfully", metadata: { metadata: {}, content: [{ type: "text", text: "Image read successfully" }, { type: "file", mime: "image/png", uri: `data:image/png;base64,${png}` }] } }),
    ).slice(1);
    expect(result!.data?.media).toEqual([{ sha: expect.any(String), mediaType: "image/png" }]);
    expect((result as { media?: unknown[] }).media).toHaveLength(1);
  });
});

describe("OpenCode tools as the run page knows them", () => {
  it("maps MCP tools to Claude Code's names, preferring the longest server name", () => {
    expect(toolCall("docs-api_search", { q: "x" }, ["docs", "docs-api"]).name).toBe("mcp__docs-api__search");
    expect(toolCall("docs_lookup", {}, ["docs", "docs-api"]).name).toBe("mcp__docs__lookup");
    expect(toolCall("skill", { name: "x" }, ["docs"])).toEqual({ name: "skill", input: { name: "x" } });
  });

  it("maps subagents, searches and patches", () => {
    expect(toolCall("subagent", { description: "Explore", prompt: "Find the router", agent: "explore" })).toEqual({
      name: "Agent",
      input: { description: "Explore", prompt: "Find the router", subagent_type: "explore" },
    });
    expect(toolCall("grep", { pattern: "foo", include: "*.ts" })).toEqual({ name: "Grep", input: { pattern: "foo", glob: "*.ts" } });
    expect(toolCall("glob", { pattern: "*.md" })).toEqual({ name: "Glob", input: { pattern: "*.md" } });
    expect(toolCall("patch", { patchText: "*** Begin Patch\n*** Add File: a.ts\n+x\n*** Update File: b.ts\n@@\n-y\n+z\n*** Delete File: c.ts\n*** End Patch" })).toEqual({
      name: "FileChange",
      input: { changes: [{ path: "a.ts", kind: "add" }, { path: "b.ts", kind: "update" }, { path: "c.ts", kind: "delete" }] },
    });
    expect(patchChanges("no patch here")).toEqual([]);
  });
});
