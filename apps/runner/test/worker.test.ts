import { SqlClient } from "@effect/sql";
import { encrypt, Store, TokenCipher, type RunRow } from "@factory/core";
import { describe, expect, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option, Redacted, Schedule } from "effect";
import { randomBytes } from "node:crypto";
import { TestDbLive, testDatabaseUrl } from "../../../packages/core/test/db.js";
import { RunnerConfig } from "../src/config.js";
import { HAS_SESSION_MARKER } from "../src/plan.js";
import { deleteExpiredRuns, keepPreviewedSandboxesAlive, runner } from "../src/worker.js";
import { fakeGitHub, fakeSandboxes } from "./stubs.js";

const key = randomBytes(32);
const API_KEY = "sk-ant-api03-worker-test-key";

const settings = {
  harnessUrl: Option.some("https://factory.example"),
  workerId: "test-runner",
  maxConcurrentRuns: 2,
  pollInterval: Duration.millis(50),
  staleRunSeconds: 180,
  heartbeatInterval: Duration.millis(20),
  sandboxIdleStop: Duration.minutes(5),
  runRetentionDays: 7,
  lifecycleInterval: Duration.millis(50),
  agent: {
    commands: {
      claude: { setupCommand: "setup-agent", command: "run-agent" },
      codex: { setupCommand: "setup-codex", command: "run-codex" },
    },
    timeoutSec: 60,
    passthroughEnv: {},
  },
  snapshots: [{ name: "shixzie-agents", logins: ["shixzie"] }],
  git: { authorName: "A", authorEmail: "a@x" },
  preview: Option.some({ tunnelUrl: "wss://tunnel.preview.example/connect", signingKey: Redacted.make("s".repeat(40)) }),
};
const config = Layer.succeed(RunnerConfig, settings);

const Base = Layer.mergeAll(Store.Live, Layer.succeed(TokenCipher, TokenCipher.fromKey(key)), config).pipe(
  Layer.provideMerge(TestDbLive),
);

/** Queues a run for a user who has saved an Anthropic API key (or the given keys), with the given agent and snapshot. */
const queueRunWith = ({
  agent,
  keys = { anthropic: API_KEY },
  snapshot = null,
}: { agent?: string; keys?: Record<string, string>; snapshot?: string | null } = {}) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const user = yield* store.upsertUser({
      github_id: 7,
      github_login: "shixzie",
      name: null,
      avatar_url: null,
      access_token_enc: "x",
      access_token_expires_at: null,
      refresh_token_enc: null,
      refresh_token_expires_at: null,
    });
    yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`delete from user_api_keys where user_id = ${user.id}`);
    for (const [provider, value] of Object.entries(keys)) {
      yield* store.upsertApiKey({ user_id: user.id, provider, key_enc: encrypt(value, key), hint: value.slice(-4) });
    }
    yield* store.setSandboxSnapshot(user.id, snapshot);
    return yield* store.enqueueRun({
      user_id: user.id,
      repo_full_name: "shixzie/demo",
      installation_id: 42,
      base_branch: "main",
      task: "Add a README",
      agent,
    });
  });

const queueRun = queueRunWith();

const waitForRun = (id: string, done: (run: RunRow) => boolean) =>
  Effect.flatMap(Store, (store) => store.getRun(id)).pipe(
    Effect.map(Option.getOrThrow),
    Effect.repeat(
      Schedule.spaced("20 millis").pipe(
        Schedule.whileInput((run: RunRow) => !done(run)),
        Schedule.passthrough,
      ),
    ),
    Effect.timeout("5 seconds"),
  );

const events = (runId: string) =>
  Effect.flatMap(Store, (store) => store.listEvents(runId, 0)).pipe(Effect.map((rows) => rows.map((e) => e.message)));

