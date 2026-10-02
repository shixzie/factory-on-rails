import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schedule, TestClock } from "effect";
import { ExecInterruptedError, RailwayConnectionError, RailwayGraphQLError } from "railway";
import { SandboxError, waitUntilReady, wrapSandbox, type ExecResult, type SandboxLike } from "../src/sandbox.js";

/** A sandbox whose exec answers from `outcomes` in order (the last one repeats). */
const handle = (result: Promise<ExecResult>, controls: { kill?: () => Promise<unknown>; detach?: () => Promise<string>; sessionName?: Promise<string> } = {}) =>
  Object.assign(result, {
    sessionName: Promise.resolve("durable-command"),
    kill: async (_signal?: "TERM" | "KILL") => true,
    detach: async () => "durable-command",
    ...controls,
  });

const disconnected = (stdout = "") => new ExecInterruptedError({ closeCode: 1006, reason: "Connection lost", stdout, stderr: "" });

const scriptedSandbox = (outcomes: Array<"ok" | Error>) => {
  const calls: string[] = [];
  const sandbox: SandboxLike = {
    id: "sbx",
    exec: (command) => {
      calls.push(typeof command === "string" ? command : command.sessionName);
      const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
      const result =
        outcome === "ok" ? Promise.resolve({ exitCode: 0, stdout: "", timedOut: false }) : Promise.reject(outcome);
      return handle(result);
    },
    files: { write: async () => undefined },
  };
  return { sandbox, calls };
};

const stillCreating = () =>
  new ExecInterruptedError({ closeCode: 1008, reason: "Sandbox is not running (status: CREATING). ", stdout: "", stderr: "" });

