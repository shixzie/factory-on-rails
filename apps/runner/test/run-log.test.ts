import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeRunLog, redact } from "../src/run-log.js";
import { recordingStore } from "./stubs.js";

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
