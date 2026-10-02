import type { ApiRunEvent } from "@factory/core/api";
import { describe, expect, it } from "vitest";
import { agentActivity, ASK_USER_TOOL, openQuestion, toBlocks } from "../src/lib/activity.js";

let n = 0;
const ev = (kind: ApiRunEvent["kind"], message: string, data: ApiRunEvent["data"] = null): ApiRunEvent => ({
  id: String(++n),
  at: new Date(0),
  kind,
  message,
  data,
});

describe("agentActivity", () => {
  it("rests after the agent finishes while the factory publishes and waits for CI", () => {
    const events = [
      ev("info", "Running the agent"),
      ev("tool_call", "Bash", { id: "t1", name: "Bash", input: { command: "pnpm test" } }),
    ];
    expect(agentActivity(events, true)).toBe("working");
    events.push(ev("agent_result", "Done."), ev("info", "Committing and pushing"));
    expect(agentActivity(events, true)).toBe("idle");
    events.push(ev("info", `Waiting for CI on ${"a".repeat(40)}`));
    expect(agentActivity(events, true)).toBe("waiting_ci");
    events.push(ev("info", `CI passed for ${"a".repeat(40)}`));
    expect(agentActivity(events, true)).toBe("idle");
  });

  it("resumes for a CI repair or a later turn only when the agent starts working", () => {
    const events = [ev("agent_result", "Done."), ev("info", "Waiting for CI on abc")];
    events.push(ev("user_message", "Also fix the title"));
    expect(agentActivity(events, true)).toBe("waiting_ci");
    events.push(ev("info", "Continuing the agent's session"));
    expect(agentActivity(events, true)).toBe("working");
    events.push(ev("agent_result", "Fixed."));
    expect(agentActivity(events, true)).toBe("idle");
    events.push(ev("message", "Starting the next change."));
    expect(agentActivity(events, true)).toBe("working");
  });

  it("shows a recovered CI repair as working before it produces fresh output", () => {
    const events = [
      ev("agent_result", "Done."),
      ev("info", "Waiting for CI on abc"),
      ev("info", "Reconnecting to the agent"),
    ];
    expect(agentActivity(events, true)).toBe("working");
  });

  it("handles missing final output and lets finished run status override stale tool calls", () => {
    const events = [ev("tool_call", "Bash"), ev("info", "Waiting for CI on abc")];
    expect(agentActivity(events, true)).toBe("waiting_ci");
    events.push(ev("info", "No CI checks were reported for abc during the discovery period"));
    expect(agentActivity(events, true)).toBe("idle");
    expect(agentActivity([ev("tool_call", "Bash")], false)).toBe("idle");
  });

  it("tracks plain-output agents and the separate PR description session", () => {
    const events = [ev("info", "Running the agent"), ev("stdout", "Done.")];
    expect(agentActivity(events, true)).toBe("working");
    events.push(ev("info", "Committing and pushing"));
    expect(agentActivity(events, true)).toBe("idle");
    events.push(ev("info", "Writing the pull request description"));
    expect(agentActivity(events, true)).toBe("working");
    events.push(ev("info", "Waiting for CI on abc"));
    expect(agentActivity(events, true)).toBe("waiting_ci");
  });

  it("rests when the pull request merges during an automated repair", () => {
    expect(agentActivity([
      ev("info", "Continuing the agent's session"),
      ev("tool_call", "Bash"),
      ev("info", "Pull request merged: https://github.com/o/r/pull/1"),
    ], true)).toBe("idle");
  });
});

