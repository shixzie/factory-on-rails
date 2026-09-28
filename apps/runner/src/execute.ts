import { GitHubAppApi, GitHubError, Store, type RunRow } from "@factory/core";
import { Data, Duration, Effect, Option, Redacted, Schedule } from "effect";
import { ASK_USER_TOOL, makeAgentStream } from "./agent-stream.js";
import { agentToolEnv, agentToolFiles, deliverMessageScript } from "./agent-tools.js";
import type { AgentSettings } from "./config.js";
import {
  AGENT_RAN_FILE,
  branchName,
  capPatch,
  cloneScript,
  diffScript,
  COMMIT_MSG_FILE,
  followUpPrompt,
  HAS_SESSION_MARKER,
  networkCheckScript,
  RECOVERY_CONSOLE_BANNER,
  WORKFLOWS_PERMISSION_REFUSAL,
  commitMessage,
  NO_CHANGES_MARKER,
  publishScript,
  pullRequestBody,
  REPO_DIR,
  resumeScript,
  summarizeTask,
  TASK_FILE,
  TOKEN_FILE,
  UP_TO_DATE_MARKER,
  withHome,
} from "./plan.js";
import type { RunLog } from "./run-log.js";
import { Sandboxes, type ExecOptions, type SandboxHandle } from "./sandbox.js";

/** Where this turn's sandbox came from. */
type SandboxOrigin = "kept" | "restored" | "new";

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
  /** How often the user's new messages are handed to the running agent. */
  readonly inboxEvery?: Duration.DurationInput;
  /** How often the diff is refreshed while the agent works after a tool call (and every 10 ticks regardless). */
  readonly diffEvery?: Duration.DurationInput;
}

/**
 * The sandbox for this turn: the one the last turn left running, a new one
 * booted from the checkpoint of a stopped one, or a fresh one.
 */
const acquireSandbox = (run: RunRow, env: Record<string, string>, log: RunLog) =>
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    if (run.sandbox_state === "running" && run.sandbox_id) {
      const id = run.sandbox_id;
      const kept = yield* sandboxes.connect(id).pipe(
        Effect.catchAll((err) =>
          // It may still exist; don't pay for two.
          Effect.zipRight(Effect.ignore(sandboxes.destroy(id)), Effect.as(log.info(err.message), Option.none<SandboxHandle>())),
        ),
      );
      if (Option.isSome(kept)) {
        yield* log.info(`Continuing in sandbox ${id}`);
        return { sandbox: kept.value, origin: "kept" as SandboxOrigin };
      }
      yield* log.info("The sandbox from the last turn is gone, so this turn starts a new one");
    }
    if (run.sandbox_state === "stopped" && run.sandbox_checkpoint_name) {
      yield* log.info("Resuming the stopped sandbox");
      const restored = yield* sandboxes.restore(run.sandbox_checkpoint_name, env).pipe(Effect.either);
      if (restored._tag === "Right") return { sandbox: restored.right, origin: "restored" as SandboxOrigin };
      yield* log.info(`${restored.left.message}. Starting a new sandbox from the branch instead`);
    }
    yield* log.info("Creating Railway sandbox");
    return { sandbox: yield* sandboxes.create(env), origin: "new" as SandboxOrigin };
  });

/** Opens the run's pull request, or finds it already open from an earlier turn. */
const openPullRequest = (run: RunRow, token: Redacted.Redacted<string>, branch: string, harnessUrl: Option.Option<string>) =>
  Effect.flatMap(GitHubAppApi, (github) =>
    github.createPullRequest(token, run.repo_full_name, {
      title: summarizeTask(run.task),
      body: pullRequestBody({
        task: run.task,
        runId: run.id,
        runUrl: Option.getOrUndefined(Option.map(harnessUrl, (url) => `${url}/runs/${run.id}`)),
      }),
      head: branch,
      base: run.base_branch,
    }),
  ).pipe(
    Effect.map((pr) => ({ url: pr.html_url, opened: true })),
    // GitHub refuses a second PR for the branch while the first is open. A
    // merged or closed one doesn't count, so new work gets a new PR.
    Effect.catchIf(
      (err: GitHubError) => err.status === 422 && run.pull_request_url !== null && /already exists/i.test(JSON.stringify(err.body ?? err.message)),
      () => Effect.succeed({ url: run.pull_request_url!, opened: false }),
    ),
  );

/**
 * One turn of a run, inside a scope that owns its sandbox. The first turn
 * does the task; each later one answers the messages the user sent since.
 * The sandbox is left running for the next turn once it holds the checkout;
 * the runner stops it when it sits idle (see worker.ts).
 */
