import { Cause, Config, Context, Data, Duration, Effect, Exit, Layer, Option, Redacted, Schedule } from "effect";
import { InstanceSettings } from "@factory/core";
import { ExecInterruptedError, RailwayConnectionError, RailwayGraphQLError, Sandbox, SandboxNotFoundError, type ExecOptions as RailwayExecOptions, type ExecTarget } from "railway";

export class SandboxError extends Data.TaggedError("SandboxError")<{
  message: string;
  cause?: unknown;
  /** A persisted command still exists and can be recovered after transport retries fail. */
  sessionName?: string;
}> {}

export interface ExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutSec?: number;
  /** Called synchronously with each chunk of output as it streams. */
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Attach to this saved command instead of starting another one. */
  readonly sessionName?: string;
  /** Save a fresh command's session before accepting its result or detaching. */
  readonly onSession?: (name: string) => Effect.Effect<void, SandboxError>;
  /** Preserve a saved command during runner shutdown; cancellation should return false. */
  readonly detachOnInterrupt?: () => boolean;
}

/** A running sandbox. Interruption kills commands unless durable detachment was requested. */
export interface SandboxHandle {
  readonly id: string;
  readonly exec: (command: string, options?: ExecOptions) => Effect.Effect<ExecResult, SandboxError>;
  /** Cancel a saved command, including one this runner has not reattached to yet. */
  readonly stopSession: (sessionName: string) => Effect.Effect<void, SandboxError>;
  /** `mode` defaults to 0644; secrets go in with 0600. */
  readonly writeFile: (path: string, content: string | Uint8Array, mode?: number) => Effect.Effect<void, SandboxError>;
}

/** A saved copy of a sandbox's disk, which a new sandbox can boot from. */
export interface Checkpoint {
  readonly id: string;
  readonly name: string;
}

/**
 * Railway sandboxes, one per run. Railway has no stop and start for a sandbox,
 * so "stopping" one is `checkpoint` then `destroy`, and resuming it is
 * `restore` from that checkpoint: files survive, running processes do not.
 */
export class Sandboxes extends Context.Tag("@factory/Sandboxes")<
  Sandboxes,
  {
    /**
     * A new sandbox, booted from `snapshot` (a prepared checkpoint) when given,
     * else from SANDBOX_CHECKPOINT when set, else blank.
     */
    readonly create: (env: Record<string, string>, snapshot?: string) => Effect.Effect<SandboxHandle, SandboxError>;
    /** Boots a new sandbox from a checkpoint taken with `checkpoint`. */
    readonly restore: (checkpointName: string, env: Record<string, string>) => Effect.Effect<SandboxHandle, SandboxError>;
    /** The sandbox, if it still exists and is running. */
    readonly connect: (id: string) => Effect.Effect<Option.Option<SandboxHandle>, SandboxError>;
    readonly checkpoint: (id: string, name: string) => Effect.Effect<Checkpoint, SandboxError>;
    /** A sandbox that is already gone counts as destroyed. */
    readonly destroy: (id: string) => Effect.Effect<void, SandboxError>;
    readonly deleteCheckpoint: (id: string) => Effect.Effect<void, SandboxError>;
  }
