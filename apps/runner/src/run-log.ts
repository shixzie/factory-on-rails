import { Store, type RunEvent } from "@factory/core";
import { Duration, Effect, Schedule, type Scope } from "effect";

/** Replaces every occurrence of each secret with a marker. */
export function redact(message: string, secrets: Iterable<string>): string {
  let out = message;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

export interface RunLog {
  /** Synchronous so SDK output callbacks can call it directly. */
  readonly push: (kind: RunEvent["kind"], message: string) => void;
  /**
   * Values (the user's API keys, the repo token) scrubbed from everything
   * stored. A secret split across two output chunks can slip through, so this
   * is a safety net, not a guarantee.
   */
  readonly addSecret: (value: string) => void;
  readonly info: (message: string) => Effect.Effect<void>;
  readonly error: (message: string) => Effect.Effect<void>;
  readonly flush: Effect.Effect<void>;
}

/**
 * A run's event log. Streaming agent output is batched into a handful of
 * inserts per second rather than one per chunk, and output beyond
 * `maxOutputBytes` is dropped (with one notice) so a runaway agent can't fill
 * Postgres. Flushes once more when its scope closes.
 */
export const makeRunLog = (
  runId: string,
  { maxOutputBytes = 5 * 1024 * 1024, flushEvery = Duration.seconds(1) } = {},
): Effect.Effect<RunLog, never, Store | Scope.Scope> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const lock = yield* Effect.makeSemaphore(1);
    const secrets = new Set<string>();
    let pending: RunEvent[] = [];
    let outputBytes = 0;
    let truncated = false;

    const push = (kind: RunEvent["kind"], raw: string) => {
      const message = redact(raw, secrets);
      if (kind === "stdout" || kind === "stderr") {
        if (truncated) return;
        outputBytes += Buffer.byteLength(message);
        if (outputBytes > maxOutputBytes) {
          truncated = true;
          pending.push({ kind: "info", message: "Output limit reached; further agent output is not stored" });
          return;
        }
      }
      pending.push({ kind, message });
    };

    const flush = lock.withPermits(1)(
      Effect.suspend(() => {
        const batch = pending;
        pending = [];
        return batch.length === 0 ? Effect.void : store.appendEvents(runId, batch);
      }),
    ).pipe(Effect.catchAllCause((cause) => Effect.logError("Could not store run events", cause)));

    yield* Effect.addFinalizer(() => flush);
    yield* flush.pipe(Effect.repeat(Schedule.spaced(flushEvery)), Effect.forkScoped);

    return {
      push,
      addSecret: (value) => {
        if (value.length >= 8) secrets.add(value);
      },
      info: (message) => Effect.sync(() => push("info", message)),
      error: (message) => Effect.sync(() => push("error", message)),
      flush,
    };
  });