describe("wrapSandbox", () => {
  it.effect("uploads image bytes through the SDK without text conversion", () =>
    Effect.gen(function* () {
      const uploaded: unknown[][] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: () => handle(Promise.resolve({ exitCode: 0, stdout: "", timedOut: false })),
        files: { write: async (...args) => { uploaded.push(args); } },
      };
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]);
      yield* wrapSandbox(sandbox).writeFile("/workspace/.factory/images/image.png", bytes, 0o600);
      expect(uploaded).toEqual([["/workspace/.factory/images/image.png", bytes, { mode: 0o600 }]]);
    }),
  );

  it.effect("streams output and returns the result", () =>
    Effect.gen(function* () {
      const chunks: string[] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: (_command, options) => {
          options.onStdout?.("hello");
          options.onStderr?.("warn");
          return handle(Promise.resolve({ exitCode: 0, stdout: "hello", timedOut: false }));
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
          return handle(new Promise<never>(() => {}), {
            kill: async () => void signals.push("TERM"),
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
        exec: () => handle(Promise.reject(new Error("socket closed"))),
        files: { write: async () => Promise.reject(new Error("disk full")) },
      };
      const execError = yield* Effect.flip(wrapSandbox(sandbox).exec("true"));
      expect(execError._tag).toBe("SandboxError");
      const writeError = yield* Effect.flip(wrapSandbox(sandbox).writeFile("/tmp/x", "y"));
      expect(writeError.message).toBe("Could not write /tmp/x: disk full");
    }),
  );

  it.effect("waits for the session to be saved before accepting a fast command result", () =>
    Effect.gen(function* () {
      const saving = yield* Deferred.make<string>();
      const saved = yield* Deferred.make<void>();
      const { sandbox } = scriptedSandbox(["ok"]);
      const fiber = yield* Effect.fork(wrapSandbox(sandbox).exec("true", {
        onSession: (name) => Deferred.succeed(saving, name).pipe(Effect.zipRight(Deferred.await(saved))),
      }));
      expect(yield* Deferred.await(saving)).toBe("durable-command");
      expect((yield* Fiber.poll(fiber))._tag).toBe("None");
      yield* Deferred.succeed(saved, undefined);
      expect((yield* Fiber.join(fiber)).exitCode).toBe(0);
    }),
  );

  it.effect("kills a command if saving its session fails", () =>
    Effect.gen(function* () {
      const actions: string[] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: () => handle(new Promise<never>(() => {}), {
          kill: async () => void actions.push("kill"),
          detach: async () => { actions.push("detach"); return "durable-command"; },
        }),
        files: { write: async () => undefined },
      };
      const error = yield* Effect.flip(wrapSandbox(sandbox).exec("work", {
        onSession: () => Effect.fail(new SandboxError({ message: "database unavailable" })),
        detachOnInterrupt: () => true,
      }));
      expect(error.message).toBe("database unavailable");
      expect(actions).toEqual(["kill"]);
    }),
  );

  it.effect("detaches saved commands on shutdown but still kills them on cancellation", () =>
    Effect.gen(function* () {
      for (const cancelled of [false, true]) {
        const saved = yield* Deferred.make<void>();
        const actions: string[] = [];
        const sandbox: SandboxLike = {
          id: "sbx",
          exec: () => handle(new Promise<never>(() => {}), {
            kill: async () => void actions.push("kill"),
            detach: async () => { actions.push("detach"); return "durable-command"; },
          }),
          files: { write: async () => undefined },
        };
        const fiber = yield* Effect.fork(wrapSandbox(sandbox).exec("work", {
          onSession: () => Deferred.succeed(saved, undefined).pipe(Effect.asVoid),
          detachOnInterrupt: () => !cancelled,
        }));
        yield* Deferred.await(saved);
        yield* Fiber.interrupt(fiber);
        expect(actions).toEqual([cancelled ? "kill" : "detach"]);
      }
    }),
  );

  it.effect("does not detach when the command has no durable storage callback", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const actions: string[] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: () => {
          Deferred.unsafeDone(started, Effect.void);
          return handle(new Promise<never>(() => {}), {
            kill: async () => void actions.push("kill"),
            detach: async () => { actions.push("detach"); return "durable-command"; },
          });
        },
        files: { write: async () => undefined },
      };
      const fiber = yield* Effect.fork(wrapSandbox(sandbox).exec("work", { detachOnInterrupt: () => true }));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(actions).toEqual(["kill"]);
    }),
  );

  it.effect("finishes saving a session before shutdown detaches it", () =>
    Effect.gen(function* () {
      const saving = yield* Deferred.make<void>();
      const allowSave = yield* Deferred.make<void>();
      const actions: string[] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: () => handle(new Promise<never>(() => {}), {
          kill: async () => void actions.push("kill"),
          detach: async () => { actions.push("detach"); return "durable-command"; },
        }),
        files: { write: async () => undefined },
      };
      const fiber = yield* Effect.fork(wrapSandbox(sandbox).exec("work", {
        onSession: () => Deferred.succeed(saving, undefined).pipe(
          Effect.zipRight(Deferred.await(allowSave)),
          Effect.tap(() => Effect.sync(() => { actions.push("saved"); })),
        ),
        detachOnInterrupt: () => true,
      }));
      yield* Deferred.await(saving);
      const shutdown = yield* Effect.fork(Fiber.interrupt(fiber));
      yield* Effect.yieldNow();
      expect(actions).toEqual([]);
      yield* Deferred.succeed(allowSave, undefined);
      yield* Fiber.join(shutdown);
      expect(actions).toEqual(["saved", "detach"]);
    }),
  );

  it.effect("reattaches with retained logs and without fresh command options", () =>
    Effect.gen(function* () {
      const calls: unknown[] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: (target, options) => {
          calls.push({ target, options });
          return handle(Promise.resolve({ exitCode: 0, stdout: "retained", timedOut: false }));
        },
        files: { write: async () => undefined },
      };
      yield* wrapSandbox(sandbox).exec("must not run", { sessionName: "saved", cwd: "/workspace", env: { KEY: "value" } });
      expect(calls).toEqual([{ target: { sessionName: "saved" }, options: {
        resumeFromLastRead: false, onStdout: expect.any(Function), onStderr: expect.any(Function),
      } }]);
    }),
  );

  it.effect("reconnects the same session without launching the command again", () =>
    Effect.gen(function* () {
      const targets: unknown[] = [];
      const cursors: Array<boolean | undefined> = [];
      const saved: string[] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: (target, options) => {
          targets.push(target);
          cursors.push(options.resumeFromLastRead);
          return handle(targets.length === 1
            ? Promise.reject(disconnected("before "))
            : Promise.resolve({ exitCode: 0, stdout: "after", timedOut: false }));
        },
        files: { write: async () => undefined },
      };
      const result = yield* wrapSandbox(sandbox, Schedule.recurs(2)).exec("expensive work", {
        onSession: (name) => Effect.sync(() => { saved.push(name); }),
      });
      expect(targets).toEqual(["expensive work", { sessionName: "durable-command" }]);
      expect(cursors).toEqual([undefined, true]);
      expect(saved).toEqual(["durable-command"]);
      expect(result.stdout).toBe("before after");
    }),
  );

  it.effect("leaves persisted commands recoverable when reconnect attempts are exhausted", () =>
    Effect.gen(function* () {
      const actions: string[] = [];
      const targets: unknown[] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: (target) => {
          targets.push(target);
          return handle(Promise.reject(new RailwayConnectionError({ message: "gateway unavailable" })), {
            kill: async () => void actions.push("kill"),
            detach: async () => { actions.push("detach"); return "saved"; },
          });
        },
        files: { write: async () => undefined },
      };
      const error = yield* Effect.flip(wrapSandbox(sandbox, Schedule.recurs(2)).exec("must not run", { sessionName: "saved" }));
      expect(error.sessionName).toBe("saved");
      expect(targets).toEqual(Array.from({ length: 3 }, () => ({ sessionName: "saved" })));
      expect(actions).toEqual(["detach"]);
    }),
  );

  it.effect("retries transient token API failures when attaching a saved session", () =>
    Effect.gen(function* () {
      const { sandbox, calls } = scriptedSandbox([
        new RailwayGraphQLError({ message: "unavailable", status: 503 }),
        "ok",
      ]);
      yield* wrapSandbox(sandbox, Schedule.recurs(2)).exec("must not run", { sessionName: "saved" });
      expect(calls).toEqual(["saved", "saved"]);
    }),
  );

  it.effect("never retries a fresh command when its session name was lost", () =>
    Effect.gen(function* () {
      const targets: unknown[] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: (target) => {
          targets.push(target);
          return handle(Promise.reject(disconnected()), { sessionName: Promise.reject(disconnected()) });
        },
        files: { write: async () => undefined },
      };
      const error = yield* Effect.flip(wrapSandbox(sandbox, Schedule.recurs(2)).exec("expensive work"));
      expect(error.sessionName).toBeUndefined();
      expect(targets).toEqual(["expensive work"]);
    }),
  );

  it.effect("keeps the original timeout across reconnect attempts and kills the durable command", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const actions: string[] = [];
      let calls = 0;
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: (_target, options) => {
          if (options.onStdout === undefined) {
            return handle(Promise.resolve({ exitCode: -1, stdout: "", timedOut: false }), { kill: async () => void actions.push("kill") });
          }
          calls++;
          Deferred.unsafeDone(started, Effect.void);
          return handle(Promise.reject(disconnected()), { kill: async () => void actions.push("kill") });
        },
        files: { write: async () => undefined },
      };
      const fiber = yield* Effect.fork(wrapSandbox(sandbox, Schedule.spaced("1 second")).exec("work", {
        timeoutSec: 3,
        sessionName: "saved",
        detachOnInterrupt: () => true,
      }));
      yield* Deferred.await(started);
      yield* TestClock.adjust("3 seconds");
      expect((yield* Fiber.join(fiber)).timedOut).toBe(true);
      expect(calls).toBeGreaterThan(1);
      expect(actions).toEqual(["kill"]);
    }),
  );

  it.effect("cancels a saved session and waits for the queued signal before detaching", () =>
    Effect.gen(function* () {
      const signalled = yield* Deferred.make<void>();
      const actions: string[] = [];
      let finish!: (value: ExecResult) => void;
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: (target) => {
          expect(target).toEqual({ sessionName: "saved" });
          return handle(new Promise<ExecResult>((resolve) => { finish = resolve; }), {
            kill: async () => { actions.push("kill"); Deferred.unsafeDone(signalled, Effect.void); return true; },
            detach: async () => { actions.push("detach"); return "saved"; },
          });
        },
        files: { write: async () => undefined },
      };
      const fiber = yield* Effect.fork(wrapSandbox(sandbox).stopSession("saved"));
      yield* Deferred.await(signalled);
      expect(actions).toEqual(["kill"]);
      finish({ exitCode: -1, stdout: "", timedOut: false });
      yield* Fiber.join(fiber);
      expect(actions).toEqual(["kill", "detach"]);
    }),
  );

  it.effect("stops an expired saved command before attaching to its output", () =>
    Effect.gen(function* () {
      const targets: unknown[] = [];
      const actions: string[] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: (target, options) => {
          targets.push(target);
          expect(options).toEqual({});
          return handle(Promise.resolve({ exitCode: -1, stdout: "", timedOut: false }), {
            kill: async () => void actions.push("kill"),
          });
        },
        files: { write: async () => undefined },
      };
      const result = yield* wrapSandbox(sandbox).exec("must not run", { sessionName: "saved", timeoutSec: 0 });
      expect(result.timedOut).toBe(true);
      expect(targets).toEqual([{ sessionName: "saved" }]);
      expect(actions).toEqual(["kill"]);
      yield* wrapSandbox(sandbox).exec("also must not run", { timeoutSec: 0 });
      expect(targets).toHaveLength(1);
    }),
  );

  it.effect("bounds cancellation of an unreachable saved session", () =>
    Effect.gen(function* () {
      const signalled = yield* Deferred.make<void>();
      const actions: string[] = [];
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: () => handle(new Promise<never>(() => {}), {
          kill: async () => { Deferred.unsafeDone(signalled, Effect.void); return true; },
          detach: async () => { actions.push("detach"); return "saved"; },
        }),
        files: { write: async () => undefined },
      };
      const fiber = yield* Effect.fork(Effect.flip(wrapSandbox(sandbox).stopSession("saved")));
      yield* Deferred.await(signalled);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(fiber)).message).toBe("Timed out stopping command saved");
      expect(actions).toEqual(["detach"]);
    }),
  );

  it.effect("treats explicitly missing sessions as already stopped but retains permission failures", () =>
    Effect.gen(function* () {
      for (const reason of ["Durable session not found", "Session 'saved' does not exist", "Permission denied"]) {
        const sandbox: SandboxLike = {
          id: "sbx",
          exec: () => handle(Promise.reject(new ExecInterruptedError({ closeCode: 1008, reason, stdout: "", stderr: "" }))),
          files: { write: async () => undefined },
        };
        const result = yield* Effect.either(wrapSandbox(sandbox).stopSession("saved"));
        expect(result._tag).toBe(reason === "Permission denied" ? "Left" : "Right");
      }
    }),
  );

  it.effect("keeps untracked commands compatible with servers without durable sessions", () =>
    Effect.gen(function* () {
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: () => handle(Promise.resolve({ exitCode: 0, stdout: "file contents", timedOut: false }), {
          sessionName: Promise.reject(new Error("Server did not return a durable session for this exec.")),
        }),
        files: { write: async () => undefined },
      };
      expect((yield* wrapSandbox(sandbox).exec("cat file")).stdout).toBe("file contents");
      const error = yield* Effect.flip(wrapSandbox(sandbox).exec("tracked work", { onSession: () => Effect.void }));
      expect(error.message).toContain("Could not identify command session");
    }),
  );

  it.effect("does not report a timeout as handled when the saved command could not be stopped", () =>
    Effect.gen(function* () {
      const sandbox: SandboxLike = {
        id: "sbx",
        exec: () => handle(Promise.reject(new RailwayConnectionError({ message: "gateway unavailable" }))),
        files: { write: async () => undefined },
      };
      const error = yield* Effect.flip(wrapSandbox(sandbox).exec("must not run", { sessionName: "saved", timeoutSec: 0 }));
      expect(error.cause).toBeInstanceOf(RailwayConnectionError);
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
