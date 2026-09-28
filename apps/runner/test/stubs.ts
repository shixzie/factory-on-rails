import { GitHubAppApi, GitHubError, Store, type RunEvent, type RunEventRow, type RunStatus, type StoreService } from "@factory/core";
import { Effect, Layer, Option, Redacted } from "effect";
import { SandboxError, Sandboxes, type ExecOptions, type ExecResult, type SandboxHandle } from "../src/sandbox.js";

/** A Store with only the given methods; anything else dies loudly. */
export const stubStore = (impl: Partial<StoreService>) =>
  Layer.succeed(
    Store,
    new Proxy(impl, {
      get: (target, key) =>
        key in target ? target[key as keyof StoreService] : () => Effect.die(`Store.${String(key)} is not stubbed`),
    }) as StoreService,
  );

/** Records what a run writes to the store; `status` is what heartbeats report. */
export const recordingStore = (status: () => RunStatus = () => "running") => {
  const events: RunEvent[] = [];
  const updates: object[] = [];
  const diffs: { patch: string; truncated: boolean }[] = [];
  /** Messages the user "sent"; the runner reads them with listUserMessages. */
  const userMessages: RunEventRow[] = [];
  const layer = stubStore({
    appendEvents: (_runId, batch) => Effect.sync(() => void events.push(...batch)),
    updateRun: (_runId, patch) => Effect.sync(() => void updates.push(patch)),
    heartbeat: () => Effect.sync(() => Option.some(status())),
    listUserMessages: (_runId, afterId) => Effect.sync(() => userMessages.filter((m) => Number(m.id) > afterId)),
    saveDiff: (_runId, patch, truncated) => Effect.sync(() => void diffs.push({ patch, truncated })),
  });
  return { events, updates, diffs, userMessages, layer };
};

/**
 * `grantedPermissions` mimics the App's settings: asking for anything else gets
 * GitHub's 422. `prOpen` makes GitHub refuse a second PR for the branch.
 */
export const fakeGitHub = (
  calls: unknown[][] = [],
  { grantedPermissions, prOpen = false }: { grantedPermissions?: string[]; prOpen?: boolean } = {},
) =>
  Layer.succeed(GitHubAppApi, {
    installationToken: (...args) =>
      Effect.suspend(() => {
        calls.push(["installationToken", ...args]);
        const requested = Object.keys(args[1].permissions ?? {});
        if (grantedPermissions && requested.some((p) => !grantedPermissions.includes(p))) {
          return Effect.fail(new GitHubError({ status: 422, message: "The permissions requested are not granted to this installation." }));
        }
        return Effect.succeed(Redacted.make("ghs_repo_token"));
      }),
    createPullRequest: (token, repo, pr) =>
      Effect.suspend(() => {
        calls.push(["createPullRequest", Redacted.value(token), repo, pr]);
        return prOpen
          ? Effect.fail(
              new GitHubError({
                status: 422,
                message: "Validation Failed",
                body: { errors: [{ message: `A pull request already exists for shixzie:${pr.head}.` }] },
              }),
            )
          : Effect.succeed({ number: 1, html_url: "https://github.com/shixzie/demo/pull/1" });
      }),
  });

/** A command that streams output as it goes, e.g. an agent. */
export type Scripted = (onOutput: NonNullable<ExecOptions["onOutput"]>) => Effect.Effect<Partial<ExecResult>>;

export interface FakeSandbox {
  commands: string[];
  /** The env each command ran with, in the same order as `commands`. */
  envs: (Record<string, string> | undefined)[];
  files: Record<string, string>;
  modes: Record<string, number | undefined>;
  createdWith?: Record<string, string>;
  /** The checkpoint name a sandbox was booted from. */
  restoredFrom?: string;
  /** Sandboxes that exist right now, by id. */
  alive: Set<string>;
  /** Checkpoints that exist right now: id to name. */
  checkpoints: Map<string, string>;
  destroyedIds: string[];
  deletedCheckpoints: string[];
  destroyed: boolean;
  killed: boolean;
}

/**
 * Sandboxes whose commands succeed unless `results` has an entry for a
 * substring of the command; `hang` names a command that never finishes.
 * `create` makes sbx_1 (then sbx_2, ...), `restore` makes sbx_restored.
 */
export const fakeSandboxes = (
  results: Record<string, Partial<ExecResult> | Effect.Effect<Partial<ExecResult>> | Scripted> = {},
  {
    hang,
    failCreate,
    failRestore,
    failCheckpoint,
    alive = [],
    checkpoints = {},
  }: {
    hang?: string;
    failCreate?: string;
    failRestore?: string;
    failCheckpoint?: string;
    alive?: string[];
    checkpoints?: Record<string, string>;
  } = {},
) => {
  const state: FakeSandbox = {
    commands: [],
    envs: [],
    files: {},
    modes: {},
    alive: new Set(alive),
    checkpoints: new Map(Object.entries(checkpoints)),
    destroyedIds: [],
    deletedCheckpoints: [],
    destroyed: false,
    killed: false,
  };
  const handle = (id: string): SandboxHandle => ({
    id,
    exec: (command, options) => {
      state.commands.push(command);
      state.envs.push(options?.env);
      if (hang && command.includes(hang)) {
        return Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (state.killed = true))));
      }
      const key = Object.keys(results).find((k) => command.includes(k));
      const planned = key ? results[key]! : {};
      const effect =
        typeof planned === "function"
          ? planned(options?.onOutput ?? (() => {}))
          : Effect.isEffect(planned)
            ? planned
            : Effect.succeed(planned);
      return effect.pipe(
        Effect.map((partial) => {
          const result = { exitCode: 0, stdout: "", timedOut: false, ...partial };
          if (result.stdout) options?.onOutput?.("stdout", result.stdout);
          return result;
        }),
      );
    },
    writeFile: (path, content, mode) =>
      Effect.sync(() => {
        state.files[path] = content;
        state.modes[path] = mode;
      }),
  });
  let created = 0;
  let checkpointed = 0;
  const layer = Layer.succeed(Sandboxes, {
    create: (env) =>
      failCreate
        ? Effect.fail(new SandboxError({ message: failCreate }))
        : Effect.sync(() => {
            state.createdWith = env;
            const id = `sbx_${++created}`;
            state.alive.add(id);
            return handle(id);
          }),
    restore: (name, env) =>
      failRestore || ![...state.checkpoints.values()].includes(name)
        ? Effect.fail(new SandboxError({ message: failRestore ?? `No checkpoint ${name}` }))
        : Effect.sync(() => {
            state.createdWith = env;
            state.restoredFrom = name;
            state.alive.add("sbx_restored");
            return handle("sbx_restored");
          }),
    connect: (id) => Effect.sync(() => (state.alive.has(id) ? Option.some(handle(id)) : Option.none())),
    checkpoint: (_id, name) =>
      failCheckpoint
        ? Effect.fail(new SandboxError({ message: failCheckpoint }))
        : Effect.sync(() => {
            const id = `cp_${++checkpointed}`;
            state.checkpoints.set(id, name);
            return { id, name };
          }),
    destroy: (id) =>
      Effect.sync(() => {
        state.alive.delete(id);
        state.destroyedIds.push(id);
        state.destroyed = true;
      }),
    deleteCheckpoint: (id) =>
      Effect.sync(() => {
        state.checkpoints.delete(id);
        state.deletedCheckpoints.push(id);
      }),
  });
  return { state, layer };
};