>() {
  static readonly Live = Layer.effect(
    Sandboxes,
    Effect.gen(function* () {
      const config = yield* SandboxConfig;
      const settings = yield* InstanceSettings;
      // Where sandboxes go, read per call: the setup page can create the environment while the runner is up.
      const target = Effect.flatMap(settings.sandboxTarget, Option.match({
        onNone: () =>
          Effect.fail(new SandboxError({ message: "Sandboxes are not set up yet: finish setup on the factory's /setup page." })),
        onSome: (t) =>
          Effect.succeed({
            // An env-scoped project token for the `agents` environment. Kept separate
            // from RAILWAY_TOKEN so the runner can never touch its own environment.
            token: Redacted.value(t.token),
            authType: "project-token" as const,
            environmentId: t.environmentId,
          }),
      }));
      type Auth = Effect.Effect.Success<typeof target>;
      /** Runs an SDK call with the current credentials. */
      const withAuth = <A>(context: string, f: (auth: Auth) => Promise<A>) =>
        Effect.flatMap(target, (auth) => attempt(context, () => f(auth)));

      const destroy = (id: string) =>
        withAuth(`Could not destroy sandbox ${id}`, async (auth) => {
          try {
            await (await Sandbox.connect(id, auth)).destroy();
          } catch (cause) {
            if (!(cause instanceof SandboxNotFoundError)) throw cause;
          }
        });
      // A sandbox from a checkpoint boots in the region the checkpoint was
      // captured in, and asking for another one is an error, so the region only
      // goes with a blank sandbox. (Snapshots made with the CLI are in us-west2.)
      const options = (auth: Auth, env: Record<string, string>, fromCheckpoint: boolean) => ({
        ...auth,
        env,
        region: fromCheckpoint ? undefined : Option.getOrUndefined(config.region),
        // Railway's own backstop: it destroys a sandbox left idle this long (the runner stops them sooner).
        idleTimeoutMinutes: config.idleTimeoutMinutes,
        // Agents get internet egress but no route to the factory's own services or database.
        networkIsolation: "ISOLATED" as const,
      });
      const boot = (context: string, create: (auth: Auth) => Promise<Sandbox>) =>
        withAuth(context, create).pipe(
          // Don't leak a sandbox that never starts taking commands.
          Effect.tap((sandbox) => waitUntilReady(sandbox).pipe(Effect.tapError(() => Effect.ignore(destroy(sandbox.id))))),
          Effect.map(wrapSandbox),
        );
      return {
        create: (env, snapshot) => {
          const from = snapshot ?? Option.getOrUndefined(config.checkpoint);
          return from === undefined
            ? boot("Could not create a sandbox", (auth) => Sandbox.create(options(auth, env, false)))
            : boot(`Could not create a sandbox from snapshot ${from}`, (auth) => Sandbox.create(from, options(auth, env, true)));
        },
        restore: (checkpointName, env) =>
          boot(`Could not start the sandbox from checkpoint ${checkpointName}`, (auth) =>
            Sandbox.create(checkpointName, options(auth, env, true)),
          ),
        connect: (id) =>
          withAuth(`Could not reach sandbox ${id}`, async (auth) => {
            try {
              const sandbox = await Sandbox.connect(id, auth);
              return sandbox.status === "RUNNING" ? Option.some(wrapSandbox(sandbox)) : Option.none();
            } catch (cause) {
              if (cause instanceof SandboxNotFoundError) return Option.none();
              throw cause;
            }
          }),
        checkpoint: (id, name) =>
          withAuth(`Could not checkpoint sandbox ${id}`, async (auth) => {
            const { id: checkpointId, key } = await (await Sandbox.connect(id, auth)).checkpoint(name);
            return { id: checkpointId, name: key };
          }),
        destroy,
        deleteCheckpoint: (id) =>
          withAuth(`Could not delete checkpoint ${id}`, async (auth) => {
            try {
              await Sandbox.deleteCheckpoint(id, auth);
            } catch (cause) {
              // One that is already gone counts as deleted.
              if ((await Sandbox.checkpoints(auth)).some((c) => c.id === id)) throw cause;
            }
          }),
      };
    }),
  );
}

/**
 * How sandboxes are created. Where they go (RAILWAY_SANDBOX_TOKEN and
 * SANDBOX_ENVIRONMENT_ID, or what the setup page stored) comes from `InstanceSettings`.
 */
export const SandboxConfig = Config.all({
  region: Config.option(Config.nonEmptyString("SANDBOX_REGION")),
  /** Boot from a named checkpoint (e.g. one with the agent CLI preinstalled) instead of a blank sandbox. */
  checkpoint: Config.option(Config.nonEmptyString("SANDBOX_CHECKPOINT")),
  /** Railway's idle timeout: a backstop in case no runner is around to stop an idle sandbox. */
  idleTimeoutMinutes: Config.integer("SANDBOX_IDLE_TIMEOUT_MINUTES").pipe(Config.withDefault(15)),
});

/**
 * `Sandbox.create` resolves once the API reports RUNNING, but the exec gateway
 * can still see the sandbox as CREATING for a moment and closes the session
 * with 1008 before running anything. That refusal is safe to retry.
 */
export const isStillStarting = (cause: unknown): boolean =>
  cause instanceof ExecInterruptedError && cause.closeCode === 1008 && /status: CREATING/.test(cause.message);

const READY_SCHEDULE = Schedule.exponential("250 millis").pipe(
  Schedule.either(Schedule.spaced("2 seconds")),
  Schedule.upTo(Duration.minutes(2)),
);