const work = (run: RunRow, { log, agent, git, harnessUrl, inboxEvery = "2 seconds", diffEvery = "3 seconds" }: ExecuteOptions) =>
  Effect.gen(function* () {
    const sandboxes = yield* Sandboxes;
    const github = yield* GitHubAppApi;
    const store = yield* Store;
    const branch = branchName(run.id);
    const followUp = run.turns > 1;
    // What the user said since the agent last heard from them: this turn's task.
    const pending = followUp ? yield* store.listUserMessages(run.id, Number(run.delivered_message_id)) : [];

    const permissions = { contents: "write", pull_requests: "write", metadata: "read" } as const;
    const tokenFor = (extra: Record<string, "write"> = {}) =>
      github.installationToken(Number(run.installation_id), {
        repositories: [run.repo_full_name.split("/")[1]!],
        permissions: { ...permissions, ...extra },
      });
    // Workflows lets the agent change .github/workflows. GitHub answers 422 when
    // the App was never granted it; the run then goes ahead without it.
    const token = yield* tokenFor({ workflows: "write" }).pipe(
      Effect.catchIf(
        (err) => err.status === 422,
        () =>
          log
            .info("The GitHub App has no Workflows permission, so this run can't change files in .github/workflows")
            .pipe(Effect.zipRight(tokenFor())),
      ),
    );
    log.addSecret(Redacted.value(token));

    // Kept for the next turn once it holds the checkout; destroyed if it never gets that far.
    let keep = false;
    const { sandbox, origin } = yield* Effect.acquireRelease(acquireSandbox(run, { ...agent.env, IS_SANDBOX: "1" }, log), ({ sandbox }) =>
      keep
        ? Effect.void
        : sandboxes.destroy(sandbox.id).pipe(
            Effect.zipRight(store.updateRun(run.id, { sandbox_state: "deleted" })),
            Effect.zipRight(log.info("Sandbox destroyed")),
            Effect.catchAll((err) => log.error(err.message)),
          ),
    );
    yield* store.updateRun(run.id, {
      sandbox_id: sandbox.id,
      branch,
      sandbox_state: "running",
      sandbox_checkpoint_id: null,
      sandbox_checkpoint_name: null,
    });
    if (origin !== "kept") yield* log.info(`Sandbox ${sandbox.id} is running`);
    if (run.sandbox_checkpoint_id) {
      // Booted from it (or gave up on it); either way it has served its purpose.
      yield* sandboxes.deleteCheckpoint(run.sandbox_checkpoint_id).pipe(
        Effect.catchAll((err) => Effect.logWarning(err.message)),
      );
    }

    const step = (label: string, command: string, opts: ExecOptions = {}) =>
      Effect.gen(function* () {
        yield* log.info(label);
        let offline = false;
        let workflowsRefused = false;
        const onOutput = opts.onOutput ?? log.push;
        const result = yield* sandbox.exec(withHome(command), {
          ...opts,
          onOutput: (stream, chunk) => {
            if (chunk.includes(RECOVERY_CONSOLE_BANNER)) offline = true;
            if (chunk.includes(WORKFLOWS_PERMISSION_REFUSAL)) workflowsRefused = true;
            onOutput(stream, chunk);
          },
        });
        if (offline && result.exitCode !== 0) {
          return yield* new StepFailed({
            message: `${label}: the Railway sandbox has no outbound network (it started in Railway's recovery console). Try the run again.`,
          });
        }
        if (workflowsRefused && result.exitCode !== 0) {
          return yield* new StepFailed({
            message: `${label}: GitHub refused the push because the agent changed a file in .github/workflows and the GitHub App has no Workflows permission. Give the App "Workflows: Read and write", accept it on the installation, then run again.`,
          });
        }
        if (result.timedOut) return yield* new StepFailed({ message: `${label}: timed out after ${opts.timeoutSec}s` });
        if (result.exitCode !== 0) return yield* new StepFailed({ message: `${label}: exited with code ${result.exitCode}` });
        return result;
      });

    yield* sandbox.writeFile(TOKEN_FILE, Redacted.value(token), 0o600);
    yield* step("Checking the sandbox can reach GitHub", networkCheckScript({ repo: run.repo_full_name }));
    let continuing = false;
    if (origin === "new") {
      yield* step(
        followUp ? `Cloning ${run.repo_full_name}@${branch}` : `Cloning ${run.repo_full_name}@${run.base_branch}`,
        cloneScript({ repo: run.repo_full_name, baseBranch: run.base_branch, branch, ...git }),
      );
    } else {
      const resumed = yield* step("Picking up where the last turn left off", resumeScript({ repo: run.repo_full_name }));
      continuing = resumed.stdout.includes(HAS_SESSION_MARKER);
    }
    keep = true;

    const messages = pending.map((m) => m.message);
    const prompt = followUp
      ? followUpPrompt({ task: run.task, messages: messages.length > 0 ? messages : ["Carry on."], continuing })
      : run.task;
    yield* sandbox.writeFile(TASK_FILE, prompt);
    yield* sandbox.writeFile(COMMIT_MSG_FILE, commitMessage(messages[0] ?? run.task, run.id));
    for (const [path, content] of agentToolFiles()) yield* sandbox.writeFile(path, content);

    yield* step("Preparing the agent", agent.setupCommand);

    // What the agent is doing, as the run page shows it: its stream parsed into
    // events, the questions it is waiting on, and whether files may have changed.
    const asking = new Set<string>();
    let filesMayHaveChanged = false;
    const stream = makeAgentStream({
      event: (e) => {
        if (e.kind === "tool_call" && e.data?.name === ASK_USER_TOOL) asking.add(String(e.data.id));
        if (e.kind === "tool_result") {
          asking.delete(String(e.data?.toolUseId));
          filesMayHaveChanged = true;
        }
        log.push(e.kind, e.message, e.data);
      },
      output: log.push,
    });

    // Hands the user's messages to the agent (see agent-tools.ts) and keeps
    // `awaiting_input` in step with the agent's open questions.
    let delivered = Number(pending.at(-1)?.id ?? run.delivered_message_id);
    let awaiting = false;
    const syncInbox = Effect.gen(function* () {
      for (const message of yield* store.listUserMessages(run.id, delivered)) {
        const result = yield* sandbox.exec(withHome(deliverMessageScript(message.id.padStart(16, "0"))), {
          env: { FACTORY_MESSAGE: JSON.stringify({ text: message.message, at: message.at }) },
          timeoutSec: 30,
        });
        if (result.exitCode !== 0) return;
        delivered = Number(message.id);
        yield* store.updateRun(run.id, { delivered_message_id: String(delivered) });
      }
      if (asking.size > 0 !== awaiting) {
        awaiting = asking.size > 0;
        yield* store.updateRun(run.id, { awaiting_input: awaiting });
      }
    }).pipe(Effect.catchAllCause((cause) => Effect.logWarning("Could not deliver messages to the agent", cause)));

    // Stores the run's diff when it changed, so the page can show files as they change.
    let lastPatch = "";
    const snapshotDiff = Effect.gen(function* () {
      const result = yield* sandbox.exec(withHome(diffScript()), { timeoutSec: 60 });
      if (result.exitCode !== 0) return;
      const { patch, truncated } = capPatch(log.redact(result.stdout));
      if (patch === lastPatch) return;
      lastPatch = patch;
      yield* store.saveDiff(run.id, patch, truncated);
    }).pipe(
      Effect.timeout("90 seconds"),
      Effect.catchAllCause((cause) => Effect.logWarning("Could not record the run's diff", cause)),
    );

    const inboxLoop = Effect.forever(Effect.zipRight(Effect.sleep(inboxEvery), syncInbox));
    const diffLoop = Effect.gen(function* () {
      for (let tick = 1; ; tick++) {
        yield* Effect.sleep(diffEvery);
        if (filesMayHaveChanged || tick % 10 === 0) {
          filesMayHaveChanged = false;
          yield* snapshotDiff;
        }
      }
    });

    // From here the agent has this turn's messages; later ones go through the inbox.
    if (pending.length > 0) yield* store.updateRun(run.id, { delivered_message_id: String(delivered) });
    yield* sandbox.writeFile(AGENT_RAN_FILE, run.id);

    yield* Effect.gen(function* () {
      yield* Effect.forkScoped(inboxLoop);
      yield* Effect.forkScoped(diffLoop);
      yield* step(continuing ? "Continuing the agent's session" : "Running the agent", agent.command, {
        cwd: REPO_DIR,
        env: {
          ...agentToolEnv(),
          FACTORY_TASK_FILE: TASK_FILE,
          FACTORY_RUN_ID: run.id,
          // The default AGENT_COMMAND passes --continue when this is set.
          ...(continuing ? { FACTORY_CONTINUE: "1" } : {}),
        },
        timeoutSec: agent.timeoutSec,
        onOutput: stream.write,
      }).pipe(Effect.ensuring(Effect.sync(stream.end)));
    }).pipe(
      Effect.scoped,
      // Whatever happened, record where the files ended up.
      Effect.ensuring(snapshotDiff),
      Effect.ensuring(Effect.when(store.updateRun(run.id, { awaiting_input: false }).pipe(Effect.ignore), () => awaiting)),
    );

    const published = yield* step("Committing and pushing", publishScript({ baseBranch: run.base_branch, branch }));
    const existing = run.pull_request_url ?? undefined;
    if (published.stdout.includes(NO_CHANGES_MARKER)) {
      yield* log.info("The agent made no changes, so there is nothing to open a PR for");
      return { status: "succeeded", pullRequestUrl: existing } as const;
    }
    if (published.stdout.includes(UP_TO_DATE_MARKER)) {
      yield* log.info("No new changes this turn");
      return { status: "succeeded", pullRequestUrl: existing } as const;
    }

    if (!existing) yield* log.info("Opening pull request");
    const pr = yield* openPullRequest(run, token, branch, harnessUrl);
    if (pr.url !== existing) yield* store.updateRun(run.id, { pull_request_url: pr.url });
    yield* log.info(pr.opened ? `Opened ${pr.url}` : `Pushed the changes to ${pr.url}`);
    return { status: "succeeded", pullRequestUrl: pr.url } as const;
  }).pipe(
    // Logged before the scope closes, so the log reads "error" then "Sandbox destroyed".
    Effect.tapError((err) => log.error(err.message)),
    Effect.scoped,
  );

/**
 * Drives one turn of a run end to end: sandbox up (or back), clone, agent,
 * push, PR. Never fails; every error becomes a `failed` outcome. A heartbeat
 * runs alongside the work, and when it sees the run was cancelled the work is
 * interrupted, which kills the command in the sandbox.
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
