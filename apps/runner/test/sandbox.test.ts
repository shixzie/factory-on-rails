import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schedule } from "effect";
import { ExecInterruptedError } from "railway";
import { waitUntilReady, wrapSandbox, type SandboxLike } from "../src/sandbox.js";

/** A sandbox whose exec answers from `outcomes` in order (the last one repeats). */
const scriptedSandbox = (outcomes: Array<"ok" | Error>) => {
  const calls: string[] = [];
  const sandbox: SandboxLike = {
    id: "sbx",
    exec: (command) => {
      calls.push(command);
      const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
      const result =
        outcome === "ok" ? Promise.resolve({ exitCode: 0, stdout: "", timedOut: false }) : Promise.reject(outcome);
      return Object.assign(result, { kill: async () => true });
    },
    files: { write: async () => undefined },
  };
  return { sandbox, calls };
};

const stillCreating = () =>
  new ExecInterruptedError({ closeCode: 1008, reason: "Sandbox is not running (status: CREATING). ", stdout: "", stderr: "" });

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

describe("waitUntilReady", () => {
  const fast = Schedule.recurs(5);

  it.effect("retries while Railway still reports the sandbox as CREATING", () =>
    Effect.gen(function* () {
      const { sandbox, calls } = scriptedSandbox([stillCreating(), stillCreating(), "ok"]);
      yield* waitUntilReady(sandbox, fast);
      expect(calls).toEqual(["true", "true", "true"]);
    }),
  );

  it.effect("gives up with a clear error if the sandbox never starts", () =>
    Effect.gen(function* () {
      const { sandbox, calls } = scriptedSandbox([stillCreating()]);
      const error = yield* Effect.flip(waitUntilReady(sandbox, fast));
      expect(calls).toHaveLength(6);
      expect(error.message).toMatch(/^Sandbox sbx did not start accepting commands: .*status: CREATING/);
    }),
  );

  it.effect("does not retry other failures", () =>
    Effect.gen(function* () {
      const { sandbox, calls } = scriptedSandbox([new Error("auth failed")]);
      const error = yield* Effect.flip(waitUntilReady(sandbox, fast));
      expect(calls).toHaveLength(1);
      expect(error.message).toBe("Sandbox sbx did not start accepting commands: auth failed");
    }),
  );
});
