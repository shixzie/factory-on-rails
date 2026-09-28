import type { RunRow } from "@factory/core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { ASK_USER_TOOL } from "../src/agent-stream.js";
import { executeRun, type ExecuteOptions } from "../src/execute.js";
import { MAX_DIFF_BYTES, NO_CHANGES_MARKER } from "../src/plan.js";
import { makeRunLog } from "../src/run-log.js";
import { fakeGitHub, fakeSandboxes, recordingStore } from "./stubs.js";

const run = {
  id: "0123abcd-0000-4000-8000-000000000000",
  repo_full_name: "shixzie/demo",
  installation_id: "42",
  base_branch: "main",
  task: "Add a README\n\nWith a heading.",
} as RunRow;

const agent: ExecuteOptions["agent"] = {
  setupCommand: "setup-agent",
  command: "run-agent",
  timeoutSec: 60,
  env: { ANTHROPIC_API_KEY: "sk-ant-user-key" },
};

/** Runs `executeRun` against fakes and returns the outcome plus what it touched. */
const execute = (
  sandboxes: ReturnType<typeof fakeSandboxes>,
  store = recordingStore(),
  extra: Partial<ExecuteOptions> = {},
  grantedPermissions?: string[],
) => {
  const github: unknown[][] = [];
  return Effect.gen(function* () {
    const log = yield* makeRunLog(run.id);
    log.addSecret(agent.env.ANTHROPIC_API_KEY!);
    const outcome = yield* executeRun(run, { log, agent, git: { authorName: "A", authorEmail: "a@x" }, harnessUrl: Option.none(), ...extra });
    yield* log.flush;
    return { outcome, github, events: store.events.map((e) => `${e.kind}:${e.message}`) };
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(sandboxes.layer, store.layer, fakeGitHub(github, grantedPermissions))));
};

