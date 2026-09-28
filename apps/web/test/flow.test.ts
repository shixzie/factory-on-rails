import type { ApiRunEvent } from "@factory/core/api";
import { describe, expect, it } from "vitest";
import { ASK_USER_TOOL } from "../src/lib/activity.js";
import { describeCall, flowModel, pulsesFor, type FlowContext } from "../src/lib/flow.js";

let n = 0;
const ev = (kind: ApiRunEvent["kind"], message: string, data: ApiRunEvent["data"] = null): ApiRunEvent => ({
  id: String(++n),
  at: new Date(n * 1000),
  kind,
  message,
  data,
});

const run = [
  ev("user_message", "Add a README"),
  ev("tool_call", "Agent", { id: "a1", name: "Agent", input: { description: "Map the repo", subagent_type: "Explore" } }),
  ev("tool_call", "Agent", { id: "a2", name: "Agent", input: { description: "Check CI", subagent_type: "general-purpose" } }),
  ev("tool_call", "Grep", { id: "g1", name: "Grep", input: { pattern: "TODO" }, parentToolUseId: "a1" }),
  ev("tool_call", "Read", { id: "r1", name: "Read", input: { file_path: "/workspace/repo/src/app.ts" }, parentToolUseId: "a1" }),
  ev("tool_result", "…", { toolUseId: "g1", isError: false, parentToolUseId: "a1" }),
  ev("tool_result", "Mapped.", { toolUseId: "a1", isError: false, stats: { durationMs: 3000, tokens: 900, toolUses: 2 } }),
  ev("tool_call", "Write", { id: "w1", name: "Write", input: { file_path: "/workspace/repo/README.md" } }),
  ev("tool_call", ASK_USER_TOOL, { id: "q1", name: ASK_USER_TOOL, input: { question: "Badge?" } }),
  ev("tool_result", "The user answered: yes", { toolUseId: "q1", isError: false }),
  ev("info", "Opened https://github.com/o/r/pull/1"),
];

describe("flow", () => {
  it("turns each event into packets between the right actors", () => {
    const calls: FlowContext = new Map();
    const pulses = run.map((e) => pulsesFor(e, calls).map((p) => `${p.from}>${p.to}:${p.kind}`));
    expect(pulses).toEqual([
      ["user>main:message"],
      ["main>sub:a1:prompt"],
      ["main>sub:a2:prompt"],
      [],
      [],
      ["workspace>sub:a1:read"],
      ["sub:a1>main:report"],
      ["main>workspace:edit"],
      ["main>user:ask"],
      ["user>main:answer"],
      ["workspace>pr:publish"],
    ]);
  });

  it("tracks each subagent's status, work and stats", () => {
    const live = flowModel(run, true);
    expect(live.agents.map((a) => [a.kind, a.description, a.status, a.toolCount, a.lane])).toEqual([
      ["Explore", "Map the repo", "done", 2, 0],
      ["general-purpose", "Check CI", "running", 0, 1],
    ]);
    expect(live.agents[0]!.stats).toEqual({ durationMs: 3000, tokens: 900, toolUses: 2 });
    expect(live.main).toMatchObject({ toolCount: 4, current: "Asking you a question" });
    expect(live.edges["main>sub:a1"]).toBe(1);
    expect(live.published).toBe(true);
    expect(live.usesWeb).toBe(false);
    // Once the run is over, a subagent that never reported back was cut off.
    expect(flowModel(run, false).agents[1]!.status).toBe("stopped");
  });

  it("counts what a subagent's own subagents do as its work", () => {
    const model = flowModel(
      [
        ev("tool_call", "Agent", { id: "top", name: "Agent", input: { description: "Plan" } }),
        ev("tool_call", "Agent", { id: "inner", name: "Agent", input: { description: "Dig" }, parentToolUseId: "top" }),
        ev("tool_call", "Bash", { id: "b", name: "Bash", input: { command: "ls" }, parentToolUseId: "inner" }),
      ],
      true,
    );
    expect(model.agents.map((a) => [a.id, a.toolCount, a.current])).toEqual([["top", 2, "Running ls"]]);
    expect(model.edges).toEqual({ "main>sub:top": 1, "sub:top>workspace": 1 });
  });

  it("describes calls in a few words", () => {
    expect(describeCall("Read", { file_path: "/workspace/repo/src/app.ts" })).toBe("Reading app.ts");
    expect(describeCall("Bash", { command: "pnpm test", description: "Run the tests" })).toBe("Run the tests");
    expect(describeCall("Bash", { command: "pnpm test" })).toBe("Running pnpm test");
    expect(describeCall("mcp__linear__search", {})).toBe("Using linear search");
  });
});
