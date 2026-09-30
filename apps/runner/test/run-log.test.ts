import { describe, expect, it } from "@effect/vitest";
import { SqlError } from "@effect/sql";
import { type RunEvent } from "@factory/core";
import { Deferred, Duration, Effect, Fiber } from "effect";
import { makeRunLog, redact } from "../src/run-log.js";
import { recordingStore, stubStore } from "./stubs.js";

describe("redact", () => {
  it("scrubs every occurrence of every secret", () => {
    const key = "sk-ant-api03-abcdefghijklmnop";
    expect(redact(`ANTHROPIC_API_KEY=${key}\ntoken ghs_123456789 and ${key}`, [key, "ghs_123456789"])).toBe(
      "ANTHROPIC_API_KEY=[redacted]\ntoken [redacted] and [redacted]",
    );
  });

  it("leaves messages without secrets alone", () => {
    expect(redact("all good", ["sk-ant-secret-value"])).toBe("all good");
  });
});

describe("makeRunLog", () => {
  it.effect("retains failed writes for retry and reports durable flush errors", () => Effect.gen(function* () {
    const stored: RunEvent[] = [];
    const unavailable = new SqlError.SqlError({ message: "database restarting", cause: new Error("connection reset") });
    let online = false;
    const layer = stubStore({
      appendEvents: (_id, batch) => Effect.suspend(() => online
        ? Effect.sync(() => { stored.push(...batch); })
        : Effect.fail(unavailable)),
    });
    yield* Effect.gen(function* () {
      const log = yield* makeRunLog("run-1", { flushEvery: Duration.hours(1) });
      log.push("message", "before deploy", { _replayKey: "1:agent:0" });
      const failed = yield* Effect.either(log.flushDurable!);
      expect(failed).toMatchObject({ _tag: "Left", left: unavailable });
      log.push("message", "while reconnecting", { _replayKey: "1:agent:1" });
      online = true;
      yield* log.flushDurable!;
      yield* log.flushDurable!;
    }).pipe(Effect.scoped, Effect.provide(layer));
    expect(stored.map((event) => event.message)).toEqual(["before deploy", "while reconnecting"]);
  }));

  it.effect("restores an in-flight failed batch ahead of new output without overlapping inserts", () => Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const stored: RunEvent[] = [];
    let attempts = 0;
    let active = 0;
    let mostActive = 0;
    const layer = stubStore({
      appendEvents: (_id, batch) => Effect.gen(function* () {
        active++;
        mostActive = Math.max(mostActive, active);
        if (++attempts === 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return yield* new SqlError.SqlError({ message: "database restarting", cause: new Error("connection reset") });
        }
        stored.push(...batch);
      }).pipe(Effect.ensuring(Effect.sync(() => { active--; }))),
    });
    yield* Effect.gen(function* () {
      const log = yield* makeRunLog("run-1", { flushEvery: Duration.hours(1) });
      log.push("stdout", "first");
      const flushing = yield* Effect.fork(Effect.either(log.flushDurable!));
      yield* Deferred.await(started);
      log.push("stdout", "second");
      const queued = yield* Effect.fork(Effect.either(log.flushDurable!));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(flushing);
      yield* Fiber.join(queued);
      yield* log.flushDurable!;
    }).pipe(Effect.scoped, Effect.provide(layer));
    expect(stored.map((event) => event.message)).toEqual(["first", "second"]);
    expect(mostActive).toBe(1);
  }));

  it.effect("stores redacted events when its scope closes", () =>
    Effect.gen(function* () {
      const store = recordingStore();
      yield* Effect.gen(function* () {
        const log = yield* makeRunLog("run-1");
        log.addSecret("sk-ant-user-key");
        log.push("stdout", "using sk-ant-user-key");
        yield* log.info("done");
      }).pipe(Effect.scoped, Effect.provide(store.layer));
      expect(store.events).toEqual([
        { kind: "stdout", message: "using [redacted]" },
        { kind: "info", message: "done" },
      ]);
    }),
  );

  it.effect("stops storing agent output past the limit, once, but keeps status lines", () =>
    Effect.gen(function* () {
      const store = recordingStore();
      yield* Effect.gen(function* () {
        const log = yield* makeRunLog("run-1", { maxOutputBytes: 10 });
        log.push("stdout", "12345");
        log.push("stdout", "678901");
        log.push("stderr", "more");
        log.push("error", "agent failed");
      }).pipe(Effect.scoped, Effect.provide(store.layer));
      expect(store.events.map((e) => e.message)).toEqual([
        "12345",
        "Output limit reached; further agent output is not stored",
        "agent failed",
      ]);
    }),
  );

  it.effect("merges consecutive output, redacts event data and counts agent events toward the limit", () =>
    Effect.gen(function* () {
      const store = recordingStore();
      yield* Effect.gen(function* () {
        const log = yield* makeRunLog("run-1", { maxOutputBytes: 200 });
        log.addSecret("sk-ant-user-key");
        log.push("stdout", "a");
        log.push("stdout", "b");
        log.push("stderr", "c");
        log.push("tool_call", "Bash", { id: "t", name: "Bash", input: { command: "echo sk-ant-user-key" } });
        log.push("tool_result", "x".repeat(300), { toolUseId: "t", isError: false });
        log.push("agent_result", "done", { isError: false });
      }).pipe(Effect.scoped, Effect.provide(store.layer));
      expect(store.events).toEqual([
        { kind: "stdout", message: "ab" },
        { kind: "stderr", message: "c" },
        { kind: "tool_call", message: "Bash", data: { id: "t", name: "Bash", input: { command: "echo [redacted]" } } },
        { kind: "info", message: "Output limit reached; further agent output is not stored" },
        { kind: "agent_result", message: "done", data: { isError: false } },
      ]);
    }),
  );
});
