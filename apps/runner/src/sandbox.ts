import { Config, Context, Data, Duration, Effect, Layer, Option, Redacted, Schedule } from "effect";
import { ExecInterruptedError, Sandbox } from "railway";

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
  readonly writeFile: (path: string, content: string) => Effect.Effect<void, SandboxError>;
}

/** Railway sandboxes, one per run. */
export class Sandboxes extends Context.Tag("@factory/Sandboxes")<
  Sandboxes,
  {
    readonly create: (env: Record<string, string>) => Effect.Effect<SandboxHandle, SandboxError>;
    readonly destroy: (id: string) => Effect.Effect<void, SandboxError>;
  }
>() {
  static readonly Live = Layer.effect(
    Sandboxes,
    Effect.gen(function* () {
      const config = yield* SandboxConfig;
      const auth = {
        // An env-scoped project token for the `agents` environment. Kept separate
        // from RAILWAY_TOKEN so the runner can never touch its own environment.
        token: Redacted.value(config.token),
        authType: "project-token" as const,
        environmentId: config.environmentId,
      };
      const destroy = (id: string) =>
        attempt(`Could not destroy sandbox ${id}`, async () => (await Sandbox.connect(id, auth)).destroy());
      return {
        create: (env) =>
          attempt("Could not create a sandbox", () => {
            const options = {
              ...auth,
              env,
              region: Option.getOrUndefined(config.region),
              idleTimeoutMinutes: config.idleTimeoutMinutes,
              // Agents get internet egress but no route to the factory's own services or database.
              networkIsolation: "ISOLATED" as const,
            };
            return Option.match(config.checkpoint, {
              onNone: () => Sandbox.create(options),
              onSome: (checkpoint) => Sandbox.create(checkpoint, options),
            });
          }).pipe(
            // Don't leak a sandbox that never starts taking commands.
            Effect.tap((sandbox) => waitUntilReady(sandbox).pipe(Effect.tapError(() => Effect.ignore(destroy(sandbox.id))))),
            Effect.map(wrapSandbox),
          ),
        destroy,
      };
    }),
  );
}

export const SandboxConfig = Config.all({
  token: Config.redacted("RAILWAY_SANDBOX_TOKEN"),
  environmentId: Config.string("SANDBOX_ENVIRONMENT_ID"),
  region: Config.option(Config.nonEmptyString("SANDBOX_REGION")),
  /** Boot from a named checkpoint (e.g. one with the agent CLI preinstalled) instead of a blank sandbox. */
  checkpoint: Config.option(Config.nonEmptyString("SANDBOX_CHECKPOINT")),
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
  readonly files: { write(path: string, content: string): Promise<unknown> };
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
  writeFile: (path, content) => attempt(`Could not write ${path}`, () => sandbox.files.write(path, content)).pipe(Effect.asVoid),
});
