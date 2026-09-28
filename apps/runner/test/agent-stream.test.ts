import { describe, expect, it } from "vitest";
import { makeAgentStream, MAX_TOOL_TEXT, parseAgentLine } from "../src/agent-stream.js";

const line = (msg: object) => JSON.stringify(msg);

describe("parseAgentLine", () => {
  it("keeps lines that aren't agent JSON as plain output", () => {
    expect(parseAgentLine("npm WARN deprecated")).toBeUndefined();
    expect(parseAgentLine("{not json")).toBeUndefined();
    expect(parseAgentLine(line({ level: "info", msg: "a structured log line" }))).toBeUndefined();
  });

  it("turns the init message into a step, and flags a factory tool that failed to start", () => {
    expect(parseAgentLine(line({ type: "system", subtype: "init", model: "claude-x", mcp_servers: [{ name: "factory", status: "connected" }] }))).toEqual([
      { kind: "info", message: "Agent started (claude-x)" },
    ]);
    expect(parseAgentLine(line({ type: "system", subtype: "init", mcp_servers: [{ name: "factory", status: "failed" }] }))).toEqual([
      { kind: "info", message: "Agent started" },
      { kind: "error", message: "The ask-the-user tool did not start (failed), so the agent cannot ask questions" },
    ]);
    expect(parseAgentLine(line({ type: "system", subtype: "compact_boundary" }))).toEqual([]);
  });

  it("splits an assistant message into text, thinking and tool calls", () => {
    const events = parseAgentLine(
      line({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "thinking", thinking: "Let me look." },
            { type: "text", text: "I'll check the tests." },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm test", description: "Run tests" } },
            { type: "text", text: "  " },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { kind: "thinking", message: "Let me look.", data: null },
      { kind: "message", message: "I'll check the tests.", data: null },
      { kind: "tool_call", message: "Bash", data: { id: "toolu_1", name: "Bash", input: { command: "pnpm test", description: "Run tests" } } },
    ]);
  });

  it("marks what a subagent did with the tool call that started it", () => {
    const [event] = parseAgentLine(
      line({ type: "assistant", parent_tool_use_id: "toolu_task", message: { content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/a" } }] } }),
    )!;
    expect(event!.data).toMatchObject({ id: "toolu_2", parentToolUseId: "toolu_task" });
  });

  it("reads tool results given as a string or as blocks, and caps long ones", () => {
    const events = parseAgentLine(
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false },
            { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "boom" }, { type: "image" }], is_error: true },
            { type: "tool_result", tool_use_id: "toolu_3", content: "x".repeat(MAX_TOOL_TEXT + 5) },
          ],
        },
      }),
    )!;
    expect(events.slice(0, 2)).toEqual([
      { kind: "tool_result", message: "ok", data: { toolUseId: "toolu_1", isError: false } },
      { kind: "tool_result", message: "boom\n[image]", data: { toolUseId: "toolu_2", isError: true } },
    ]);
    expect(events[2]!.message).toMatch(/\[5 more characters not shown\]$/);
  });

  it("caps long strings in tool inputs", () => {
    const [event] = parseAgentLine(
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Write", input: { file_path: "/a", content: "y".repeat(MAX_TOOL_TEXT * 2) } }] } }),
    )!;
    const input = (event!.data as { input: { content: string; file_path: string } }).input;
    expect(input.file_path).toBe("/a");
    expect(input.content.length).toBeLessThan(MAX_TOOL_TEXT + 100);
  });

  it("summarises the final result", () => {
    expect(
      parseAgentLine(line({ type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 7, duration_ms: 1200, total_cost_usd: 0.42 })),
    ).toEqual([{ kind: "agent_result", message: "Done.", data: { isError: false, subtype: "success", turns: 7, durationMs: 1200, costUsd: 0.42 } }]);
  });
});

describe("makeAgentStream", () => {
  it("reassembles lines split across chunks and passes other output through", () => {
    const events: string[] = [];
    const stream = makeAgentStream({
      event: (e) => events.push(`${e.kind}:${e.message}`),
      output: (s, text) => events.push(`${s}:${text}`),
    });
    const msg = line({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    stream.write("stdout", `plain\n${msg.slice(0, 10)}`);
    stream.write("stderr", "warning\n");
    stream.write("stdout", `${msg.slice(10)}\ntrailing`);
    stream.end();
    expect(events).toEqual(["stdout:plain\n", "stderr:warning\n", "message:hi", "stdout:trailing\n"]);
  });
});