/** Runs a no-op until the sandbox accepts commands, so the first real step never races its startup. */
export const waitUntilReady = (sandbox: SandboxLike, schedule: Schedule.Schedule<unknown, SandboxError> = READY_SCHEDULE) =>
  attempt(`Sandbox ${sandbox.id} did not start accepting commands`, async () => sandbox.exec("true", {})).pipe(
    Effect.retry({ schedule, while: (err) => isStillStarting(err.cause) }),
    Effect.asVoid,
  );

const attempt = <A>(context: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) =>
      new SandboxError({ message: `${context}: ${cause instanceof Error ? cause.message : String(cause)}`, cause }),
  });

/** The slice of the SDK's `Sandbox` that `wrapSandbox` uses. */
export interface SandboxLike {
  readonly id: string;
  exec(command: ExecTarget, options: RailwayExecOptions): SandboxExecHandle;
  readonly files: { write(path: string, content: string | Uint8Array, options?: { mode?: number }): Promise<unknown> };
}

interface SandboxExecHandle extends PromiseLike<ExecResult> {
  readonly sessionName: Promise<string>;
  kill(signal?: "TERM" | "KILL"): Promise<unknown>;
  detach(): Promise<string>;
}

const RECONNECT_SCHEDULE = Schedule.exponential("250 millis").pipe(Schedule.intersect(Schedule.recurs(5)));
const isLostConnection = (cause: unknown) =>
  (cause instanceof RailwayConnectionError && cause.closeCode !== 1008) ||
  (cause instanceof RailwayGraphQLError && (cause.status === 429 || cause.status >= 500));

const isMissingSession = (cause: unknown) => {
  if (!(cause instanceof ExecInterruptedError) || cause.closeCode !== 1008) return false;
  // The SDK embeds the gateway's reason in its message. Match explicit missing
  // session responses only: 1008 also covers permission and policy failures.
  const reason = /\(code 1008: (.*?)\)\. The command/s.exec(cause.message)?.[1]?.trim();
  return reason !== undefined && (
    /^(?:durable(?: exec)? |exec )?session(?: ["'][^"']+["'])? (?:not found|does not exist|(?:has )?expired)(?:: .+)?[.!]?$/i.test(reason) ||
    /^unknown (?:durable(?: exec)? |exec )?session(?:: .+)?[.!]?$/i.test(reason)
  );
};

const stopSession = (sandbox: SandboxLike, sessionName: string) => Effect.acquireUseRelease(
  Effect.try({
    try: () => sandbox.exec({ sessionName }, {}),
    catch: (cause) => new SandboxError({ message: `Could not attach to command ${sessionName} to cancel it`, cause }),
  }),
  (handle) => Effect.gen(function* () {
    const result = Promise.resolve(handle).then(() => undefined, (cause: unknown) => { throw cause; });
    // Signal may be queued until the connection opens; wait for its exit rather
    // than detaching immediately and discarding the SDK's queued signal.
    void result.catch(() => undefined);
    const sent = yield* attempt(`Could not cancel command ${sessionName}`, () => handle.kill("TERM"));
    if (sent === false) return yield* Effect.fail(new SandboxError({ message: `Could not signal command ${sessionName}`, sessionName }));
    yield* attempt(`Could not confirm command ${sessionName} stopped`, () => result).pipe(
      Effect.timeoutFail({ duration: "10 seconds", onTimeout: () => new SandboxError({ message: `Timed out stopping command ${sessionName}`, sessionName }) }),
    );
  }),
  (handle) => Effect.promise(() => handle.detach().catch(() => undefined)),
).pipe(Effect.catchIf((error) => isMissingSession(error.cause), () => Effect.void));

