import { GitHubError, PREVIEW_AGENT_SCRIPT, type CiCheck, type PullRequestState, verifyPreviewGrant, type RunExecution, type RunRow } from "@factory/core";
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, TestClock, Option, Redacted } from "effect";
import { ExecInterruptedError } from "railway";
import { ASK_USER_TOOL } from "../src/agent-stream.js";
import { executeRun, type ExecuteOptions } from "../src/execute.js";
import {
  HAS_SESSION_MARKER,
  MAX_DIFF_BYTES,
  NO_CHANGES_MARKER,
  PREVIEW_AGENT_FILE,
  PREVIEW_TOKEN_FILE,
  TOKEN_FILE,
  UP_TO_DATE_MARKER,
} from "../src/plan.js";
import { makeRunLog } from "../src/run-log.js";
import { SandboxError } from "../src/sandbox.js";
import { fakeGitHub, fakeSandboxes, recordingStore } from "./stubs.js";

const run = {
  id: "0123abcd-0000-4000-8000-000000000000",
  repo_full_name: "shixzie/demo",
  installation_id: "42",
  base_branch: "main",
  task: "Add a README\n\nWith a heading.",
  turns: 1,
  sandbox_id: null,
  sandbox_state: "none",
  sandbox_checkpoint_id: null,
  sandbox_checkpoint_name: null,
  pull_request_url: null,
  delivered_message_id: "0",
} as RunRow;

const PR = "https://github.com/shixzie/demo/pull/1";
const prState = (patch: Partial<PullRequestState> = {}): PullRequestState => ({
  number: 1, html_url: PR, state: "open", merged: false, head: { sha: "a".repeat(40) }, ...patch,
});

/** The same run on its next turn, after the user sent `message` (event id 5). */
const followUp = (patch: Partial<RunRow>) => ({ ...run, turns: 2, branch: "factory/run-0123abcd", pull_request_url: PR, ...patch }) as RunRow;
const withMessage = (store = recordingStore(), text = "Also add a license") => {
  store.userMessages.push({ id: "5", run_id: run.id, at: new Date(0), kind: "user_message", message: text, data: null });
  return store;
};

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
  {
    turn = run,
    prOpen = false,
    grantedPermissions,
    ciChecks,
    pullRequest,
  }: {
    turn?: RunRow;
    prOpen?: boolean;
    grantedPermissions?: string[];
    ciChecks?: (sha: string) => Effect.Effect<ReadonlyArray<CiCheck>, GitHubError>;
    pullRequest?: (number: number) => Effect.Effect<PullRequestState, GitHubError>;
  } = {},
) => {
  const github: unknown[][] = [];
  return Effect.gen(function* () {
    const log = yield* makeRunLog(run.id, { flushEvery: Duration.hours(1) });
    log.addSecret(agent.env.ANTHROPIC_API_KEY!);
    const outcome = yield* executeRun(turn, { log, agent, git: { authorName: "A", authorEmail: "a@x" }, harnessUrl: Option.none(), ciDiscoveryGrace: "0 seconds", ...extra });
    yield* log.flush;
    return { outcome, github, events: store.events.map((e) => `${e.kind}:${e.message}`) };
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(sandboxes.layer, store.layer, fakeGitHub(github, { grantedPermissions, prOpen, ciChecks, pullRequest }))),
  );
};

/** The line each command ran after the shared prelude (HOME and the GitHub token). */
const firstLines = (commands: string[]) => commands.map((c) => c.split("\n")[2]);

const PREVIEW_KEY = "s".repeat(40);
const preview = Option.some({ tunnelUrl: "wss://tunnel.preview.example/connect", signingKey: Redacted.make(PREVIEW_KEY) });