describe("toBlocks", () => {
  it("keeps unfinished calls and questions stopped when the agent starts a later turn", () => {
    const boundary = ev("info", "CI passed for abc");
    const blocks = toBlocks([
      ev("tool_call", "Agent", { id: "a1", name: "Agent", input: { description: "Check tests" } }),
      ev("tool_call", ASK_USER_TOOL, { id: "q1", name: ASK_USER_TOOL, input: { question: "Which tests?" } }),
      boundary,
      ev("info", "Continuing the agent's session"),
      ev("tool_call", "Agent", { id: "a2", name: "Agent", input: { description: "Update docs" } }),
    ]);
    const first = blocks[0]!;
    expect(first.type === "work" && first.items[0]).toMatchObject({ id: "a1", stoppedAt: boundary.at });
    const latest = blocks.at(-1)!;
    expect(latest.type === "work" && latest.items.at(-1)).toMatchObject({ id: "a2" });
    expect(latest.type === "work" && latest.items.at(-1)).not.toHaveProperty("stoppedAt");
    expect(openQuestion(blocks)).toBeUndefined();
  });

  it("groups work between the agent's messages and pairs tool calls with results", () => {
    const blocks = toBlocks([
      ev("info", "Creating Railway sandbox"),
      ev("stdout", "cloning\n"),
      ev("stdout", "done\n"),
      ev("message", "I'll add a README."),
      ev("tool_call", "Write", { id: "t1", name: "Write", input: { file_path: "/workspace/repo/README.md", content: "# Hi" } }),
      ev("tool_call", "Bash", { id: "t2", name: "Bash", input: { command: "ls" } }),
      ev("tool_result", "ok", { toolUseId: "t1", isError: false }),
      ev("message", "Done."),
      ev("agent_result", "Done.", { isError: false, turns: 3, costUsd: 0.1 }),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(["work", "message", "work", "message", "result"]);
    const first = blocks[0]!;
    expect(first.type === "work" && first.items.map((i) => i.type)).toEqual(["step", "output"]);
    const tools = blocks[2]!;
    expect(tools.type === "work" && tools.items).toMatchObject([
      { type: "tool", name: "Write", result: { text: "ok", isError: false } },
      { type: "tool", name: "Bash" },
    ]);
    expect(tools.type === "work" && tools.items[1]!.type === "tool" && tools.items[1]!.result).toBeUndefined();
    expect(blocks[4]).toMatchObject({ type: "result", turns: 3, costUsd: 0.1, isError: false });
  });

  it("pulls questions out of the work log and knows which one is still open", () => {
    const events = [
      ev("tool_call", ASK_USER_TOOL, { id: "q1", name: ASK_USER_TOOL, input: { question: "A or B?" } }),
      ev("user_message", "B"),
    ];
    const open = toBlocks(events);
    expect(open.map((b) => b.type)).toEqual(["question", "user"]);
    expect(openQuestion(open)?.id).toBe("q1");

    const answered = toBlocks([...events, ev("tool_result", "The user answered:\n\nB", { toolUseId: "q1", isError: false })]);
    expect(openQuestion(answered)).toBeUndefined();
  });

  it("nests what a subagent did inside the call that started it", () => {
    const blocks = toBlocks([
      ev("tool_call", "Agent", { id: "task", name: "Agent", input: { description: "look around" } }),
      ev("tool_call", "Read", { id: "r1", name: "Read", input: { file_path: "/a" }, parentToolUseId: "task" }),
      ev("message", "found it", { parentToolUseId: "task" }),
      ev("tool_result", "a", { toolUseId: "r1", isError: false, parentToolUseId: "task" }),
      ev("tool_result", "Found it.", { toolUseId: "task", isError: false, stats: { durationMs: 900, tokens: 12, toolUses: 1 } }),
    ]);
    expect(blocks).toHaveLength(1);
    const work = blocks[0]!;
    if (work.type !== "work") throw new Error("expected a work log");
    expect(work.items.map((i) => i.type)).toEqual(["tool"]);
    const task = work.items[0]!;
    if (task.type !== "tool") throw new Error("expected the subagent call");
    expect(task.children?.map((i) => i.type)).toEqual(["tool", "note"]);
    expect(task.stats).toEqual({ durationMs: 900, tokens: 12, toolUses: 1 });
    expect(task.result?.text).toBe("Found it.");
  });
});
