import type { RunRow, RunStatus } from "@factory/core";
import { describe, expect, it, vi } from "vitest";
import { executeRun, type ExecHandleLike, type ExecResultLike, type RunDeps, type SandboxLike } from "../src/execute.js";
import { NO_CHANGES_MARKER } from "../src/plan.js";

const run = {
  id: "0123abcd-0000-4000-8000-000000000000",
  repo_full_name: "shixzie/demo",
  installation_id: "42",
  base_branch: "main",
  task: "Add a README\n\nWith a heading.",
} as RunRow;

function handle(result: Partial<ExecResultLike>, onKill?: () => void): ExecHandleLike {
  const full = { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...result };
  return { then: (ok, err) => Promise.resolve(full).then(ok, err), kill: async () => onKill?.() };
}

function fakeSandbox(results: Record<string, Partial<ExecResultLike>> = {}) {
  const commands: string[] = [];
  const sandbox: SandboxLike & { commands: string[]; destroyed: boolean } = {
    id: "sbx_1",
    commands,
    destroyed: false,
    exec: (command) => {
      commands.push(command);
      const key = Object.keys(results).find((k) => command.includes(k));
      return handle(key ? results[key]! : {});
    },
    files: { write: async () => undefined },
    destroy: async () => {
      sandbox.destroyed = true;
    },
  };
  return sandbox;
}

function deps(sandbox: SandboxLike, overrides: Partial<RunDeps> = {}) {
  const events: string[] = [];
  const d: RunDeps = {
    createSandbox: vi.fn(async () => sandbox),
    mintRepoToken: vi.fn(async () => "ghs_token"),
    createPullRequest: vi.fn(async () => "https://github.com/shixzie/demo/pull/1"),
    report: {
      info: (m) => events.push(`info:${m}`),
      error: (m) => events.push(`error:${m}`),
      output: () => {},
      update: vi.fn(async () => {}),
      heartbeat: vi.fn(async (): Promise<RunStatus> => "running"),
    },
    agent: { setupCommand: "setup-agent", command: "run-agent", timeoutSec: 60, env: { ANTHROPIC_API_KEY: "k" } },
    git: { authorName: "A", authorEmail: "a@x" },
    ...overrides,
  };
  return { d, events };
}

describe("executeRun", () => {
  it("runs the agent, pushes and opens a PR, then destroys the sandbox", async () => {
    const sandbox = fakeSandbox();
    const { d } = deps(sandbox);
    const outcome = await executeRun(run, d);

    expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: "https://github.com/shixzie/demo/pull/1" });
    expect(d.mintRepoToken).toHaveBeenCalledWith(42, "shixzie/demo");
    expect(d.createSandbox).toHaveBeenCalledWith({ ANTHROPIC_API_KEY: "k", GH_TOKEN: "ghs_token", IS_SANDBOX: "1" });
    expect(d.createPullRequest).toHaveBeenCalledWith(
      "ghs_token",
      "shixzie/demo",
      expect.objectContaining({ title: "Add a README", head: "factory/run-0123abcd", base: "main" }),
    );
    expect(sandbox.commands.map((c) => c.split("\n")[0])).toEqual(["set -eu", "setup-agent", "run-agent", "set -eu"]);
    expect(sandbox.destroyed).toBe(true);
  });

  it("succeeds without a PR when the agent changed nothing", async () => {
    const sandbox = fakeSandbox({ "git push": { stdout: `${NO_CHANGES_MARKER}\n` } });
    const { d } = deps(sandbox);
    expect(await executeRun(run, d)).toEqual({ status: "succeeded" });
    expect(d.createPullRequest).not.toHaveBeenCalled();
    expect(sandbox.destroyed).toBe(true);
  });

  it("fails when the agent exits non-zero and still cleans up", async () => {
    const sandbox = fakeSandbox({ "run-agent": { exitCode: 2 } });
    const { d, events } = deps(sandbox);
    expect(await executeRun(run, d)).toEqual({ status: "failed", error: "Running the agent: exited with code 2" });
    expect(events).toContain("error:Running the agent: exited with code 2");
    expect(sandbox.destroyed).toBe(true);
  });

  it("fails cleanly when no sandbox can be created", async () => {
    const { d } = deps(fakeSandbox(), {
      createSandbox: async () => {
        throw new Error("sandbox limit reached");
      },
    });
    expect(await executeRun(run, d)).toEqual({ status: "failed", error: "sandbox limit reached" });
  });

  it("stops the agent when the run is cancelled", async () => {
    let release: (r: ExecResultLike) => void = () => {};
    const kill = vi.fn(async () => release({ exitCode: -1, stdout: "", stderr: "", timedOut: false }));
    const sandbox = fakeSandbox();
    sandbox.exec = (command) => {
      sandbox.commands.push(command);
      if (command !== "run-agent") return handle({});
      const pending = new Promise<ExecResultLike>((r) => (release = r));
      return { then: (ok, err) => pending.then(ok, err), kill };
    };
    const { d } = deps(sandbox, { heartbeatIntervalMs: 5 });
    d.report.heartbeat = async () => "cancelling";

    expect(await executeRun(run, d)).toEqual({ status: "cancelled" });
    expect(kill).toHaveBeenCalledWith("TERM");
    expect(sandbox.commands).not.toContainEqual(expect.stringContaining("git push"));
    expect(sandbox.destroyed).toBe(true);
  });
});