describe("executeRun", () => {
  for (const origin of ["new", "kept", "restored"] as const) {
    it.effect(`loads authenticated MCP tools outside the repository in a ${origin} sandbox`, () => Effect.gen(function* () {
      const token = "mcp-bearer-secret";
      const envSecret = 'mcp-"env"-secret';
      const sandboxes = fakeSandboxes({ "run-agent": { stdout: `using ${token} and ${envSecret}` } }, {
        alive: ["sbx_live"], checkpoints: { cp_1: "saved-sandbox" },
      });
      sandboxes.state.files["/workspace/.factory/mcp.json"] = '{"mcpServers":{"removed":{}}}';
      const turn = origin === "new" ? run : followUp(origin === "kept"
        ? { sandbox_state: "running", sandbox_id: "sbx_live" }
        : { sandbox_state: "stopped", sandbox_checkpoint_id: "cp_1", sandbox_checkpoint_name: "saved-sandbox" });
      let loads = 0;
      const { outcome, events } = yield* execute(sandboxes, recordingStore(), {
        loadMcpServers: Effect.sync(() => {
          loads++;
          return { servers: [
            { name: "remote", transport: "http" as const, url: "https://mcp.example.com", headers: { Authorization: `Bearer ${token}` } },
            { name: "local", transport: "stdio" as const, command: "node", args: ["server.mjs"], env: { API_KEY: envSecret } },
          ], warnings: ["MCP needs-login requires authentication. Reconnect in Settings."] };
        }),
      }, { turn });
      expect(outcome.status).toBe("succeeded");
      expect(loads).toBe(1);
      const config = JSON.parse(sandboxes.state.files["/workspace/.factory/mcp.json"]!);
      expect(Object.keys(config.mcpServers).sort()).toEqual(["factory", "local", "remote"]);
      expect(config.mcpServers.remote.headers.Authorization).toBe(`Bearer ${token}`);
      expect(config.mcpServers.local.env.API_KEY).toBe(envSecret);
      expect(sandboxes.state.files["/workspace/.factory/codex-config"]).toContain('mcp_servers.remote={url="https://mcp.example.com"');
      for (const name of ["mcp.json", "codex-config"]) expect(sandboxes.state.modes[`/workspace/.factory/${name}`]).toBe(0o600);
      expect(Object.keys(sandboxes.state.files).some((path) => path.startsWith("/workspace/repo/"))).toBe(false);
      expect(events.join("\n")).not.toContain(token);
      expect(events.join("\n")).not.toContain(envSecret);
      expect(events).toContain("info:MCP needs-login requires authentication. Reconnect in Settings.");
    }));
  }

  describe("deployment recovery", () => {
    const done = (name: string, stdout = "") => ({ name, result: { exitCode: 0, stdout, timedOut: false } });
    const prepared: RunExecution = {
      checkout: "clone",
      sessions: { network: done("network"), checkout: done("checkout"), prepare: done("prepare") },
    };
    const recovery = (execution: RunExecution) => ({ ...run, recovering: true, sandbox_state: "running" as const, sandbox_id: "sbx_live", execution });

    it.effect("clones when a deploy interrupted setup before the first checkout", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({}, { alive: ["sbx_live"] });
        const turn = recovery({ checkout: "clone", sessions: { network: done("network") } });
        const { outcome } = yield* execute(sandboxes, recordingStore(), {}, { turn });
        expect(outcome.status).toBe("succeeded");
        expect(sandboxes.state.commands.some((c) => c.includes("git clone"))).toBe(true);
        expect(sandboxes.state.createdWith).toBeUndefined();
      }),
    );

    it.effect("keeps the frozen follow-up prompt after its delivery marker was saved", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({}, { alive: ["sbx_live"] });
        const turn = { ...recovery({ ...prepared, prompt: { text: "Also add the license", commitMessage: "Add license", deliveredMessageId: "5" } }), turns: 2, delivered_message_id: "5" };
        const { outcome } = yield* execute(sandboxes, recordingStore(), {}, { turn });
        expect(outcome.status).toBe("succeeded");
        expect(sandboxes.state.files["/workspace/TASK.md"]).toBe("Also add the license");
      }),
    );

    it.effect("reattaches to the saved agent without overwriting its task or restarting previews", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({ "run-agent": { stdout: "existing-mcp-secret" } }, { alive: ["sbx_live"] });
        const previousConfig = '{"mcpServers":{"existing":{"type":"http","url":"https://mcp.example.com"}}}';
        sandboxes.state.files["/workspace/.factory/mcp.json"] = previousConfig;
        const turn = recovery({ ...prepared, sessions: { ...prepared.sessions, agent: { name: "live-agent", startedAt: Date.now() } } });
        const { outcome, events } = yield* execute(sandboxes, recordingStore(), {
          preview,
          loadMcpServers: Effect.succeed({ servers: [{ name: "existing", transport: "http" as const, url: "https://mcp.example.com", headers: { Authorization: "Bearer existing-mcp-secret" } }], warnings: [] }),
        }, { turn });
        expect(outcome.status).toBe("succeeded");
        expect(sandboxes.state.attachments).toEqual(["live-agent"]);
        expect(sandboxes.state.files["/workspace/TASK.md"]).toBeUndefined();
        expect(sandboxes.state.files[PREVIEW_AGENT_FILE]).toBeUndefined();
        expect(sandboxes.state.commands.some((c) => c.includes("setup-agent"))).toBe(false);
        expect(sandboxes.state.files["/workspace/.factory/mcp.json"]).toBe(previousConfig);
        expect(events.join("\n")).not.toContain("existing-mcp-secret");
      }),
    );

    it.effect("continues publication after a deploy without running the agent or pushing twice", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({}, { alive: ["sbx_live"] });
        const turn = recovery({ ...prepared, sessions: { ...prepared.sessions, agent: done("agent"), publish: done("publish") } });
        const { outcome } = yield* execute(sandboxes, recordingStore(), {}, { turn });
        expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
        expect(sandboxes.state.commands.some((c) => c.includes("run-agent") || c.includes("git push"))).toBe(false);
      }),
    );

    it.effect("reattaches to a CI repair without repeating the initial agent, push or prompt", () =>
      Effect.gen(function* () {
        let head = "a".repeat(40);
        const sandboxes = fakeSandboxes({
          "\ngit rev-parse HEAD": Effect.sync(() => ({ stdout: head = "b".repeat(40) })),
        }, { alive: ["sbx_live"] });
        sandboxes.state.files["/workspace/TASK.md"] = "Fix the original CI failure";
        const turn = {
          ...recovery({
            ...prepared,
            ci: { cycle: 0, startedAt: 0, pullRequestUrl: PR, deliveredMessageId: "0" },
            sessions: {
              ...prepared.sessions,
              agent: done("agent"),
              publish: done("publish"),
              "ci:0:head": done("head", head),
              "ci:0:agent": { name: "live-ci-repair", startedAt: 0 },
            },
          }),
          pull_request_url: PR,
        };
        const { outcome } = yield* execute(sandboxes, recordingStore(), { preview }, {
          turn,
          prOpen: true,
          pullRequest: () => Effect.succeed(prState({ head: { sha: head } })),
          ciChecks: (sha) => Effect.succeed([{ name: "Tests", state: sha.startsWith("a") ? "failed" : "passed", url: null }]),
        });
        expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
        expect(sandboxes.state.attachments).toEqual(["live-ci-repair"]);
        expect(sandboxes.state.commands.filter((c) => c.includes("run-agent"))).toHaveLength(1);
        expect(sandboxes.state.commands.filter((c) => c.includes("git push"))).toHaveLength(1);
        expect(sandboxes.state.commands.filter((c) => c.endsWith("\ngit rev-parse HEAD"))).toHaveLength(1);
        expect(sandboxes.state.files["/workspace/TASK.md"]).toBe("Fix the original CI failure");
        expect(sandboxes.state.files[PREVIEW_AGENT_FILE]).toBeUndefined();
        expect(sandboxes.state.createdWith).toBeUndefined();
      }),
    );

    for (const publication of ["running", "completed"] as const) {
      it.effect(`settles a ${publication} CI publication before checking the previous green commit`, () =>
        Effect.gen(function* () {
          let head = "a".repeat(40);
          const sandboxes = fakeSandboxes({
            "\ngit rev-parse HEAD": Effect.sync(() => ({ stdout: head = "b".repeat(40) })),
          }, { alive: ["sbx_live"] });
          const turn = {
            ...recovery({
              ...prepared,
              ci: { cycle: 0, startedAt: 0, pullRequestUrl: PR, deliveredMessageId: "0" },
              sessions: {
                ...prepared.sessions,
                agent: done("agent"),
                publish: done("publish"),
                "ci:0:head": done("head", head),
                "ci:0:agent": done("ci-repair"),
                "ci:0:publish": publication === "running" ? { name: "ci-publish", startedAt: 0 } : done("ci-publish"),
              },
            }),
            pull_request_url: PR,
          };
          const { outcome, github } = yield* execute(sandboxes, recordingStore(), {}, {
            turn,
            prOpen: true,
            pullRequest: () => Effect.succeed(prState({ head: { sha: head } })),
            ciChecks: () => Effect.succeed([{ name: "Tests", state: "passed", url: null }]),
          });
          expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
          expect(sandboxes.state.attachments).toEqual(publication === "running" ? ["ci-publish"] : []);
          expect(sandboxes.state.commands.some((c) => c.includes("run-agent"))).toBe(false);
          expect(sandboxes.state.commands.filter((c) => c.includes("git push"))).toHaveLength(publication === "running" ? 1 : 0);
          expect(github.filter((call) => call[0] === "ciChecks")).toEqual([["ciChecks", "b".repeat(40)]]);
        }),
      );
    }

    for (const completion of ["merged", "passed"] as const) {
      it.effect(`stops a saved CI repair and requeues its messages when the PR ${completion} before reconnecting`, () =>
        Effect.gen(function* () {
          const sandboxes = fakeSandboxes({}, { alive: ["sbx_live"] });
          sandboxes.state.files["/workspace/TASK.md"] = "Fix the original CI failure";
          const store = withMessage();
          const turn = {
            ...recovery({
              ...prepared,
              ci: { cycle: 0, startedAt: 0, pullRequestUrl: PR, deliveredMessageId: "0" },
              sessions: {
                ...prepared.sessions,
                agent: done("agent"),
                publish: done("publish"),
                "ci:0:head": done("head", "a".repeat(40)),
                "ci:0:agent": { name: "live-ci-repair", startedAt: 0 },
              },
            }),
            pull_request_url: PR,
            delivered_message_id: "5",
          };
          const { outcome } = yield* execute(sandboxes, store, {}, {
            turn,
            prOpen: true,
            pullRequest: () => Effect.succeed(prState({ merged: completion === "merged" })),
            ciChecks: () => Effect.succeed([{ name: "Tests", state: completion === "passed" ? "passed" : "failed", url: null }]),
          });
          expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
          expect(sandboxes.state.stoppedSessions).toEqual(["live-ci-repair"]);
          expect(sandboxes.state.attachments).toEqual([]);
          expect(sandboxes.state.commands.some((c) => c.includes("run-agent") || c.includes("git push"))).toBe(false);
          expect(sandboxes.state.files["/workspace/TASK.md"]).toBe("Fix the original CI failure");
          expect(store.updates.filter((patch) => "delivered_message_id" in patch).at(-1)).toEqual({ delivered_message_id: "0" });
          expect(sandboxes.state.destroyed).toBe(false);
        }),
      );
    }

    it.effect("fails clearly when Railway no longer retains the saved command", () =>
      Effect.gen(function* () {
        const cause = new ExecInterruptedError({ closeCode: 1008, reason: "Session not found", stdout: "", stderr: "" });
        const sandboxes = fakeSandboxes({ "run-agent": Effect.fail(new SandboxError({ message: "Saved command session no longer exists", cause })) }, { alive: ["sbx_live"] });
        const turn = recovery({ ...prepared, sessions: { ...prepared.sessions, agent: { name: "lost-agent" } } });
        const { outcome } = yield* execute(sandboxes, recordingStore(), {}, { turn });
        expect(outcome).toEqual({ status: "failed", error: "Saved command session no longer exists" });
        expect(sandboxes.state.destroyed).toBe(false);
      }),
    );
  });

  it.effect("waits for pending CI and checks the published commit again", () =>
    Effect.gen(function* () {
      let polls = 0;
      const fiber = yield* Effect.fork(execute(fakeSandboxes(), recordingStore(), {}, {
        ciChecks: () => Effect.sync(() => [{ name: "CI", state: ++polls === 1 ? "pending" : "passed", url: null }]),
      }));
      yield* TestClock.adjust("14 seconds");
      expect(polls).toBe(1);
      expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true);
      yield* TestClock.adjust("1 second");
      const { outcome, github } = yield* Fiber.join(fiber);
      expect(outcome.status).toBe("succeeded");
      expect(github.filter((c) => c[0] === "ciChecks")).toEqual([["ciChecks", "a".repeat(40)], ["ciChecks", "a".repeat(40)]]);
    }),
  );

  it.effect("resumes the agent on CI failure, pushes the fix, and verifies the new commit", () =>
    Effect.gen(function* () {
      let heads = 0;
      let loads = 0;
      const seen: string[][] = [];
      const sandboxes = fakeSandboxes({
        "run-agent": Effect.sync(() => {
          seen.push(Object.keys(JSON.parse(sandboxes.state.files["/workspace/.factory/mcp.json"]!).mcpServers).sort());
          return {};
        }),
        "\ngit rev-parse HEAD": Effect.sync(() => ({ stdout: (++heads === 1 ? "a" : "b").repeat(40) })),
      });
      const { outcome, github } = yield* execute(sandboxes, recordingStore(), {
        loadMcpServers: Effect.sync(() => ({ servers: ++loads === 1
          ? [{ name: "removed", transport: "http" as const, url: "https://mcp.example.com", headers: {} }]
          : [{ name: "fresh", transport: "http" as const, url: "https://mcp.example.com", headers: { Authorization: "Bearer refreshed-token" } }], warnings: [] })),
      }, {
        ciChecks: (sha) => Effect.succeed([{ name: "Tests", state: sha.startsWith("a") ? "failed" : "passed", url: "https://github.com/shixzie/demo/actions/runs/1" }]),
        pullRequest: () => Effect.succeed(prState({ head: { sha: (heads === 1 ? "a" : "b").repeat(40) } })),
      });
      expect(outcome.status).toBe("succeeded");
      expect(github.filter((c) => c[0] === "ciChecks")).toEqual([["ciChecks", "a".repeat(40)], ["ciChecks", "a".repeat(40)], ["ciChecks", "b".repeat(40)]]);
      expect(sandboxes.state.commands.filter((c) => c.includes("git push"))).toHaveLength(2);
      const agents = sandboxes.state.commands.flatMap((c, i) => c.includes("run-agent") ? [i] : []);
      expect(agents).toHaveLength(2);
      expect(sandboxes.state.envs[agents[1]!]).toMatchObject({ FACTORY_CONTINUE: "1" });
      expect(sandboxes.state.files["/workspace/TASK.md"]).toContain("https://github.com/shixzie/demo/actions/runs/1");
      expect(loads).toBe(2);
      expect(seen).toEqual([["factory", "removed"], ["factory", "fresh"]]);
      expect(sandboxes.state.files["/workspace/.factory/mcp.json"]).toContain("Bearer refreshed-token");
    }),
  );

  it.effect("gives the initial agent and successive CI repairs distinct replay keys", () =>
    Effect.gen(function* () {
      let heads = 0;
      const message = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Checking the changes." }] } });
      const sandboxes = fakeSandboxes({
        "run-agent": { stdout: `${message}\n` },
        "\ngit rev-parse HEAD": Effect.sync(() => ({ stdout: String.fromCharCode(97 + heads++).repeat(40) })),
      });
      const store = recordingStore();
      const { outcome } = yield* execute(sandboxes, store, {}, {
        pullRequest: () => Effect.succeed(prState({ head: { sha: String.fromCharCode(96 + heads).repeat(40) } })),
        ciChecks: (sha) => Effect.succeed([{ name: "Tests", state: sha.startsWith("c") ? "passed" : "failed", url: null }]),
      });
      expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
      expect(sandboxes.state.commands.filter((c) => c.includes("git push"))).toHaveLength(3);
      const messages = store.events.filter((event) => event.kind === "message");
      expect(messages.map((event) => event.message)).toEqual(Array(3).fill("Checking the changes."));
      expect(messages.map((event) => event.data?._replayKey)).toEqual(["1:agent:0", "1:ci:0:agent:0", "1:ci:1:agent:0"]);
    }),
  );

  it.effect("refreshes the repaired PR before CI passes and then finishes without more agent work", () =>
    Effect.gen(function* () {
      let heads = 0;
      let descriptions = 0;
      let repairedPolls = 0;
      const sandboxes = fakeSandboxes({
        "\ngit rev-parse HEAD": Effect.sync(() => ({ stdout: (++heads === 1 ? "a" : "b").repeat(40) })),
        "describe-pr": Effect.sync(() => { descriptions++; return {}; }),
        "cat /workspace/.factory/pull-request.md": { stdout: "Fix the tests\n\nCorrect the failing behavior." },
      });
      const { outcome, events } = yield* execute(sandboxes, recordingStore(), { agent: { ...agent, describeCommand: "describe-pr" } }, {
        prOpen: true,
        pullRequest: () => Effect.succeed(prState({ head: { sha: (heads === 1 ? "a" : "b").repeat(40) } })),
        ciChecks: (sha) => Effect.sync(() => {
          if (sha.startsWith("a")) return [{ name: "Tests", state: "failed", url: null }];
          expect(descriptions).toBe(++repairedPolls === 1 ? 1 : 2);
          return [{ name: "Tests", state: repairedPolls < 3 ? "pending" : "passed", url: null }];
        }),
        turn: followUp({}),
      });
      expect(outcome.status).toBe("succeeded");
      expect(descriptions).toBe(2);
      expect(events.at(-1)).toBe(`info:CI passed for ${"b".repeat(40)}`);
      expect(sandboxes.state.commands.filter((c) => c.includes("run-agent"))).toHaveLength(2);
    }),
  );

  it.effect("does not start another description when the repaired commit is already green", () =>
    Effect.gen(function* () {
      let heads = 0;
      const sandboxes = fakeSandboxes({
        "\ngit rev-parse HEAD": Effect.sync(() => ({ stdout: (++heads === 1 ? "a" : "b").repeat(40) })),
        "cat /workspace/.factory/pull-request.md": { stdout: "Fix the tests\n\nCorrect the failing behavior." },
      });
      const { outcome, events } = yield* execute(sandboxes, recordingStore(), { agent: { ...agent, describeCommand: "describe-pr" } }, {
        pullRequest: () => Effect.succeed(prState({ head: { sha: (heads === 1 ? "a" : "b").repeat(40) } })),
        ciChecks: (sha) => Effect.succeed([{ name: "Tests", state: sha.startsWith("a") ? "failed" : "passed", url: null }]),
      });
      expect(outcome.status).toBe("succeeded");
      expect(sandboxes.state.commands.filter((c) => c.includes("describe-pr"))).toHaveLength(1);
      expect(events.at(-1)).toBe(`info:CI passed for ${"b".repeat(40)}`);
    }),
  );

  it.effect("interrupts a repaired PR description when its new commit becomes green", () =>
    Effect.gen(function* () {
      let heads = 0;
      let descriptions = 0;
      let complete = false;
      let interrupted = false;
      const sandboxes = fakeSandboxes({
        "\ngit rev-parse HEAD": Effect.sync(() => ({ stdout: (++heads === 1 ? "a" : "b").repeat(40) })),
        "describe-pr": Effect.suspend(() => ++descriptions === 1
          ? Effect.succeed({})
          : Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; })))),
        "cat /workspace/.factory/pull-request.md": { stdout: "Fix the tests\n\nCorrect the failing behavior." },
      });
      const fiber = yield* Effect.fork(execute(sandboxes, recordingStore(), { agent: { ...agent, describeCommand: "describe-pr" } }, {
        pullRequest: () => Effect.succeed(prState({ head: { sha: (heads === 1 ? "a" : "b").repeat(40) } })),
        ciChecks: (sha) => Effect.succeed([{ name: "Tests", state: sha.startsWith("a") ? "failed" : complete ? "passed" : "pending", url: null }]),
      }));
      yield* TestClock.adjust("14 seconds");
      expect(descriptions).toBe(2);
      complete = true;
      yield* TestClock.adjust("1 second");
      const { outcome, github } = yield* Fiber.join(fiber);
      expect(outcome.status).toBe("succeeded");
      expect(interrupted).toBe(true);
      expect(github.filter((c) => c[0] === "createPullRequest")).toHaveLength(1);
      expect(github.some((c) => c[0] === "updatePullRequest")).toBe(false);
    }),
  );

  it.effect("finishes when the current PR merges while CI is pending", () =>
    Effect.gen(function* () {
      let merged = false;
      const sandboxes = fakeSandboxes();
      const fiber = yield* Effect.fork(execute(sandboxes, recordingStore(), {}, {
        pullRequest: () => Effect.succeed(prState({ state: merged ? "closed" : "open", merged })),
        ciChecks: () => Effect.succeed([{ name: "Tests", state: "pending", url: null }]),
      }));
      yield* TestClock.adjust("14 seconds");
      expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true);
      merged = true;
      yield* TestClock.adjust("1 second");
      const { outcome, events, github } = yield* Fiber.join(fiber);
      expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
      expect(events).toContain(`info:Pull request merged: ${PR}`);
      expect(events.some((e) => e.includes("CI passed"))).toBe(false);
      expect(github.filter((c) => c[0] === "ciChecks")).toHaveLength(1);
      expect(sandboxes.state.commands.filter((c) => c.includes("run-agent"))).toHaveLength(1);
    }),
  );

  for (const completion of ["merged", "passed"] as const) {
    it.effect(`interrupts an automated CI repair when the published PR is ${completion}`, () =>
      Effect.gen(function* () {
        let complete = false;
        let turns = 0;
        let interrupted = false;
        const sandboxes = fakeSandboxes({
          "run-agent": Effect.suspend(() => ++turns === 1
            ? Effect.succeed({})
            : Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; })))),
        });
        const fiber = yield* Effect.fork(execute(sandboxes, recordingStore(), {}, {
          pullRequest: () => Effect.succeed(prState({ merged: complete && completion === "merged" })),
          ciChecks: () => Effect.succeed([{ name: "Tests", state: complete && completion === "passed" ? "passed" : "failed", url: null }]),
        }));
        yield* TestClock.adjust("14 seconds");
        expect(turns).toBe(2);
        expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true);
        complete = true;
        yield* TestClock.adjust("1 second");
        const { outcome, events } = yield* Fiber.join(fiber);
        expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
        expect(interrupted).toBe(true);
        expect(sandboxes.state.commands.filter((c) => c.includes("git push"))).toHaveLength(1);
        expect(events).toContain(completion === "merged" ? `info:Pull request merged: ${PR}` : `info:CI passed for ${"a".repeat(40)}`);
      }),
    );
  }

  it.effect("rechecks a finished repair before pushing when the PR merged between polls", () =>
    Effect.gen(function* () {
      let turns = 0;
      const sandboxes = fakeSandboxes({ "run-agent": Effect.sync(() => { turns++; return {}; }) });
      const { outcome } = yield* execute(sandboxes, recordingStore(), {}, {
        pullRequest: () => Effect.succeed(prState({ merged: turns === 2 })),
        ciChecks: () => Effect.succeed([{ name: "Tests", state: "failed", url: null }]),
      });
      expect(outcome.status).toBe("succeeded");
      expect(sandboxes.state.commands.filter((c) => c.includes("git push"))).toHaveLength(1);
    }),
  );

  it.effect("leaves user messages queued when CI completion interrupts their automated repair", () =>
    Effect.gen(function* () {
      let complete = false;
      let turns = 0;
      const store = recordingStore();
      const sandboxes = fakeSandboxes({ "run-agent": Effect.suspend(() => ++turns === 1 ? Effect.succeed({}) : Effect.never) });
      const fiber = yield* Effect.fork(execute(sandboxes, store, {}, {
        ciChecks: () => Effect.succeed([{ name: "Tests", state: complete ? "passed" : "failed", url: null }]),
      }));
      yield* TestClock.adjust("1 second");
      store.userMessages.push({ id: "5", run_id: run.id, at: new Date(0), kind: "user_message", message: "Also add a license", data: null });
      yield* TestClock.adjust("13 seconds");
      expect(store.updates).toContainEqual({ delivered_message_id: "5" });
      complete = true;
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(fiber)).outcome.status).toBe("succeeded");
      expect(store.updates.filter((patch) => "delivered_message_id" in patch)).toEqual([
        { delivered_message_id: "5" }, { delivered_message_id: "0" },
      ]);
      expect(sandboxes.state.commands.filter((c) => c.includes("git push"))).toHaveLength(1);
    }),
  );

  it.effect("does not treat a closed, unmerged PR or green checks on an outdated head as completion", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(execute(fakeSandboxes(), recordingStore(), {}, {
        pullRequest: () => Effect.succeed(prState({ state: "closed", head: { sha: "b".repeat(40) } })),
        ciChecks: () => Effect.succeed([{ name: "Tests", state: "passed", url: null }]),
      }));
      yield* TestClock.adjust("60 seconds");
      expect((yield* Fiber.join(fiber)).outcome).toMatchObject({ status: "failed", error: expect.stringContaining("CI has not been verified green") });
    }),
  );

  it.effect("fails honestly when CI is broken and the agent leaves no fixes", () =>
    Effect.gen(function* () {
      let pushes = 0;
      const sandboxes = fakeSandboxes({ "git push": Effect.sync(() => ({ stdout: ++pushes === 1 ? "" : UP_TO_DATE_MARKER })) });
      const { outcome } = yield* execute(sandboxes, recordingStore(), {}, {
        ciChecks: () => Effect.succeed([{ name: "Tests", state: "failed", url: null }]),
      });
      expect(outcome).toMatchObject({ status: "failed", error: expect.stringContaining("no fixes to push") });
    }),
  );

  it.effect("does not skip CI when a follow-up has no new changes", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes({ "git push": { stdout: UP_TO_DATE_MARKER } });
      const { outcome } = yield* execute(sandboxes, recordingStore(), {}, {
        turn: followUp({}), prOpen: true,
        ciChecks: () => Effect.succeed([{ name: "Tests", state: "failed", url: null }]),
      });
      expect(outcome.status).toBe("failed");
      expect(sandboxes.state.commands.filter((c) => c.includes("run-agent"))).toHaveLength(2);
    }),
  );

  it.effect("allows time for checks to appear before reporting no CI", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(execute(fakeSandboxes(), recordingStore(), { ciDiscoveryGrace: "60 seconds", agent: { ...agent, timeoutSec: 120 } }, {
        ciChecks: () => Effect.succeed([]),
      }));
      yield* TestClock.adjust("59 seconds");
      expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true);
      yield* TestClock.adjust("1 second");
      const { outcome, events } = yield* Fiber.join(fiber);
      expect(outcome.status).toBe("succeeded");
      expect(events.some((e) => e.includes("No CI checks were reported"))).toBe(true);
      expect(events.some((e) => e.includes("CI passed"))).toBe(false);
    }),
  );

  it.effect("can cancel a run while CI is pending", () =>
    Effect.gen(function* () {
      let cancelling = false;
      const store = recordingStore(() => cancelling ? "cancelling" : "running");
      const fiber = yield* Effect.fork(execute(fakeSandboxes(), store, {}, {
        ciChecks: () => Effect.sync(() => {
          cancelling = true;
          return [{ name: "Tests", state: "pending", url: null }];
        }),
      }));
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(fiber)).outcome.status).toBe("cancelled");
    }),
  );

  it.effect("refreshes installation credentials during a long CI wait", () =>
    Effect.gen(function* () {
      let polls = 0;
      const fiber = yield* Effect.fork(execute(fakeSandboxes(), recordingStore(), {
        agent: { ...agent, timeoutSec: 3600 }, ciPollEvery: "45 minutes", heartbeatEvery: "50 minutes",
      }, {
        ciChecks: () => Effect.sync(() => [{ name: "Tests", state: ++polls === 1 ? "pending" : "passed", url: null }]),
      }));
      yield* TestClock.adjust("45 minutes");
      const { outcome, github } = yield* Fiber.join(fiber);
      expect(outcome.status).toBe("succeeded");
      expect(github.filter((c) => c[0] === "installationToken")).toHaveLength(2);
    }),
  );

  it.effect("never marks unreadable CI as successful", () =>
    Effect.gen(function* () {
      const { outcome } = yield* execute(fakeSandboxes(), recordingStore(), {}, {
        ciChecks: () => Effect.fail(new GitHubError({ status: 403, message: "CI access denied" })),
      });
      expect(outcome).toEqual({ status: "failed", error: "CI access denied" });
    }),
  );

  it.effect("times out pending CI without reporting success", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(execute(fakeSandboxes(), recordingStore(), {}, {
        ciChecks: () => Effect.succeed([{ name: "Tests", state: "pending", url: null }]),
      }));
      yield* TestClock.adjust("60 seconds");
      const { outcome } = yield* Fiber.join(fiber);
      expect(outcome).toMatchObject({ status: "failed", error: expect.stringContaining("CI has not been verified green") });
    }),
  );

  it.effect("starts the sandbox's preview agent with this run's tunnel grant before the agent works", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes();
      const store = recordingStore();
      const { outcome } = yield* execute(sandboxes, store, { preview });
      expect(outcome.status).toBe("succeeded");

      const { files, modes, commands } = sandboxes.state;
      expect(files[PREVIEW_AGENT_FILE]).toBe(PREVIEW_AGENT_SCRIPT);
      expect(modes[PREVIEW_TOKEN_FILE]).toBe(0o600);
      expect(verifyPreviewGrant(PREVIEW_KEY, files[PREVIEW_TOKEN_FILE], "tunnel")?.run).toBe(run.id);
      const launch = commands.findIndex((c) => c.includes(`nohup node ${PREVIEW_AGENT_FILE}`));
      expect(launch).toBeGreaterThan(-1);
      expect(commands[launch]).toContain("FACTORY_PREVIEW_URL='wss://tunnel.preview.example/connect'");
      expect(launch).toBeLessThan(commands.findIndex((c) => c.includes("run-agent")));
    }),
  );

  it.effect("carries on without previews when the preview agent can't start, and without them when they are off", () =>
    Effect.gen(function* () {
      const broken = fakeSandboxes({ "nohup node": { exitCode: 127 } });
      const store = recordingStore();
      const { outcome, events } = yield* execute(broken, store, { preview });
      expect(outcome.status).toBe("succeeded");
      expect(events).toContain("info:Previews are unavailable this turn: the preview agent exited with 127");

      const off = fakeSandboxes();
      yield* execute(off);
      expect(off.state.commands.some((c) => c.includes("preview-agent"))).toBe(false);
      expect(off.state.files[PREVIEW_TOKEN_FILE]).toBeUndefined();
    }),
  );

  it.effect("passes saved model and effort to the agent on initial and later turns", () =>
    Effect.gen(function* () {
      for (const turn of [
        { ...run, model: "custom-model", reasoning_effort: "high" as const },
        followUp({ model: "custom-model", reasoning_effort: "high" }),
      ]) {
        const sandboxes = fakeSandboxes();
        yield* execute(sandboxes, withMessage(), {}, { turn });
        const agentIndex = sandboxes.state.commands.findIndex((c) => c.includes("run-agent"));
        expect(sandboxes.state.envs[agentIndex]).toMatchObject({
          FACTORY_MODEL: "custom-model",
          FACTORY_REASONING_EFFORT: "high",
          FACTORY_CODEX_EFFORT: 'model_reasoning_effort="high"',
        });
      }
    }),
  );

  it.effect("runs the agent, pushes and opens a PR, and keeps the sandbox for the next turn", () =>
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
          permissions: { contents: "write", pull_requests: "write", metadata: "read", checks: "read", statuses: "read", actions: "read", workflows: "write" },
        },
      ]);
      expect(sandboxes.state.createdWith).toEqual({ ANTHROPIC_API_KEY: "sk-ant-user-key", IS_SANDBOX: "1" });
      // The token goes in a file each turn (it expires), readable only by its owner.
      expect(sandboxes.state.files[TOKEN_FILE]).toBe("ghs_repo_token");
      expect(sandboxes.state.modes[TOKEN_FILE]).toBe(0o600);
      expect(github[1]).toEqual([
        "createPullRequest",
        "ghs_repo_token",
        "shixzie/demo",
        expect.objectContaining({ title: "Add a README", head: "factory/run-0123abcd", base: "main" }),
      ]);
      expect(sandboxes.state.commands.every((c) => c.startsWith('export HOME="${HOME:-/root}"\n'))).toBe(true);
      expect(sandboxes.state.commands[0]).toContain(`export GH_TOKEN="$(cat ${TOKEN_FILE})"`);
      expect(firstLines(sandboxes.state.commands)).toEqual([
        expect.stringMatching(/^for i in/),
        "set -eu",
        "setup-agent",
        "run-agent",
        "set -eu",
        "set -eu",
        "git rev-parse HEAD",
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
      expect(sandboxes.state.envs[3]).not.toHaveProperty("FACTORY_CONTINUE");
      expect(sandboxes.state.files["/workspace/TASK.md"]).toBe(run.task);
      expect(store.updates.map((patch) => { const { execution, ...rest } = patch as Record<string, unknown>; return rest; }).filter((patch) => Object.keys(patch).length > 0)).toEqual([
        {
          sandbox_id: "sbx_1",
          branch: "factory/run-0123abcd",
          sandbox_state: "running",
          sandbox_checkpoint_id: null,
          sandbox_checkpoint_name: null,
        },
        { pull_request_url: PR },
      ]);
      expect(sandboxes.state.destroyed).toBe(false);
    }),
  );

  it.effect("succeeds without a PR when the agent changed nothing", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes({ "git push": { stdout: `${NO_CHANGES_MARKER}\n` } });
      const { outcome, github } = yield* execute(sandboxes);
      expect(outcome).toEqual({ status: "succeeded" });
      expect(github.map((c) => c[0])).toEqual(["installationToken"]);
      expect(sandboxes.state.destroyed).toBe(false);
    }),
  );

  it.effect("fails when the agent exits non-zero, and keeps the sandbox so a message can carry on", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes({ "run-agent": { exitCode: 2 } });
      const { outcome, events } = yield* execute(sandboxes);
      expect(outcome).toEqual({ status: "failed", error: "Running the agent: exited with code 2" });
      expect(events.at(-1)).toBe("error:Running the agent: exited with code 2");
      expect(sandboxes.state.destroyed).toBe(false);
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
      const { outcome, events } = yield* execute(sandboxes);
      expect(outcome).toEqual({
        status: "failed",
        error:
          "Checking the sandbox can reach GitHub: the Railway sandbox has no outbound network (it started in Railway's recovery console). Try the run again.",
      });
      expect(sandboxes.state.commands).toHaveLength(1);
      // It never got a checkout, so it is no use to a later turn.
      expect(sandboxes.state.destroyed).toBe(true);
      expect(events.at(-1)).toBe("info:Sandbox destroyed");
    }),
  );

  it.effect("runs without workflow access when the App was never granted it", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes();
      const store = recordingStore();
      const { outcome, github, events } = yield* execute(sandboxes, store, {}, {
        grantedPermissions: ["contents", "pull_requests", "metadata", "checks", "statuses", "actions"],
      });
      expect(outcome.status).toBe("succeeded");
      expect(github.filter((c) => c[0] === "installationToken").map((c) => Object.keys((c[2] as { permissions: object }).permissions))).toEqual([
        ["contents", "pull_requests", "metadata", "checks", "statuses", "actions", "workflows"],
        ["contents", "pull_requests", "metadata", "checks", "statuses", "actions"],
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
      // Kept, so a message retries the push once the App has the permission.
      expect(sandboxes.state.destroyed).toBe(false);
    }),
  );

  it.effect("fails cleanly when no sandbox can be created", () =>
    Effect.gen(function* () {
      const { outcome } = yield* execute(fakeSandboxes({}, { failCreate: "sandbox limit reached" }));
      expect(outcome).toEqual({ status: "failed", error: "sandbox limit reached" });
    }),
  );

  it.live("stops the agent when the run is cancelled, and keeps the sandbox", () =>
    Effect.gen(function* () {
      const sandboxes = fakeSandboxes({}, { hang: "run-agent" });
      // Report cancellation once the agent is running.
      const store = recordingStore(() => (sandboxes.state.commands.some((c) => c.includes("run-agent")) ? "cancelling" : "running"));
      const { outcome, events } = yield* execute(sandboxes, store, { heartbeatEvery: "5 millis" });

      expect(outcome).toEqual({ status: "cancelled" });
      expect(sandboxes.state.killed).toBe(true);
      expect(sandboxes.state.commands).not.toContainEqual(expect.stringContaining("git push"));
      expect(sandboxes.state.destroyed).toBe(false);
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
      expect(store.events.find((e) => e.kind === "tool_call")!.data).toMatchObject({ id: "t1", name: "Write", input: { file_path: "README.md", content: "# Hi" } });
      expect(store.diffs).toEqual([{ patch, truncated: false }]);
    }),
  );

  it.live("reads Codex's JSON events when the run uses Codex, questions included", () =>
    Effect.gen(function* () {
      const line = (m: object) => `${JSON.stringify(m)}\n`;
      const ask = { id: "m1", type: "mcp_tool_call", server: "factory", tool: "ask_user", arguments: { question: "Which?" }, result: null, error: null };
      const sandboxes = fakeSandboxes({
        "run-codex": (onOutput) =>
          Effect.gen(function* () {
            onOutput("stdout", line({ type: "thread.started", thread_id: "th_1" }) + line({ type: "turn.started" }));
            onOutput("stdout", line({ type: "item.started", item: { ...ask, status: "in_progress" } }));
            yield* Effect.sleep("150 millis");
            onOutput(
              "stdout",
              line({ type: "item.completed", item: { ...ask, status: "completed", result: { content: [{ type: "text", text: "The user answered: A" }] } } }) +
                line({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "Went with A." } }) +
                line({ type: "turn.completed", usage: {} }),
            );
            yield* Effect.sleep("50 millis");
            return {};
          }),
      });
      const store = recordingStore();
      const { events } = yield* execute(sandboxes, store, {
        agent: { ...agent, id: "codex", setupCommand: "setup-codex", command: "run-codex" },
        inboxEvery: "10 millis",
        diffEvery: "10 millis",
      });
      expect(events).toEqual(
        expect.arrayContaining([
          "info:Agent started (Codex)",
          `tool_call:${ASK_USER_TOOL}`,
          "tool_result:The user answered: A",
          "message:Went with A.",
          "agent_result:Went with A.",
        ]),
      );
      expect(store.updates.filter((u) => "awaiting_input" in u)).toEqual([{ awaiting_input: true }, { awaiting_input: false }]);
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

  describe("a later turn", () => {
    it.effect("continues the agent's session in the sandbox the last turn left running", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({ "git remote set-url": { stdout: `${HAS_SESSION_MARKER}\n` } }, { alive: ["sbx_live"] });
        const store = withMessage();
        const turn = followUp({ sandbox_state: "running", sandbox_id: "sbx_live", delivered_message_id: "3" });
        const { outcome, events, github } = yield* execute(sandboxes, store, {}, { turn, prOpen: true });

        expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
        expect(sandboxes.state.createdWith).toBeUndefined();
        expect(firstLines(sandboxes.state.commands)).toEqual([
          expect.stringMatching(/^for i in/),
          "set -eu",
          "setup-agent",
          "run-agent",
          "set -eu",
          "set -eu",
          "git rev-parse HEAD",
        ]);
        expect(sandboxes.state.commands[1]).toContain("git remote set-url origin https://github.com/shixzie/demo.git");
        expect(sandboxes.state.commands[1]).not.toContain("git clone");
        expect(sandboxes.state.envs[3]).toMatchObject({ FACTORY_CONTINUE: "1" });
        // The agent remembers the task; it only needs what the user said since.
        expect(sandboxes.state.files["/workspace/TASK.md"]).toBe("Also add a license");
        expect(sandboxes.state.files["/workspace/COMMIT_MSG"]).toMatch(/^Also add a license\n/);
        expect(store.updates).toContainEqual({ delivered_message_id: "5" });
        // The PR from the first turn is still open, so the push lands there.
        expect(github.map((c) => c[0])).toEqual(["installationToken", "createPullRequest", "findOpenPullRequest", "pullRequest", "ciChecks"]);
        expect(events).toContain(`info:Pushed the changes to ${PR}`);
        expect(store.updates).not.toContainEqual({ pull_request_url: expect.anything() });
        expect(sandboxes.state.destroyed).toBe(false);
      }),
    );

    it.effect("boots a stopped sandbox from its checkpoint, then deletes the checkpoint", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({ "git push": { stdout: `${UP_TO_DATE_MARKER}\n` } }, { checkpoints: { cp_9: "run-x" } });
        const turn = followUp({ sandbox_state: "stopped", sandbox_id: "sbx_old", sandbox_checkpoint_id: "cp_9", sandbox_checkpoint_name: "run-x" });
        const store = withMessage();
        const { outcome, events, github } = yield* execute(sandboxes, store, {}, { turn });

        expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
        expect(sandboxes.state.restoredFrom).toBe("run-x");
        expect(sandboxes.state.createdWith).toEqual({ ANTHROPIC_API_KEY: "sk-ant-user-key", IS_SANDBOX: "1" });
        expect(sandboxes.state.deletedCheckpoints).toEqual(["cp_9"]);
        expect(store.updates[0]).toMatchObject({ sandbox_id: "sbx_restored", sandbox_state: "running", sandbox_checkpoint_id: null });
        expect(events).toContain("info:No new changes this turn");
        expect(github.map((c) => c[0])).toEqual(["installationToken", "createPullRequest", "pullRequest", "ciChecks"]);
        // No session to continue (the agent never ran here), so it gets the whole story.
        expect(sandboxes.state.envs[3]).not.toHaveProperty("FACTORY_CONTINUE");
        const task = sandboxes.state.files["/workspace/TASK.md"]!;
        expect(task).toContain("Add a README");
        expect(task).toContain("Also add a license");
      }),
    );

    it.effect("starts a new sandbox from the pushed branch when the old one can't come back", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({}, { failRestore: "checkpoint not found" });
        const turn = followUp({ sandbox_state: "stopped", sandbox_checkpoint_id: "cp_9", sandbox_checkpoint_name: "run-x" });
        const { outcome, events } = yield* execute(sandboxes, withMessage(), {}, { turn, prOpen: true });

        expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
        expect(events).toContain("info:checkpoint not found. Starting a new sandbox from the branch instead");
        expect(events).toContain("info:Cloning shixzie/demo@factory/run-0123abcd");
        expect(sandboxes.state.commands[1]).toContain("git fetch -q --depth 50 origin 'refs/heads/factory/run-0123abcd");
        expect(sandboxes.state.deletedCheckpoints).toEqual(["cp_9"]);
      }),
    );

    it.effect("starts a new sandbox when the running one is gone", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes();
        const turn = followUp({ sandbox_state: "running", sandbox_id: "sbx_gone" });
        const { events } = yield* execute(sandboxes, withMessage(), {}, { turn, prOpen: true });
        expect(events).toContain("info:The sandbox from the last turn is gone, so this turn starts a new one");
        expect(sandboxes.state.createdWith).toBeDefined();
      }),
    );

    it.effect("opens a new PR when the earlier one was merged", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({}, { alive: ["sbx_live"] });
        const store = recordingStore();
        const turn = followUp({ sandbox_state: "running", sandbox_id: "sbx_live", pull_request_url: "https://github.com/shixzie/demo/pull/0" });
        const { outcome, events } = yield* execute(sandboxes, withMessage(store), {}, { turn });
        expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
        expect(events).toContain(`info:Opened ${PR}`);
        expect(store.updates).toContainEqual({ pull_request_url: PR });
      }),
    );
  });

  describe("the pull request text", () => {
    const describing = { agent: { ...agent, describeCommand: "describe-pr" } };
    const READ_REPLY = "cat /workspace/.factory/pull-request.md";
    const reply = "# Add a README with a heading\n\nThe repo had no README.\n\n## Changes\n- README.md: title and one paragraph\n";

    it.effect("is written by the agent after the push, from its session and the final diff", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({ [READ_REPLY]: { stdout: reply } });
        const { outcome, github, events } = yield* execute(sandboxes, recordingStore(), describing);

        expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
        const lines = firstLines(sandboxes.state.commands);
        // After the push (the last "set -eu"), before the PR.
        expect(lines.slice(-4, -1)).toEqual(["set -eu", "rm -f /workspace/.factory/pull-request.md", READ_REPLY]);
        expect(sandboxes.state.commands.at(-3)).toContain("\ndescribe-pr");
        expect(sandboxes.state.envs.at(-3)).toEqual({
          FACTORY_MODEL: "",
          FACTORY_REASONING_EFFORT: "",
          FACTORY_CODEX_EFFORT: "",
          FACTORY_DESCRIBE_FILE: "/workspace/.factory/describe-prompt.md",
          FACTORY_PR_FILE: "/workspace/.factory/pull-request.md",
        });
        expect(sandboxes.state.files["/workspace/.factory/describe-prompt.md"]).toContain("git diff 'origin/main'...HEAD");
        expect(events).toContain("info:Writing the pull request description");
        const [, , , pr] = github[1] as [string, string, string, { title: string; body: string }];
        expect(pr.title).toBe("Add a README with a heading");
        expect(pr.body).toMatch(/^The repo had no README\.\n\n## Changes\n- README\.md: title and one paragraph\n\n---\n/);
        expect(pr.body).toContain("<details><summary>Task</summary>\n\nAdd a README\n\nWith a heading.\n\n</details>");
      }),
    );

    it.effect("falls back to the task when the agent can't write it", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({ "describe-pr": { exitCode: 1 } });
        const { outcome, github, events } = yield* execute(sandboxes, recordingStore(), describing);

        expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
        expect(events).toContain(
          "info:Could not write the pull request description (Writing the pull request description: exited with code 1), so the PR is titled after the task",
        );
        expect(github[1]).toEqual([
          "createPullRequest",
          "ghs_repo_token",
          "shixzie/demo",
          expect.objectContaining({ title: "Add a README", body: expect.stringContaining("### Task") }),
        ]);
      }),
    );

    it.effect("falls back to the task when the reply is empty, and never leaks a key into it", () =>
      Effect.gen(function* () {
        const empty = fakeSandboxes({ [READ_REPLY]: { stdout: "\n" } });
        const first = yield* execute(empty, recordingStore(), describing);
        expect(first.events).toContain("info:Could not write the pull request description (the agent's reply had no title), so the PR is titled after the task");

        const leaky = fakeSandboxes({ [READ_REPLY]: { stdout: `Add a README\n\nUsed sk-ant-user-key to test.` } });
        const second = yield* execute(leaky, recordingStore(), describing);
        const [, , , pr] = second.github[1] as [string, string, string, { body: string }];
        expect(pr.body).not.toContain("sk-ant-user-key");
      }),
    );

    it.effect("replaces the open PR's title and description on a later turn", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({ [READ_REPLY]: { stdout: reply } }, { alive: ["sbx_live"] });
        const turn = followUp({ sandbox_state: "running", sandbox_id: "sbx_live" });
        const { outcome, github, events } = yield* execute(sandboxes, withMessage(), describing, { turn, prOpen: true });

        expect(outcome).toEqual({ status: "succeeded", pullRequestUrl: PR });
        expect(sandboxes.state.files["/workspace/.factory/describe-prompt.md"]).toContain("already has a pull request");
        expect(github.map((c) => c[0])).toEqual(["installationToken", "createPullRequest", "findOpenPullRequest", "updatePullRequest", "pullRequest", "ciChecks"]);
        expect(github[3]).toEqual([
          "updatePullRequest",
          "ghs_repo_token",
          "shixzie/demo",
          1,
          { title: "Add a README with a heading", body: expect.stringMatching(/^The repo had no README\./) },
        ]);
        expect(events).toContain(`info:Pushed the changes to ${PR} and updated its description`);
      }),
    );

    it.effect("isn't asked for when nothing was pushed", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({ "git push": { stdout: `${NO_CHANGES_MARKER}\n` } });
        yield* execute(sandboxes, recordingStore(), describing);
        expect(sandboxes.state.commands.some((c) => c.includes("describe-pr"))).toBe(false);
      }),
    );
  });
});