describe("executeRun", () => {
  it.effect("runs the agent, pushes and opens a PR, then destroys the sandbox", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes();
      const store = recordingStore();
      const { outcome, github } = yield* execute(sandboxes, store);

      expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: "https://github.com/shixzie/demo/pull/1" });
      expect(github[0]).toEqual([
        "installationToken",
        42,
        {
          repositories: ["demo"],
          permissions: { contents: "write", pull_requests: "write", metadata: "read", workflows: "write" },
        },
      ]);
      expect(sandboxes.state.createdWith).toEqual({ ANTHROPIC_API_KEY: "sk-ant-user-key", GH_TOKEN: "ghs_repo_token", IS_SANDBOX: "1" });
      expect(github[1]).toEqual([
        "createPullRequest",
        "ghs_repo_token",
        "shixzie/demo",
        expect.objectContaining({ title: "Add a README", head: "factory/run-0123abcd", base: "main" }),
      ]);
      expect(sandboxes.state.commands.every((c) => c.startsWith('export HOME="${HOME:-/root}"\n'))).toBe(true);
      expect(sandboxes.state.commands.map((c) => c.split("\n")[1])).toEqual([
        expect.stringMatching(/^for i in/),
        "set -eu",
        "setup-agent",
        "run-agent",
        "set -eu",
        "set -eu",
      ]);
      expect(sandboxes.state.commands[4]).toContain("git diff --cached");
      expect(Object.keys(sandboxes.state.files)).toEqual(
        expect.arrayContaining(["/workspace/.factory/ask-server.mjs", "/workspace/.factory/settings.json", "/workspace/.factory/mcp.json"]),
      );
      expect(sandboxes.state.envs[3]).toMatchObject({
        FACTORY_TASK_FILE: "/workspace/TASK.md",
        FACTORY_MCP_CONFIG: "/workspace/.factory/mcp.json",
        FACTORY_SETTINGS_FILE: "/workspace/.factory/settings.json",
      });
      expect(store.updates).toEqual([
        { sandbox_id: "sbx_1", branch: "factory/run-0123abcd" },
        { pull_request_url: "https://github.com/shixzie/demo/pull/1" },
      ]);
      expect(sandboxes.state.destroyed).toBe(true);
    }),
  );

  it.effect("succeeds without a PR when the agent changed nothing", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes({ "git push": { stdout: `${NO_CHANGES_MARKER}\n` } });
      const { outcome, github } = yield* execute(sandboxes);
      expect(outcome).toEqual({ status: "succeeded" });
      expect(github.map((c) => c[0])).toEqual(["installationToken"]);
      expect(sandboxes.state.destroyed).toBe(true);
    }),
  );

  it.effect("fails when the agent exits non-zero, and still cleans up", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes({ "run-agent": { exitCode: 2 } });
      const { outcome, events } = yield* execute(sandboxes);
      expect(outcome).toEqual({ status: "failed", error: "Running the agent: exited with code 2" });
      expect(events).toContain("error:Running the agent: exited with code 2");
      expect(events.at(-1)).toBe("info:Sandbox destroyed");
      expect(sandboxes.state.destroyed).toBe(true);
    }),
  );

  it.effect("says so when the sandbox has no outbound network", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes({
        "git ls-remote": {
          exitCode: 1,
          stdout: "Railway recovery console: your sandbox VM has lost outbound network connectivity.\n",
        },
      });
      const { outcome } = yield* execute(sandboxes);
      expect(outcome).toEqual({
        status: "failed",
        error:
          "Checking the sandbox can reach GitHub: the Railway sandbox has no outbound network (it started in Railway's recovery console). Try the run again.",
      });
      expect(sandboxes.state.commands).toHaveLength(1);
      expect(sandboxes.state.destroyed).toBe(true);
    }),
  );

  it.effect("runs without workflow access when the App was never granted it", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes();
      const store = recordingStore();
      const { outcome, github, events } = yield* execute(sandboxes, store, {}, [
        "contents",
        "pull_requests",
        "metadata",
      ]);
      expect(outcome.status).toBe("succeeded");
      expect(github.filter((c) => c[0] === "installationToken").map((c) => Object.keys((c[2] as { permissions: object }).permissions))).toEqual([
        ["contents", "pull_requests", "metadata", "workflows"],
        ["contents", "pull_requests", "metadata"],
      ]);
      expect(events).toContain(
        "info:The GitHub App has no Workflows permission, so this run can't change files in .github/workflows",
      );
    }),
  );

  it.effect("explains a push GitHub refused for touching workflows", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes({
        "git push": {
          exitCode: 1,
          stdout:
            " ! [remote rejected] HEAD -> factory/run-0123abcd (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)\n",
        },
      });
      const { outcome } = yield* execute(sandboxes);
      expect(outcome).toEqual({
        status: "failed",
        error:
          'Committing and pushing: GitHub refused the push because the agent changed a file in .github/workflows and the GitHub App has no Workflows permission. Give the App "Workflows: Read and write", accept it on the installation, then run again.',
      });
      expect(sandboxes.state.destroyed).toBe(true);
    }),
  );

  it.effect("fails cleanly when no sandbox can be created", () =>
    Effect.gen(function* () {
      const { outcome } = yield* execute(fakeSandboxes({}, { failCreate: "sandbox limit reached" }));
      expect(outcome).toEqual({ status: "failed", error: "sandbox limit reached" });
    }),
  );

  it.live("stops the agent and destroys the sandbox when the run is cancelled", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes({}, { hang: "run-agent" });
      // Report cancellation once the agent is running.
      const store = recordingStore(() => (sandboxes.state.commands.some((c) => c.includes("run-agent")) ? "cancelling" : "running"));
      const { outcome, events } = yield* execute(sandboxes, store, { heartbeatEvery: "5 millis" });

      expect(outcome).toEqual({ status: "cancelled" });
      expect(sandboxes.state.killed).toBe(true);
      expect(sandboxes.state.commands).not.toContainEqual(expect.stringContaining("git push"));
      expect(sandboxes.state.destroyed).toBe(true);
      expect(events).toContain("info:Run cancelled");
    }),
  );

  it.effect("stores the agent's stream as structured events and records the final diff", () =>
    Effect.gen(function* () {
      const stream = [
        { type: "system", subtype: "init", model: "claude-x" },
        { type: "assistant", message: { content: [{ type: "text", text: "Adding it." }, { type: "tool_use", id: "t1", name: "Write", input: { file_path: "README.md", content: "# Hi" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Wrote sk-ant-user-key" }] } },
        { type: "result", subtype: "success", is_error: false, result: "Added a README." },
      ]
        .map((m) => JSON.stringify(m))
        .join("\n");
      const patch = "diff --git a/README.md b/README.md\nnew file mode 100644\n+# Hi\n";
      const sandboxes = fakeSandboxes({ "run-agent": { stdout: `${stream}\nplain text\n` }, "git diff --cached": { stdout: patch } });
      const store = recordingStore();
      const { events } = yield* execute(sandboxes, store);
      expect(events).toEqual(
        expect.arrayContaining([
          "info:Agent started (claude-x)",
          "message:Adding it.",
          "tool_call:Write",
          "tool_result:Wrote [redacted]",
          "agent_result:Added a README.",
          "stdout:plain text\n",
        ]),
      );
      expect(store.events.find((e) => e.kind === "tool_call")!.data).toEqual({ id: "t1", name: "Write", input: { file_path: "README.md", content: "# Hi" } });
      expect(store.diffs).toEqual([{ patch, truncated: false }]);
    }),
  );

  it.effect("records the diff even when the agent fails, and caps a huge one", () =>
    Effect.gen(function* () {
      const big = ["a", "b"].map((f) => `diff --git a/${f} b/${f}\n+${"x".repeat(MAX_DIFF_BYTES / 2 + 10)}\n`).join("");
      const store = recordingStore();
      const { outcome } = yield* execute(fakeSandboxes({ "run-agent": { exitCode: 1 }, "git diff --cached": { stdout: big } }), store);
      expect(outcome.status).toBe("failed");
      expect(store.diffs).toHaveLength(1);
      expect(store.diffs[0]!.truncated).toBe(true);
      expect(store.diffs[0]!.patch.startsWith("diff --git a/a b/a")).toBe(true);
      expect(store.diffs[0]!.patch).not.toContain("diff --git a/b");
    }),
  );

  it.live("hands the user's messages to the agent and flags when it waits for an answer", () =>
    Effect.gen(function* () {
      const store = recordingStore();
      store.userMessages.push({ id: "7", run_id: run.id, at: new Date(0), kind: "user_message", message: "Use pnpm", data: null });
      const ask = { type: "assistant", message: { content: [{ type: "tool_use", id: "q1", name: ASK_USER_TOOL, input: { question: "Which?" } }] } };
      const answered = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "The user answered: A" }] } };
      const sandboxes = fakeSandboxes({
        "run-agent": (onOutput) =>
          Effect.gen(function* () {
            onOutput("stdout", `${JSON.stringify(ask)}\n`);
            yield* Effect.sleep("150 millis");
            onOutput("stdout", `${JSON.stringify(answered)}\n`);
            yield* Effect.sleep("150 millis");
            return {};
          }),
      });
      yield* execute(sandboxes, store, { inboxEvery: "10 millis", diffEvery: "10 millis" });

      const delivered = sandboxes.state.commands.findIndex((c) => c.includes("FACTORY_MESSAGE"));
      expect(delivered).toBeGreaterThan(0);
      expect(sandboxes.state.commands[delivered]).toContain("/workspace/.factory/inbox/0000000000000007.json");
      expect(JSON.parse(sandboxes.state.envs[delivered]!.FACTORY_MESSAGE!)).toMatchObject({ text: "Use pnpm" });
      // Delivered once, however many times the inbox was checked.
      expect(sandboxes.state.commands.filter((c) => c.includes("FACTORY_MESSAGE"))).toHaveLength(1);
      const flags = store.updates.filter((u) => "awaiting_input" in u);
      expect(flags).toEqual([{ awaiting_input: true }, { awaiting_input: false }]);
    }),
  );
});
