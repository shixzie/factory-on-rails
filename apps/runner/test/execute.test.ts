import type { RunRow } from "@factory/core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { executeRun, type ExecuteOptions } from "../src/execute.js";
import { NO_CHANGES_MARKER } from "../src/plan.js";
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
) => {
  const github: unknown[][] = [];
  return Effect.gen(function* () {
    const log = yield* makeRunLog(run.id);
    log.addSecret(agent.env.ANTHROPIC_API_KEY!);
    const outcome = yield* executeRun(run, { log, agent, git: { authorName: "A", authorEmail: "a@x" }, harnessUrl: Option.none(), ...extra });
    yield* log.flush;
    return { outcome, github, events: store.events.map((e) => `${e.kind}:${e.message}`) };
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(sandboxes.layer, store.layer, fakeGitHub(github))));
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
        { repositories: ["demo"], permissions: { contents: "write", pull_requests: "write", metadata: "read" } },
      ]);
      expect(sandboxes.state.createdWith).toEqual({ ANTHROPIC_API_KEY: "sk-ant-user-key", GH_TOKEN: "ghs_repo_token", IS_SANDBOX: "1" });
      expect(github[1]).toEqual([
        "createPullRequest",
        "ghs_repo_token",
        "shixzie/demo",
        expect.objectContaining({ title: "Add a README", head: "factory/run-0123abcd", base: "main" }),
      ]);
      expect(sandboxes.state.commands.map((c) => c.split("\n")[0])).toEqual(["set -eu", "setup-agent", "run-agent", "set -eu"]);
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
      const store = recordingStore(() => (sandboxes.state.commands.includes("run-agent") ? "cancelling" : "running"));
      const { outcome, events } = yield* execute(sandboxes, store, { heartbeatEvery: "5 millis" });

      expect(outcome).toEqual({ status: "cancelled" });
      expect(sandboxes.state.killed).toBe(true);
      expect(sandboxes.state.commands).not.toContainEqual(expect.stringContaining("git push"));
      expect(sandboxes.state.destroyed).toBe(true);
      expect(events).toContain("info:Run cancelled");
    }),
  );
});
