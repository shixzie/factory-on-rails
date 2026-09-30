import { PgClient } from "@effect/sql-pg";
import {
  agentCredential,
  AGENTS,
  DEFAULT_AGENT,
  isAgentId,
  MODEL_PROVIDERS,
  snapshotsFor,
  Store,
  TokenCipher,
  type AgentId,
  type RunRow,
  type RunSandbox,
} from "@factory/core";
import { Duration, Effect, FiberSet, Option, Queue, Schedule, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { RunnerConfig } from "./config.js";
import { executeRun } from "./execute.js";
import { SCRUB_SCRIPT, withHome } from "./plan.js";
import { makeRunLog } from "./run-log.js";
import { Sandboxes } from "./sandbox.js";

const noKey = (agent: AgentId) =>
  `No usable key for ${AGENTS[agent].label}. Add or re-save it in Settings (or pick a sandbox snapshot that is signed in), then send a message to try again.`;

/**
 * Decrypts the one credential of the run owner's that their agent should use
 * (see AGENTS) into the env var it reads. Only that one goes in: Claude Code,
 * for one, would pick an API key over a subscription token.
 */
const userKeyEnv = (userId: string, agent: AgentId) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const cipher = yield* TokenCipher;
    const keys = yield* store.encryptedApiKeys(userId);
    const provider = agentCredential(agent, keys.map((k) => k.provider));
    const key = keys.find((k) => k.provider === provider);
    if (!provider || !key) return {};
    return { [MODEL_PROVIDERS[provider].envVar]: yield* cipher.decrypt(key.key_enc) };
  });

/**
 * The sandbox snapshot the run owner picked, if SANDBOX_SNAPSHOTS still lets
 * them use it. One taken away since is an error rather than silently ignored:
 * it may be what signs their agent in.
 */
const userSnapshot = (userId: string) =>
  Effect.gen(function* () {
    const config = yield* RunnerConfig;
    const user = yield* (yield* Store).getUser(userId);
    const picked = Option.getOrUndefined(user)?.sandbox_snapshot ?? null;
    if (Option.isNone(user) || picked === null) return { snapshot: undefined };
    if (snapshotsFor(config.snapshots, user.value.github_login).includes(picked)) return { snapshot: picked };
    return { snapshot: undefined, error: `The sandbox snapshot ${picked} is no longer available to you. Pick another one in Settings, then send a message to try again.` };
  });

export const handleRun = (run: RunRow) =>
  Effect.gen(function* () {
    const config = yield* RunnerConfig;
    const store = yield* Store;
    const log = yield* makeRunLog(run.id);
    yield* log.info(`Claimed by runner ${config.workerId}`);

    const agent = isAgentId(run.agent) ? run.agent : DEFAULT_AGENT;
    const fail = (error: string) =>
      Effect.gen(function* () {
        yield* log.error(error);
        yield* log.flush;
        yield* store.finishRun(run.id, "failed", error, run.claimed_by ?? undefined);
      });

    const { snapshot, error: snapshotError } = yield* userSnapshot(run.user_id);
    if (snapshotError && !run.recovering) return yield* fail(snapshotError);
    const keyEnv = yield* userKeyEnv(run.user_id, agent).pipe(
      Effect.tapErrorCause((cause) => Effect.logError("Could not decrypt API keys", cause)),
      Effect.orElseSucceed((): Record<string, string> => ({})),
    );
    // A snapshot can carry the agent's own sign-in, so it may stand in for a key.
    if (Object.keys(keyEnv).length === 0 && !snapshot && !run.recovering) return yield* fail(noKey(agent));
    Object.values(keyEnv).forEach(log.addSecret);
    if (Object.keys(keyEnv).length === 0) yield* log.info(`No key saved for ${AGENTS[agent].label}, so it uses the sign-in in snapshot ${snapshot}`);

    const outcome = yield* executeRun(run, {
      log,
      // The user's own keys win over any platform-level passthrough of the same name.
      agent: {
        id: agent,
        ...config.agent.commands[agent],
        timeoutSec: config.agent.timeoutSec,
        env: { ...config.agent.passthroughEnv, ...keyEnv },
      },
      snapshot,
      git: config.git,
      harnessUrl: config.harnessUrl,
      preview: config.preview,
      heartbeatEvery: config.heartbeatInterval,
    });
    yield* log.flush;
    if (outcome.status === "recovering") {
      // Avoid a tight claim/release loop while an upstream service is down.
      yield* Effect.sleep(config.pollInterval);
      if (run.claimed_by) yield* store.releaseRun(run.id, run.claimed_by);
      return;
    }
    yield* store.finishRun(run.id, outcome.status, outcome.status === "failed" ? outcome.error : undefined, run.claimed_by ?? undefined);
    yield* Effect.logInfo(`Run ${outcome.status}`);
  }).pipe(
    Effect.scoped,
    // Scope finalizers detach before giving the claim back. A replacement can
    // reattach to the same commands without creating a new conversation turn.
    Effect.onInterrupt(() =>
      Effect.flatMap(Store, (store) =>
        run.claimed_by ? store.releaseRun(run.id, run.claimed_by) : Effect.void,
      ).pipe(Effect.ignore),
    ),
    Effect.catchAllCause((cause) => Effect.logError("Run crashed", cause)),
    Effect.annotateLogs({ run: run.id, repo: run.repo_full_name }),
  );

/**
 * Releases runs whose runner died so another runner can reconnect to them.
 */
export const reap = Effect.gen(function* () {
  const config = yield* RunnerConfig;
  const store = yield* Store;
  for (const stale of yield* store.reapStaleRuns(config.staleRunSeconds)) {
    yield* Effect.logWarning(`Recovering stale run ${stale.id}`);
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

/** Claims queued runs until interrupted; shutdown detaches commands and releases their claims. */
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
      const next = yield* store.claimNextRun(`${config.workerId}:${randomUUID()}`).pipe(
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
