import { SqlClient } from "@effect/sql";
import { encrypt, Store, TokenCipher, type RunRow } from "@factory/core";
import { describe, expect, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Option, Schedule } from "effect";
import { randomBytes } from "node:crypto";
import { TestDbLive, testDatabaseUrl } from "../../../packages/core/test/db.js";
import { RunnerConfig } from "../src/config.js";
import { runner } from "../src/worker.js";
import { fakeGitHub, fakeSandboxes } from "./stubs.js";

const key = randomBytes(32);
const API_KEY = "sk-ant-api03-worker-test-key";

const config = Layer.succeed(RunnerConfig, {
  harnessUrl: Option.some("https://factory.example"),
  workerId: "test-runner",
  maxConcurrentRuns: 2,
  pollInterval: Duration.millis(50),
  staleRunSeconds: 180,
  heartbeatInterval: Duration.millis(20),
  agent: { setupCommand: "setup-agent", command: "run-agent", timeoutSec: 60, passthroughEnv: {} },
  git: { authorName: "A", authorEmail: "a@x" },
});

const Base = Layer.mergeAll(Store.Live, Layer.succeed(TokenCipher, TokenCipher.fromKey(key)), config).pipe(
  Layer.provideMerge(TestDbLive),
);

/** Queues a run for a user who has saved an API key. */
const queueRun = Effect.gen(function* () {
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
  yield* store.upsertApiKey({ user_id: user.id, provider: "anthropic", key_enc: encrypt(API_KEY, key), hint: "-key" });
  return yield* store.enqueueRun({
    user_id: user.id,
    repo_full_name: "shixzie/demo",
    installation_id: 42,
    base_branch: "main",
    task: "Add a README",
  });
});

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
        expect(sandboxes.state.destroyed).toBe(true);
        const log = (yield* events(run.id)).join("\n");
        expect(log).not.toContain(API_KEY);
        expect(log).not.toContain("ghs_repo_token");
      }),
    );

    it.effect("stops the agent when the user cancels", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({}, { hang: "run-agent" });
        const worker = yield* runner.pipe(Effect.provide(Layer.merge(sandboxes.layer, fakeGitHub())), Effect.fork);
        const run = yield* queueRun;
        yield* waitForRun(run.id, () => sandboxes.state.commands.includes("run-agent"));

        yield* Effect.flatMap(Store, (store) => store.requestCancel(run.id, run.user_id));
        const finished = yield* waitForRun(run.id, (r) => r.status === "cancelled");
        yield* Fiber.interrupt(worker);

        expect(finished.status).toBe("cancelled");
        expect(sandboxes.state.killed).toBe(true);
        expect(sandboxes.state.destroyed).toBe(true);
      }),
    );

    it.effect("fails in-flight runs and destroys their sandboxes when the runner stops", () =>
      Effect.gen(function* () {
        const sandboxes = fakeSandboxes({}, { hang: "run-agent" });
        const worker = yield* runner.pipe(Effect.provide(Layer.merge(sandboxes.layer, fakeGitHub())), Effect.fork);
        const run = yield* queueRun;
        yield* waitForRun(run.id, () => sandboxes.state.commands.includes("run-agent"));

        yield* Fiber.interrupt(worker);
        const [row] = yield* Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ status: string; error: string }>`select status, error from runs where id = ${run.id}`,
        );
        expect(row).toEqual({ status: "failed", error: "The runner stopped before this run finished. Start it again." });
        expect(sandboxes.state.killed).toBe(true);
        expect(sandboxes.state.destroyed).toBe(true);
      }),
    );
  });
});
