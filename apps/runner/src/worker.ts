import { PgClient } from "@effect/sql-pg";
import {
  isModelProvider,
  MODEL_PROVIDERS,
  Store,
  TokenCipher,
  type RunRow,
  type RunSandbox,
} from "@factory/core";
import { Duration, Effect, FiberSet, Option, Queue, Schedule, Stream } from "effect";
import { RunnerConfig } from "./config.js";
import { executeRun } from "./execute.js";
import { SCRUB_SCRIPT, withHome } from "./plan.js";
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
      preview: config.preview,
      heartbeatEvery: config.heartbeatInterval,
    });
    yield* log.flush;
    yield* store.finishRun(run.id, outcome.status, outcome.status === "failed" ? outcome.error : undefined);
    yield* Effect.logInfo(`Run ${outcome.status}`);
  }).pipe(
    Effect.scoped,
    // A stopping runner (redeploy, scale down) interrupts its runs: the agent is
    // killed and the run is marked failed, not left hanging. Its sandbox is kept,
    // so a message picks the run up again where it stopped.
    Effect.onInterrupt(() =>
      Effect.flatMap(Store, (store) =>
        store.finishRun(run.id, "failed", "The runner stopped before this run finished. Send a message to pick it up again."),
      ).pipe(Effect.ignore),
    ),
    Effect.catchAllCause((cause) => Effect.logError("Run crashed", cause)),
    Effect.annotateLogs({ run: run.id, repo: run.repo_full_name }),
  );

/**
 * Fails runs whose runner died. Their sandboxes stay, and are stopped like any
 * other idle sandbox (see stopIdleSandboxes).
 */
export const reap = Effect.gen(function* () {
  const config = yield* RunnerConfig;
  const store = yield* Store;
  for (const stale of yield* store.reapStaleRuns(config.staleRunSeconds)) {
    yield* Effect.logWarning(`Reaped stale run ${stale.id}`);
  }
});

/** A runner that died mid-stop gives the sandbox back after this long. */
const STOPPING_STALE_SECONDS = 15 * 60;

/** Unique per stop: Railway wants a fresh name for each checkpoint. */
export const checkpointName = (runId: string, now = Date.now()) => `run-${runId}-${now.toString(36)}`;

/**
 * Stops one idle sandbox: Railway can't pause a sandbox, so its disk is saved
 * as a checkpoint and the VM destroyed. The next message boots a new sandbox
 * from the checkpoint (see execute.ts). A sandbox that can't be saved is
 * destroyed anyway, and the next turn starts over from the pushed branch.
 */
const stopSandbox = (run: RunSandbox) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sandboxes = yield* Sandboxes;
    const gone = (note?: string) =>
      Effect.zipRight(
        store.updateRun(run.id, { sandbox_state: "deleted", sandbox_checkpoint_id: null, sandbox_checkpoint_name: null }),
        note ? store.appendEvents(run.id, [{ kind: "info", message: note }]) : Effect.void,
      );

    const handle = run.sandbox_id ? yield* sandboxes.connect(run.sandbox_id) : Option.none();
    // Already gone, e.g. Railway's own idle timeout got there first.
    if (Option.isNone(handle)) return yield* gone();
    const id = handle.value.id;

    yield* handle.value.exec(withHome(SCRUB_SCRIPT), { timeoutSec: 30 }).pipe(Effect.ignore);
    const saved = yield* sandboxes.checkpoint(id, checkpointName(run.id)).pipe(Effect.either);
    if (saved._tag === "Left") {
      yield* Effect.logWarning(saved.left.message);
      yield* sandboxes.destroy(id);
      return yield* gone(
        "The sandbox could not be saved before it was stopped, so the next message starts a new one from the branch.",
      );
    }
    // Saved, so record it as stopped even if this fails: Railway's idle timeout removes the VM.
    yield* sandboxes.destroy(id).pipe(Effect.catchAll((err) => Effect.logWarning(err.message)));
    yield* store.updateRun(run.id, {
      sandbox_state: "stopped",
      sandbox_checkpoint_id: saved.right.id,
      sandbox_checkpoint_name: saved.right.name,
    });
    yield* Effect.logInfo(`Stopped idle sandbox ${id}`);
  }).pipe(
    // Left `stopping`; another pass takes it back after STOPPING_STALE_SECONDS.
    Effect.catchAllCause((cause) => Effect.logWarning("Could not stop the sandbox", cause)),
    Effect.annotateLogs({ run: run.id }),
  );

