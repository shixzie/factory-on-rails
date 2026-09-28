import { Config, Context, Data, Duration, Effect, Layer, Option, Redacted, Schedule } from "effect";
import { InstanceSettings } from "@factory/core";
import { ExecInterruptedError, Sandbox, SandboxNotFoundError } from "railway";

export class SandboxError extends Data.TaggedError("SandboxError")<{ message: string; cause?: unknown }> {}

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
}

/** A running sandbox. Interrupting `exec` kills the command inside it. */
export interface SandboxHandle {
  readonly id: string;
  readonly exec: (command: string, options?: ExecOptions) => Effect.Effect<ExecResult, SandboxError>;
  /** `mode` defaults to 0644; secrets go in with 0600. */
  readonly writeFile: (path: string, content: string, mode?: number) => Effect.Effect<void, SandboxError>;
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
    readonly create: (env: Record<string, string>) => Effect.Effect<SandboxHandle, SandboxError>;
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
      const options = (auth: Auth, env: Record<string, string>) => ({
        ...auth,
        env,
        region: Option.getOrUndefined(config.region),
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
        create: (env) =>
          boot("Could not create a sandbox", (auth) =>
            Option.match(config.checkpoint, {
              onNone: () => Sandbox.create(options(auth, env)),
              onSome: (checkpoint) => Sandbox.create(checkpoint, options(auth, env)),
            }),
          ),
        restore: (checkpointName, env) =>
          boot(`Could not start the sandbox from checkpoint ${checkpointName}`, (auth) =>
            Sandbox.create(checkpointName, options(auth, env)),
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
  exec(
    command: string,
    options: ExecOptions & { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void },
  ): PromiseLike<ExecResult> & { kill(signal?: "TERM" | "KILL"): Promise<unknown> };
  readonly files: { write(path: string, content: string, options?: { mode?: number }): Promise<unknown> };
}

export const wrapSandbox = (sandbox: SandboxLike): SandboxHandle => ({
  id: sandbox.id,
  exec: (command, { onOutput, ...options } = {}) =>
    Effect.async<ExecResult, SandboxError>((resume) => {
      const handle = sandbox.exec(command, {
        ...options,
        onStdout: (chunk) => onOutput?.("stdout", chunk),
        onStderr: (chunk) => onOutput?.("stderr", chunk),
      });
      handle.then(
        ({ exitCode, stdout, timedOut }) => resume(Effect.succeed({ exitCode, stdout, timedOut })),
        (cause) =>
          resume(Effect.fail(new SandboxError({ message: `Command failed to run: ${String(cause)}`, cause }))),
      );
      // Interruption (a cancelled run, a stopping runner) kills the process group.
      return Effect.promise(() => handle.kill("TERM").catch(() => undefined));
    }),
  writeFile: (path, content, mode) =>
    attempt(`Could not write ${path}`, () => sandbox.files.write(path, content, mode === undefined ? undefined : { mode })).pipe(
      Effect.asVoid,
    ),
});