export const wrapSandbox = (
  sandbox: SandboxLike,
  reconnectSchedule: Schedule.Schedule<unknown, SandboxError> = RECONNECT_SCHEDULE,
): SandboxHandle => ({
  id: sandbox.id,
  exec: (command, { onOutput, onSession, sessionName, detachOnInterrupt, timeoutSec, cwd, env } = {}) =>
    Effect.suspend(() => {
      let current: SandboxExecHandle | undefined;
      let knownSession = sessionName;
      let persisted = sessionName !== undefined;
      let disconnected = false;
      let attempts = 0;
      let priorStdout = "";
      let streamedStdout = "";

      const stop = (detach: boolean) => Effect.gen(function* () {
        if (current === undefined) {
          if (!detach && knownSession !== undefined) yield* stopSession(sandbox, knownSession);
          return;
        }
        if (detach) {
          yield* Effect.promise(() => current!.detach().catch(() => undefined));
        } else {
          if (disconnected && knownSession !== undefined) {
            yield* stopSession(sandbox, knownSession);
            return;
          }
          const killed = yield* Effect.promise(() => current!.kill("TERM").catch(() => false));
          // A disconnected handle cannot send signals. Attach to the same command
          // to cancel it; never launch the original command again.
          if (killed === false && knownSession !== undefined) {
            yield* stopSession(sandbox, knownSession);
          }
        }
      });

      const run = Effect.gen(function* () {
        const handle = yield* Effect.try({
          try: () => sandbox.exec(knownSession === undefined ? command : { sessionName: knownSession }, {
            ...(knownSession === undefined ? { cwd, env } : { resumeFromLastRead: attempts > 0 }),
            onStdout: (chunk) => { streamedStdout += chunk; onOutput?.("stdout", chunk); },
            onStderr: (chunk) => onOutput?.("stderr", chunk),
          }),
          catch: (cause) => new SandboxError({ message: `Command failed to run: ${String(cause)}`, cause }),
        });
        current = handle;
        disconnected = false;
        attempts++;
        // Observe both promises immediately: a fast command can finish (or lose
        // its connection) before the database finishes saving its session.
        const outcome = Promise.resolve(handle).then(
          (value) => ({ ok: true as const, value }),
          (cause: unknown) => { disconnected = true; return { ok: false as const, cause }; },
        );
        if (knownSession === undefined) {
          const name = yield* attempt("Could not identify command session", () => handle.sessionName).pipe(
            Effect.catchIf(
              (error) => onSession === undefined && error.cause instanceof Error &&
                error.cause.message === "Server did not return a durable session for this exec.",
              () => Effect.succeed(undefined),
            ),
          );
          knownSession = name;
          if (onSession !== undefined && name !== undefined) {
            yield* onSession(name).pipe(
              Effect.tap(() => Effect.sync(() => { persisted = true; })),
              Effect.uninterruptible,
            );
          }
        }
        const result = yield* Effect.promise(() => outcome);
        if (!result.ok) {
          if (result.cause instanceof ExecInterruptedError) priorStdout += result.cause.stdout;
          return yield* Effect.fail(new SandboxError({ message: `Command failed to run: ${String(result.cause)}`, cause: result.cause }));
        }
        return { ...result.value, stdout: priorStdout + result.value.stdout };
      }).pipe(
        Effect.retry({ schedule: reconnectSchedule, while: (error) => knownSession !== undefined && isLostConnection(error.cause) }),
        Effect.mapError((error) => persisted && knownSession !== undefined && isLostConnection(error.cause)
          ? new SandboxError({ message: error.message, cause: error.cause, sessionName: knownSession })
          : error),
      );

      // The SDK's timeout closes its socket. Explicitly signal the durable
      // process instead, using one deadline across every reconnect attempt.
      const timed = timeoutSec === undefined ? run : timeoutSec <= 0
        ? stop(false).pipe(Effect.as({ exitCode: null, stdout: "", timedOut: true }))
        : run.pipe(
        Effect.timeoutOption(Duration.seconds(timeoutSec)),
        Effect.flatMap(Option.match({
          onSome: Effect.succeed,
          onNone: () => stop(false).pipe(Effect.as({ exitCode: null, stdout: streamedStdout, timedOut: true })),
        })),
      );
      return timed.pipe(Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return Effect.void;
        const error = Cause.failureOption(exit.cause);
        const recoverable = Option.isSome(error) && error.value.sessionName !== undefined;
        const shuttingDown = Cause.isInterrupted(exit.cause) && persisted && detachOnInterrupt?.() === true;
        // A finalizer cannot fail the interrupted fiber. The cancellation path
        // verifies saved sessions separately before marking the run cancelled.
        return stop(recoverable || shuttingDown).pipe(Effect.catchAll((error) => Effect.logWarning(error.message)));
      }));
    }),
  stopSession: (sessionName) => stopSession(sandbox, sessionName),
  writeFile: (path, content, mode) =>
    attempt(`Could not write ${path}`, () => sandbox.files.write(path, content, mode === undefined ? undefined : { mode })).pipe(
      Effect.asVoid,
    ),
});
