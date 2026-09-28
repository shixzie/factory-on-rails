import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { wrapSandbox, type SandboxLike } from "../src/sandbox.js";

describe("wrapSandbox", () => {
  it.effect("streams output and returns the result", () =>
    Effect.gen(function* () {
      const chunks: string[] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: (_command, options) => {
          options.onStdout?.("hello");
          options.onStderr?.("warn");
          return Object.assign(Promise.resolve({ exitCode: 0, stdout: "hello", timedOut: false }), {
            kill: async () => true,
          });
        },
        files: { write: async () => undefined },
      };
      const result = yield* wrapSandbox(sandbox).exec("echo hello", { onOutput: (s, c) => chunks.push(`${s}:${c}`) });
      expect(result).toEqual({ exitCode: 0, stdout: "hello", timedOut: false });
      expect(chunks).toEqual(["stdout:hello", "stderr:warn"]);
    }),
  );

  it.effect("kills the command when interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const signals: string[] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: () => {
          Deferred.unsafeDone(started, Effect.void);
          return Object.assign(new Promise<never>(() => {}), {
            kill: async (signal?: string) => void signals.push(signal ?? "TERM"),
          });
        },
        files: { write: async () => undefined },
      };
      const fiber = yield* Effect.fork(wrapSandbox(sandbox).exec("sleep 1000"));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(signals).toEqual(["TERM"]);
    }),
  );

  it.effect("turns SDK rejections into SandboxError", () =>
    Effect.gen(function* () {
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: () => Object.assign(Promise.reject(new Error("socket closed")), { kill: async () => true }),
        files: { write: async () => Promise.reject(new Error("disk full")) },
      };
      const execError = yield* Effect.flip(wrapSandbox(sandbox).exec("true"));
      expect(execError._tag).toBe("SandboxError");
      const writeError = yield* Effect.flip(wrapSandbox(sandbox).writeFile("/tmp/x", "y"));
      expect(writeError.message).toBe("Could not write /tmp/x: disk full");
    }),
  );
});