describe.skipIf(!testDatabaseUrl)("runner", () => {
  layer(Base, { timeout: 30_000, excludeTestServices: true })((it) => {
    it.effect("claims a queued run, opens the PR with the user's key, and redacts it", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({ "run-agent": { stdout: `using ${API_KEY}` } });
        const worker = yield* runner.pipe(Effect.provide(Layer.merge(sandboxes.layer, fakeGitHub())), Effect.fork);
        const run = yield* queueRun;

        const finished = yield* waitForRun(run.id, (r) => r.status === "succeeded");
        yield* Fiber.interrupt(worker);

        expect(finished.pull_request_url).toBe("https://github.com/shixzie/demo/pull/1");
        expect(finished.claimed_by).toBe("test-runner");
        expect(sandboxes.state.createdWith?.ANTHROPIC_API_KEY).toBe(API_KEY);
        expect(finished).toMatchObject({ sandbox_state: "running", sandbox_id: "sbx_1", turns: 1 });
        expect(sandboxes.state.destroyed).toBe(false);
        const log = (yield* events(run.id)).join("\n");
        expect(log).not.toContain(API_KEY);
        expect(log).not.toContain("ghs_repo_token");
      }),
    );

    it.effect("runs Codex with only the OpenAI key", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes();
        const worker = yield* runner.pipe(Effect.provide(Layer.merge(sandboxes.layer, fakeGitHub())), Effect.fork);
        const run = yield* queueRunWith({ agent: "codex", keys: { anthropic: API_KEY, openai: "sk-proj-worker-test-key-0000" } });

        yield* waitForRun(run.id, (r) => r.status === "succeeded");
        yield* Fiber.interrupt(worker);

        expect(sandboxes.state.commands).toContainEqual(expect.stringContaining("setup-codex"));
        expect(sandboxes.state.commands).toContainEqual(expect.stringContaining("run-codex"));
        expect(sandboxes.state.commands.some((c) => c.includes("run-agent"))).toBe(false);
        expect(sandboxes.state.createdWith?.CODEX_API_KEY).toBe("sk-proj-worker-test-key-0000");
        expect(sandboxes.state.createdWith?.ANTHROPIC_API_KEY).toBeUndefined();
      }),
    );

    it.effect("prefers a Claude subscription token over an API key, and passes only the token", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes();
        const worker = yield* runner.pipe(Effect.provide(Layer.merge(sandboxes.layer, fakeGitHub())), Effect.fork);
        const token = "sk-ant-oat01-worker-test-token";
        const run = yield* queueRunWith({ keys: { anthropic: API_KEY, claude_oauth: token } });

        yield* waitForRun(run.id, (r) => r.status === "succeeded");
        yield* Fiber.interrupt(worker);

        expect(sandboxes.state.createdWith?.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
        expect(sandboxes.state.createdWith?.ANTHROPIC_API_KEY).toBeUndefined();
      }),
    );

    it.effect("starts from the user's snapshot, which can stand in for a key", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes();
        const worker = yield* runner.pipe(Effect.provide(Layer.merge(sandboxes.layer, fakeGitHub())), Effect.fork);
        const run = yield* queueRunWith({ keys: {}, snapshot: "shixzie-agents" });

        yield* waitForRun(run.id, (r) => r.status === "succeeded");
        yield* Fiber.interrupt(worker);

        expect(sandboxes.state.createdFrom).toBe("shixzie-agents");
        expect(sandboxes.state.createdWith?.ANTHROPIC_API_KEY).toBeUndefined();
        const log = yield* events(run.id);
        expect(log).toContain("Creating Railway sandbox from snapshot shixzie-agents");
      }),
    );

    it.effect("refuses a snapshot the user may no longer use, and a run with no key", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes();
        const worker = yield* runner.pipe(Effect.provide(Layer.merge(sandboxes.layer, fakeGitHub())), Effect.fork);
        const revoked = yield* queueRunWith({ snapshot: "someone-else" });
        const a = yield* waitForRun(revoked.id, (r) => r.status === "failed");
        const keyless = yield* queueRunWith({ agent: "codex" });
        const b = yield* waitForRun(keyless.id, (r) => r.status === "failed");
        yield* Fiber.interrupt(worker);

        expect(a.error).toMatch(/snapshot someone-else is no longer available/);
        expect(b.error).toMatch(/No usable key for Codex/);
        expect(sandboxes.state.commands).toEqual([]);
      }),
    );

    it.effect("stops the agent when the user cancels", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({}, { hang: "run-agent" });
        const worker = yield* runner.pipe(Effect.provide(Layer.merge(sandboxes.layer, fakeGitHub())), Effect.fork);
        const run = yield* queueRun;
        yield* waitForRun(run.id, () => sandboxes.state.commands.some((c) => c.includes("run-agent")));

        yield* Effect.flatMap(Store, (store) => store.requestCancel(run.id, run.user_id));
        const finished = yield* waitForRun(run.id, (r) => r.status === "cancelled");
        yield* Fiber.interrupt(worker);

        expect(finished.status).toBe("cancelled");
        expect(sandboxes.state.killed).toBe(true);
        expect(sandboxes.state.destroyed).toBe(false);
      }),
    );

    it.effect("fails in-flight runs and keeps their sandboxes when the runner stops", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({}, { hang: "run-agent" });
        const worker = yield* runner.pipe(Effect.provide(Layer.merge(sandboxes.layer, fakeGitHub())), Effect.fork);
        const run = yield* queueRun;
        yield* waitForRun(run.id, () => sandboxes.state.commands.some((c) => c.includes("run-agent")));

        yield* Fiber.interrupt(worker);
        const [row] = yield* Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ status: string; error: string }>`select status, error from runs where id = ${run.id}`,
        );
        expect(row).toEqual({
          status: "failed",
          error: "The runner stopped before this run finished. Send a message to pick it up again.",
        });
        expect(sandboxes.state.killed).toBe(true);
        expect(sandboxes.state.destroyed).toBe(false);
      }),
    );

    it.effect("stops an idle sandbox with a checkpoint, and resumes it from there on the next message", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        // Earlier tests left sandboxes "running"; they would be stopped too.
        yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`update runs set sandbox_state = 'deleted'`);
        // The restored disk remembers that the agent ran, so it continues its session.
        const sandboxes = fakeSandboxes({ "git remote set-url": { stdout: `${HAS_SESSION_MARKER}\n` } });
        const worker = yield* runner.pipe(
          // Idle straight away, so the test doesn't wait five minutes.
          Effect.provide(Layer.mergeAll(sandboxes.layer, fakeGitHub(), Layer.succeed(RunnerConfig, { ...settings, sandboxIdleStop: Duration.zero }))),
          Effect.fork,
        );
        const run = yield* queueRun;

        const stopped = yield* waitForRun(run.id, (r) => r.status === "succeeded" && r.sandbox_state === "stopped");
        expect(stopped.sandbox_checkpoint_id).toBe("cp_1");
        expect(stopped.sandbox_checkpoint_name).toMatch(new RegExp(`^run-${run.id}-`));
        expect(sandboxes.state.destroyedIds).toEqual(["sbx_1"]);
        // The token file is removed before the disk is saved.
        expect(sandboxes.state.commands.at(-1)).toContain("rm -f /workspace/.factory/gh-token");

        yield* store.continueRun(run.id, "Now add a license");
        const resumed = yield* waitForRun(run.id, (r) => r.status === "succeeded" && r.turns === 2);
        yield* Fiber.interrupt(worker);

        expect(sandboxes.state.restoredFrom).toBe(stopped.sandbox_checkpoint_name);
        expect(sandboxes.state.deletedCheckpoints).toContain("cp_1");
        expect(sandboxes.state.files["/workspace/TASK.md"]).toBe("Now add a license");
        expect(sandboxes.state.envs.findLast((e) => e?.FACTORY_RUN_ID)?.FACTORY_CONTINUE).toBe("1");
        expect(resumed.delivered_message_id).not.toBe("0");
        expect(resumed.pull_request_url).toBe("https://github.com/shixzie/demo/pull/1");
      }),
    );

    it.effect("keeps a sandbox someone is previewing awake, without asking Railway every tick", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sandboxes = fakeSandboxes({}, { alive: ["sbx_previewed", "sbx_quiet"] });
        const previewed = yield* queueRun;
        const quiet = yield* queueRun;
        yield* sql`
          update runs set status = 'succeeded', sandbox_state = 'running', sandbox_id = 'sbx_previewed', preview_seen_at = now()
          where id = ${previewed.id}`;
        yield* sql`
          update runs set status = 'succeeded', sandbox_state = 'running', sandbox_id = 'sbx_quiet',
            preview_seen_at = now() - interval '1 hour'
          where id = ${quiet.id}`;

        const last = new Map<string, number>();
        yield* keepPreviewedSandboxesAlive(last, 1_000_000).pipe(Effect.provide(sandboxes.layer));
        yield* keepPreviewedSandboxesAlive(last, 1_000_000 + 60_000).pipe(Effect.provide(sandboxes.layer));
        expect(sandboxes.state.commands).toEqual(["true"]);
        yield* keepPreviewedSandboxesAlive(last, 1_000_000 + 6 * 60_000).pipe(Effect.provide(sandboxes.layer));
        expect(sandboxes.state.commands).toEqual(["true", "true"]);
        yield* sql`update runs set sandbox_state = 'deleted' where id in (${previewed.id}, ${quiet.id})`;
      }),
    );

    it.effect("deletes runs untouched for a week, with their checkpoint, and keeps the rest", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Store;
        const sandboxes = fakeSandboxes({}, { checkpoints: { cp_old: "run-old" } });
        const old = yield* queueRun;
        const recent = yield* queueRun;
        yield* store.appendEvents(old.id, [{ kind: "info", message: "hello" }]);
        yield* store.saveDiff(old.id, "diff --git a/x b/x\n", false);
        yield* sql`
          update runs set status = 'succeeded', sandbox_state = 'stopped', sandbox_checkpoint_id = 'cp_old',
            last_activity_at = now() - interval '8 days'
          where id = ${old.id}`;
        yield* sql`
          update runs set status = 'succeeded', sandbox_state = 'stopped', sandbox_checkpoint_id = 'cp_recent',
            last_activity_at = now() - interval '6 days'
          where id = ${recent.id}`;

        yield* deleteExpiredRuns.pipe(Effect.provide(sandboxes.layer));

        expect(Option.isNone(yield* store.getRun(old.id))).toBe(true);
        expect(yield* store.listEvents(old.id)).toEqual([]);
        expect(Option.isNone(yield* store.getDiff(old.id))).toBe(true);
        expect(sandboxes.state.deletedCheckpoints).toEqual(["cp_old"]);
        expect(Option.isSome(yield* store.getRun(recent.id))).toBe(true);
      }),
    );
  });
});
