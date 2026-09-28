import { GitHubAppApi, Store, type RunRow } from "@factory/core";
import { Data, Duration, Effect, Option, Redacted, Schedule } from "effect";
import type { AgentSettings } from "./config.js";
import {
  branchName,
  cloneScript,
  COMMIT_MSG_FILE,
  networkCheckScript,
  RECOVERY_CONSOLE_BANNER,
  commitMessage,
  NO_CHANGES_MARKER,
  publishScript,
  pullRequestBody,
  REPO_DIR,
  summarizeTask,
  TASK_FILE,
  withHome,
} from "./plan.js";
import type { RunLog } from "./run-log.js";
import { Sandboxes, type ExecOptions, type SandboxHandle } from "./sandbox.js";

export class StepFailed extends Data.TaggedError("StepFailed")<{ message: string }> {}
class Cancelled extends Data.TaggedError("Cancelled") {}

export type RunOutcome =
  | { status: "succeeded"; pullRequestUrl?: string }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

export interface ExecuteOptions {
  readonly log: RunLog;
  /** Agent settings plus the env (the user's own keys) every sandbox gets. */
  readonly agent: Omit<AgentSettings, "passthroughEnv"> & { readonly env: Record<string, string> };
  readonly git: { readonly authorName: string; readonly authorEmail: string };
  readonly harnessUrl: Option.Option<string>;
  readonly heartbeatEvery?: Duration.DurationInput;
}

/** Everything a run does, inside a scope that owns its sandbox. */
const work = (run: RunRow, { log, agent, git, harnessUrl }: ExecuteOptions) =>
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    const github = yield* GitHubAppApi;
    const store = yield* Store;
    const branch = branchName(run.id);

    const token = yield* github.installationToken(Number(run.installation_id), {
      repositories: [run.repo_full_name.split("/")[1]!],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });
    log.addSecret(Redacted.value(token));

    yield* log.info("Creating Railway sandbox");
    const sandbox: SandboxHandle = yield* Effect.acquireRelease(
      sandboxes.create({ ...agent.env, GH_TOKEN: Redacted.value(token), IS_SANDBOX: "1" }),
      (sbx) =>
        sandboxes.destroy(sbx.id).pipe(
          Effect.zipRight(log.info("Sandbox destroyed")),
          Effect.catchAll((err) => log.error(err.message)),
        ),
    );
    yield* store.updateRun(run.id, { sandbox_id: sandbox.id, branch });
    yield* log.info(`Sandbox ${sandbox.id} is running`);

    const step = (label: string, command: string, opts: Omit<ExecOptions, "onOutput"> = {}) =>
      Effect.gen(function* () {
        yield* log.info(label);
        let offline = false;
        const result = yield* sandbox.exec(withHome(command), {
          ...opts,
          onOutput: (stream, chunk) => {
            if (chunk.includes(RECOVERY_CONSOLE_BANNER)) offline = true;
            log.push(stream, chunk);
          },
        });
        if (offline && result.exitCode !== 0) {
          return yield* new StepFailed({
            message: `${label}: the Railway sandbox has no outbound network (it started in Railway's recovery console). Try the run again.`,
          });
        }
        if (result.timedOut) return yield* new StepFailed({ message: `${label}: timed out after ${opts.timeoutSec}s` });
        if (result.exitCode !== 0) return yield* new StepFailed({ message: `${label}: exited with code ${result.exitCode}` });
        return result;
      });

    yield* step("Checking the sandbox can reach GitHub", networkCheckScript({ repo: run.repo_full_name }));
    yield* step(
      `Cloning ${run.repo_full_name}@${run.base_branch}`,
      cloneScript({ repo: run.repo_full_name, baseBranch: run.base_branch, branch, ...git }),
    );
    yield* sandbox.writeFile(TASK_FILE, run.task);
    yield* sandbox.writeFile(COMMIT_MSG_FILE, commitMessage(run.task, run.id));

    yield* step("Preparing the agent", agent.setupCommand);
    yield* step("Running the agent", agent.command, {
      cwd: REPO_DIR,
      env: { FACTORY_TASK_FILE: TASK_FILE, FACTORY_RUN_ID: run.id },
      timeoutSec: agent.timeoutSec,
    });

    const published = yield* step("Committing and pushing", publishScript({ baseBranch: run.base_branch, branch }));
    if (published.stdout.includes(NO_CHANGES_MARKER)) {
      yield* log.info("The agent made no changes, so there is nothing to open a PR for");
      return { status: "succeeded" } as const;
    }

    yield* log.info("Opening pull request");
    const pr = yield* github.createPullRequest(token, run.repo_full_name, {
      title: summarizeTask(run.task),
      body: pullRequestBody({
        task: run.task,
        runId: run.id,
        runUrl: Option.getOrUndefined(Option.map(harnessUrl, (url) => `${url}/runs/${run.id}`)),
      }),
      head: branch,
      base: run.base_branch,
    });
    yield* store.updateRun(run.id, { pull_request_url: pr.html_url });
    yield* log.info(`Opened ${pr.html_url}`);
    return { status: "succeeded", pullRequestUrl: pr.html_url } as const;
  }).pipe(
    // Logged before the scope closes, so the log reads "error" then "Sandbox destroyed".
    Effect.tapError((err) => log.error(err.message)),
    Effect.scoped,
  );

/**
 * Drives one run end to end: sandbox up, clone, agent, push, PR, sandbox down.
 * Never fails; every error becomes a `failed` outcome. A heartbeat runs
 * alongside the work, and when it sees the run was cancelled the work is
 * interrupted, which kills the command in the sandbox and destroys it.
 */
export const executeRun = (
  run: RunRow,
  options: ExecuteOptions,
): Effect.Effect<RunOutcome, never, Sandboxes | GitHubAppApi | Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const { log } = options;

    const watchForCancel = store.heartbeat(run.id).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.repeat({
        schedule: Schedule.spaced(options.heartbeatEvery ?? Duration.seconds(10)),
        until: Option.contains("cancelling"),
      }),
      Effect.zipRight(log.info("Cancellation requested, stopping the agent")),
      Effect.zipRight(Effect.fail(new Cancelled())),
    );

    return yield* work(run, options).pipe(
      Effect.raceFirst(watchForCancel),
      Effect.map((outcome): RunOutcome => outcome),
      Effect.catchTag("Cancelled", () =>
        log.info("Run cancelled").pipe(Effect.as<RunOutcome>({ status: "cancelled" })),
      ),
      Effect.catchAll((err) => Effect.succeed<RunOutcome>({ status: "failed", error: err.message })),
    );
  });
