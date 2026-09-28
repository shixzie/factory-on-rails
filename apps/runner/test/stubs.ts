import { GitHubAppApi, Store, type RunEvent, type RunStatus, type StoreService } from "@factory/core";
import { Effect, Layer, Option, Redacted } from "effect";
import { SandboxError, Sandboxes, type ExecResult, type SandboxHandle } from "../src/sandbox.js";

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
  const layer = stubStore({
    appendEvents: (_runId, batch) => Effect.sync(() => void events.push(...batch)),
    updateRun: (_runId, patch) => Effect.sync(() => void updates.push(patch)),
    heartbeat: () => Effect.sync(() => Option.some(status())),
  });
  return { events, updates, layer };
};

export const fakeGitHub = (calls: unknown[][] = []) =>
  Layer.succeed(GitHubAppApi, {
    installationToken: (...args) =>
      Effect.sync(() => {
        calls.push(["installationToken", ...args]);
        return Redacted.make("ghs_repo_token");
      }),
    createPullRequest: (token, repo, pr) =>
      Effect.sync(() => {
        calls.push(["createPullRequest", Redacted.value(token), repo, pr]);
        return { number: 1, html_url: "https://github.com/shixzie/demo/pull/1" };
      }),
  });

export interface FakeSandbox {
  commands: string[];
  createdWith?: Record<string, string>;
  destroyed: boolean;
  killed: boolean;
}

/**
 * Sandboxes whose commands succeed unless `results` has an entry for a
 * substring of the command; `hang` names a command that never finishes.
 */
export const fakeSandboxes = (
  results: Record<string, Partial<ExecResult>> = {},
  { hang, failCreate }: { hang?: string; failCreate?: string } = {},
) => {
  const state: FakeSandbox = { commands: [], destroyed: false, killed: false };
  const handle: SandboxHandle = {
    id: "sbx_1",
    exec: (command) => {
      state.commands.push(command);
      if (hang && command.includes(hang)) {
        return Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (state.killed = true))));
      }
      const key = Object.keys(results).find((k) => command.includes(k));
      return Effect.succeed({ exitCode: 0, stdout: "", timedOut: false, ...(key ? results[key] : {}) });
    },
    writeFile: () => Effect.void,
  };
  const layer = Layer.succeed(Sandboxes, {
    create: (env) =>
      failCreate
        ? Effect.fail(new SandboxError({ message: failCreate }))
        : Effect.sync(() => {
            state.createdWith = env;
            return handle;
          }),
    destroy: () => Effect.sync(() => void (state.destroyed = true)),
  });
  return { state, layer };
};
