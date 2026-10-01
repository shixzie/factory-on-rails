import { Store, type RunEvent } from "@factory/core";
import type { SqlError } from "@effect/sql";
import { Duration, Effect, Schedule, type Scope } from "effect";

/** Replaces every occurrence of each secret with a marker. */
export function redact(message: string, secrets: Iterable<string>): string {
  const patterns = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return patterns.length === 0 ? message : message.replace(new RegExp(patterns.join("|"), "g"), "[redacted]");
}

/** Kinds that count toward a run's output budget: everything the agent produces. */
const BUDGETED: ReadonlySet<RunEvent["kind"]> = new Set(["stdout", "stderr", "message", "thinking", "tool_call", "tool_result"]);
/** Consecutive output chunks are merged into one event up to this size. */
const MAX_MERGED_OUTPUT = 64 * 1024;

export interface RunLog {
  /** Synchronous so SDK output callbacks can call it directly. */
  readonly push: (kind: RunEvent["kind"], message: string, data?: RunEvent["data"]) => void;
  /** Scrubs the run's secrets from text stored elsewhere (the diff). */
  readonly redact: (text: string) => string;
  /**
   * Values (the user's API keys, the repo token) scrubbed from everything
   * stored. A secret split across two output chunks can slip through, so this
   * is a safety net, not a guarantee.
   */
  readonly addSecret: (value: string, options?: { readonly allowShort?: boolean }) => void;
  readonly info: (message: string) => Effect.Effect<void>;
  readonly error: (message: string) => Effect.Effect<void>;
  readonly flush: Effect.Effect<void>;
  /** Flushes before a durable checkpoint; failure keeps the batch queued and must not be ignored. */
  readonly flushDurable?: Effect.Effect<void, SqlError.SqlError>;
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

    // Redact values before serialization: arbitrary MCP credentials can contain
    // quotes and newlines, which would either escape matching or corrupt JSON.
    const scrubData = (value: unknown): unknown => {
      if (typeof value === "string") return redact(value, secrets);
      if (Array.isArray(value)) return value.map(scrubData);
      if (typeof value === "object" && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, scrubData(nested)]));
      }
      return value;
    };

    const push = (kind: RunEvent["kind"], raw: string, rawData?: RunEvent["data"]) => {
      const message = redact(raw, secrets);
      const data = rawData == null ? null : scrubData(rawData) as RunEvent["data"];
      if (BUDGETED.has(kind)) {
        if (truncated) return;
        outputBytes += Buffer.byteLength(message) + (data ? Buffer.byteLength(JSON.stringify(data)) : 0);
        if (outputBytes > maxOutputBytes) {
          truncated = true;
          pending.push({ kind: "info", message: "Output limit reached; further agent output is not stored" });
          return;
        }
      }
      // Raw output arrives in many small chunks; store runs of it as one event.
      const last = pending.at(-1);
      if ((kind === "stdout" || kind === "stderr") && last?.kind === kind && last.message.length < MAX_MERGED_OUTPUT) {
        pending[pending.length - 1] = { kind, message: last.message + message };
        return;
      }
      pending.push(data ? { kind, message, data } : { kind, message });
    };

    const flushDurable = lock.withPermits(1)(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const batch = pending;
          pending = [];
          return batch;
        }),
        (batch) => batch.length === 0 ? Effect.void : store.appendEvents(runId, batch),
        (batch, exit) => Effect.sync(() => {
          // Output can arrive while the insert is in flight. Restore the old
          // batch before it, including when scope shutdown interrupted a flush.
          if (exit._tag === "Failure") pending = [...batch, ...pending];
        }),
      ),
    );
    const flush = flushDurable.pipe(Effect.catchAllCause((cause) => Effect.logError("Could not store run events", cause)));

    yield* Effect.addFinalizer(() => flush);
    yield* flush.pipe(Effect.repeat(Schedule.spaced(flushEvery)), Effect.forkScoped);

    return {
      push,
      redact: (text) => redact(text, secrets),
      addSecret: (value, options) => {
        if (value.length >= (options?.allowShort ? 1 : 8)) {
          secrets.add(value);
          secrets.add(JSON.stringify(value).slice(1, -1));
        }
      },
      info: (message) => Effect.sync(() => push("info", message)),
      error: (message) => Effect.sync(() => push("error", message)),
      flush,
      flushDurable,
    };
  });
