import { PgClient } from "@effect/sql-pg";
import {
  isModelProvider,
  MODEL_PROVIDERS,
  Store,
  TokenCipher,
  type RunRow,
} from "@factory/core";
import { Effect, FiberSet, Option, Queue, Schedule, Stream } from "effect";
import { RunnerConfig } from "./config.js";
import { executeRun } from "./execute.js";
import { makeRunLog } from "./run-log.js";
import { Sandboxes } from "./sandbox.js";

const NO_KEY =
  "No usable API key saved. Add or re-save your key in Settings, then start the run again.";

/** Decrypts the run owner's own API keys into the env vars their agent reads. */
const userKeyEnv = (userId: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const cipher = yield* TokenCipher;
    const env: Record<string, string> = {};
    for (const { provider, key_enc } of yield* store.encryptedApiKeys(userId)) {
      if (isModelProvider(provider)) env[MODEL_PROVIDERS[provider].envVar] = yield* cipher.decrypt(key_enc);
    }
    return env;
  });

export const handleRun = (run: RunRow) =>
  Effect.gen(function* () {
    const config = yield* RunnerConfig;
    const store = yield* Store;
    const log = yield* makeRunLog(run.id);
    yield* log.info(`Claimed by runner ${config.workerId}`);

    const keyEnv = yield* userKeyEnv(run.user_id).pipe(
      Effect.tapErrorCause((cause) => Effect.logError("Could not decrypt API keys", cause)),
      Effect.orElseSucceed((): Record<string, string> => ({})),
    );
    if (Object.keys(keyEnv).length === 0) {
      yield* log.error(NO_KEY);
      yield* log.flush;
      return yield* store.finishRun(run.id, "failed", NO_KEY);
    }
    Object.values(keyEnv).forEach(log.addSecret);

    const outcome = yield* executeRun(run, {
      log,
      // The user's own keys win over any platform-level passthrough of the same name.
      agent: { ...config.agent, env: { ...config.agent.passthroughEnv, ...keyEnv } },
      git: config.git,
      harnessUrl: config.harnessUrl,
      heartbeatEvery: config.heartbeatInterval,
    });
    yield* log.flush;
    yield* store.finishRun(run.id, outcome.status, outcome.status === "failed" ? outcome.error : undefined);
    yield* Effect.logInfo(`Run ${outcome.status}`);
  }).pipe(
    Effect.scoped,
    // A stopping runner (redeploy, scale down) interrupts its runs: the sandbox
    // is torn down on the way out and the run is marked failed, not left hanging.
    Effect.onInterrupt(() =>
      Effect.flatMap(Store, (store) =>
        store.finishRun(run.id, "failed", "The runner stopped before this run finished. Start it again."),
      ).pipe(Effect.ignore),
    ),
    Effect.catchAllCause((cause) => Effect.logError("Run crashed", cause)),
    Effect.annotateLogs({ run: run.id, repo: run.repo_full_name }),
  );

/** Fails runs whose runner died and tears down the sandboxes they left behind. */
export const reap = Effect.gen(function* () {
  const config = yield* RunnerConfig;
  const store = yield* Store;
  const sandboxes = yield* Sandboxes;
  for (const stale of yield* store.reapStaleRuns(config.staleRunSeconds)) {
    yield* Effect.logWarning(`Reaped stale run ${stale.id}`);
    if (stale.sandbox_id) {
      yield* sandboxes.destroy(stale.sandbox_id).pipe(Effect.catchAll((err) => Effect.logWarning(err.message)));
    }
  }
});

/** Claims and runs queued runs until interrupted; interrupting it stops every run in flight. */
export const runner = Effect.gen(function* () {
  const config = yield* RunnerConfig;
  const store = yield* Store;
  const pg = yield* PgClient.PgClient;
  const runs = yield* FiberSet.make();
  const slots = yield* Effect.makeSemaphore(config.maxConcurrentRuns);
  const wake = yield* Queue.sliding<void>(1);
  const signal = Queue.offer(wake, undefined);

  // NOTIFY wakes the runner as soon as the harness queues a run; polling is the fallback.
  yield* pg.listen("runs_queued").pipe(
    Stream.runForEach(() => signal),
    Effect.tapErrorCause((cause) => Effect.logError("LISTEN runs_queued stopped", cause)),
    Effect.retry(Schedule.spaced(config.pollInterval)),
    Effect.forkScoped,
  );
  yield* signal.pipe(Effect.repeat(Schedule.spaced(config.pollInterval)), Effect.forkScoped);
  yield* reap.pipe(
    Effect.catchAllCause((cause) => Effect.logError("Reaper failed", cause)),
    Effect.repeat(Schedule.spaced(config.pollInterval)),
    Effect.forkScoped,
  );

  yield* Effect.logInfo(`Runner ${config.workerId} started (max ${config.maxConcurrentRuns} concurrent runs)`);

  // Take a free slot, then claim; with no queued run, give the slot back and wait.
  yield* Effect.forever(
    Effect.gen(function* () {
      yield* slots.take(1);
      const next = yield* store.claimNextRun(config.workerId).pipe(
        Effect.tapErrorCause((cause) => Effect.logError("Could not claim a run", cause)),
        Effect.orElseSucceed(() => Option.none<RunRow>()),
      );
      if (Option.isNone(next)) {
        yield* slots.release(1);
        return yield* Queue.take(wake);
      }
      yield* Effect.logInfo(`Claimed run ${next.value.id} (${next.value.repo_full_name})`);
      yield* FiberSet.run(runs, handleRun(next.value).pipe(Effect.ensuring(slots.release(1))));
    }),
  );
}).pipe(Effect.scoped);