/** Stops the sandboxes of finished runs nobody has touched for `sandboxIdleStop`. */
export const stopIdleSandboxes = Effect.gen(function* () {
  const config = yield* RunnerConfig;
  const store = yield* Store;
  const idle = yield* store.claimIdleSandboxes(Duration.toSeconds(config.sandboxIdleStop), STOPPING_STALE_SECONDS, 10);
  yield* Effect.forEach(idle, stopSandbox, { concurrency: 3, discard: true });
});

/** Deletes one expired run: its sandbox or checkpoint first, then the run, its events and its diff. */
const deleteRun = (run: RunSandbox, days: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sandboxes = yield* Sandboxes;
    if (run.sandbox_state === "running" && run.sandbox_id) yield* sandboxes.destroy(run.sandbox_id);
    if (run.sandbox_checkpoint_id) yield* sandboxes.deleteCheckpoint(run.sandbox_checkpoint_id);
    // Not deleted if the user came back meanwhile; the next turn starts a new sandbox.
    if (yield* store.deleteExpiredRun(run.id, days)) {
      yield* Effect.logInfo(`Deleted run ${run.id} after ${days} days without activity`);
    }
  }).pipe(
    // Tried again on the next pass.
    Effect.catchAllCause((cause) => Effect.logWarning("Could not delete the expired run", cause)),
    Effect.annotateLogs({ run: run.id }),
  );

/** Deletes runs with no activity for `runRetentionDays`, along with their sandboxes. */
export const deleteExpiredRuns = Effect.gen(function* () {
  const config = yield* RunnerConfig;
  const store = yield* Store;
  const expired = yield* store.expiredRuns(config.runRetentionDays, 20);
  yield* Effect.forEach(expired, (run) => deleteRun(run, config.runRetentionDays), { concurrency: 3, discard: true });
});

/** How often a sandbox someone is previewing gets a no-op command. */
const PREVIEW_KEEPALIVE_MS = 5 * 60_000;
/** Preview traffic this recent counts as someone previewing. */
const PREVIEW_RECENT_SECONDS = 120;

/**
 * Preview traffic bumps a run's activity, so the runner doesn't stop the
 * sandbox under the person using it. Railway's own idle timeout only counts
 * commands, though, so those sandboxes also get a no-op now and then.
 * `last` remembers when each one last got it.
 */
export const keepPreviewedSandboxesAlive = (last: Map<string, number>, now = Date.now()) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const sandboxes = yield* Sandboxes;
    for (const [id, at] of last) if (now - at > 2 * PREVIEW_KEEPALIVE_MS) last.delete(id);
    for (const run of yield* store.previewedSandboxes(PREVIEW_RECENT_SECONDS)) {
      if (!run.sandbox_id || now - (last.get(run.id) ?? 0) < PREVIEW_KEEPALIVE_MS) continue;
      last.set(run.id, now);
      const handle = yield* sandboxes.connect(run.sandbox_id);
      if (Option.isSome(handle)) yield* handle.value.exec("true", { timeoutSec: 30 }).pipe(Effect.ignore);
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
  yield* Effect.zipRight(stopIdleSandboxes, deleteExpiredRuns).pipe(
    Effect.catchAllCause((cause) => Effect.logError("Sandbox cleanup failed", cause)),
    Effect.repeat(Schedule.spaced(config.lifecycleInterval)),
    Effect.forkScoped,
  );

  const keptAlive = new Map<string, number>();
  yield* Effect.suspend(() => keepPreviewedSandboxesAlive(keptAlive)).pipe(
    Effect.catchAllCause((cause) => Effect.logWarning("Could not keep previewed sandboxes alive", cause)),
    Effect.repeat(Schedule.spaced(config.lifecycleInterval)),
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
