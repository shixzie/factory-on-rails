import type { RunRow, RunStatus } from "@factory/core";
import {
  branchName,
  cloneScript,
  COMMIT_MSG_FILE,
  commitMessage,
  NO_CHANGES_MARKER,
  publishScript,
  pullRequestBody,
  REPO_DIR,
  summarizeTask,
  TASK_FILE,
} from "./plan.js";

/** The slice of the Railway `Sandbox` API a run needs (lets tests substitute a fake). */
export interface ExecResultLike {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export interface ExecHandleLike extends PromiseLike<ExecResultLike> {
  kill(signal?: "TERM" | "KILL"): Promise<unknown>;
}
export interface SandboxLike {
  id: string;
  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutSec?: number;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    },
  ): ExecHandleLike;
  files: { write(path: string, content: string): Promise<unknown> };
  destroy(): Promise<void>;
}

export interface RunDeps {
  createSandbox(env: Record<string, string>): Promise<SandboxLike>;
  mintRepoToken(installationId: number, repoFullName: string): Promise<string>;
  createPullRequest(
    token: string,
    repoFullName: string,
    pr: { title: string; body: string; head: string; base: string },
  ): Promise<string>;
  report: {
    info(message: string): void;
    error(message: string): void;
    output(stream: "stdout" | "stderr", chunk: string): void;
    update(patch: { branch?: string; sandbox_id?: string; pull_request_url?: string }): Promise<void>;
    /** Records liveness and returns the run's current status (used to notice cancellation). */
    heartbeat(): Promise<RunStatus | undefined>;
  };
  agent: { setupCommand: string; command: string; timeoutSec: number; env: Record<string, string> };
  git: { authorName: string; authorEmail: string };
  harnessUrl?: string;
  heartbeatIntervalMs?: number;
}

export type RunOutcome =
  | { status: "succeeded"; pullRequestUrl?: string }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

class Cancelled extends Error {}

/**
 * Drives one run end to end: sandbox up, clone, agent, push, PR, sandbox down.
 * Never throws; every failure becomes a `failed` outcome.
 */
export async function executeRun(run: RunRow, deps: RunDeps): Promise<RunOutcome> {
  const { report } = deps;
  const branch = branchName(run.id);
  let sandbox: SandboxLike | undefined;
  let current: ExecHandleLike | undefined;
  let cancelled = false;

  const beat = setInterval(() => {
    void report.heartbeat().then((status) => {
      if (status === "cancelling" && !cancelled) {
        cancelled = true;
        report.info("Cancellation requested, stopping the agent");
        void current?.kill("TERM");
      }
    }, () => {});
  }, deps.heartbeatIntervalMs ?? 10_000);

  const step = async (label: string, command: string, opts: { cwd?: string; env?: Record<string, string>; timeoutSec?: number } = {}) => {
    if (cancelled) throw new Cancelled();
    report.info(label);
    current = sandbox!.exec(command, {
      ...opts,
      onStdout: (chunk) => report.output("stdout", chunk),
      onStderr: (chunk) => report.output("stderr", chunk),
    });
    const result = await current;
    current = undefined;
    if (cancelled) throw new Cancelled();
    if (result.timedOut) throw new Error(`${label}: timed out after ${opts.timeoutSec}s`);
    if (result.exitCode !== 0) throw new Error(`${label}: exited with code ${result.exitCode}`);
    return result;
  };

  try {
    const installationId = Number(run.installation_id);
    const token = await deps.mintRepoToken(installationId, run.repo_full_name);

    report.info("Creating Railway sandbox");
    sandbox = await deps.createSandbox({ ...deps.agent.env, GH_TOKEN: token, IS_SANDBOX: "1" });
    await report.update({ sandbox_id: sandbox.id, branch });
    report.info(`Sandbox ${sandbox.id} is running`);

    await step(
      `Cloning ${run.repo_full_name}@${run.base_branch}`,
      cloneScript({ repo: run.repo_full_name, baseBranch: run.base_branch, branch, ...deps.git }),
    );
    await sandbox.files.write(TASK_FILE, run.task);
    await sandbox.files.write(COMMIT_MSG_FILE, commitMessage(run.task, run.id));

    await step("Preparing the agent", deps.agent.setupCommand);
    await step("Running the agent", deps.agent.command, {
      cwd: REPO_DIR,
      env: { FACTORY_TASK_FILE: TASK_FILE, FACTORY_RUN_ID: run.id },
      timeoutSec: deps.agent.timeoutSec,
    });

    const published = await step("Committing and pushing", publishScript({ baseBranch: run.base_branch, branch }));
    if (published.stdout.includes(NO_CHANGES_MARKER)) {
      report.info("The agent made no changes, so there is nothing to open a PR for");
      return { status: "succeeded" };
    }

    report.info("Opening pull request");
    const url = await deps.createPullRequest(token, run.repo_full_name, {
      title: summarizeTask(run.task),
      body: pullRequestBody({
        task: run.task,
        runId: run.id,
        runUrl: deps.harnessUrl ? `${deps.harnessUrl}/runs/${run.id}` : undefined,
      }),
      head: branch,
      base: run.base_branch,
    });
    await report.update({ pull_request_url: url });
    report.info(`Opened ${url}`);
    return { status: "succeeded", pullRequestUrl: url };
  } catch (err) {
    if (err instanceof Cancelled || cancelled) {
      report.info("Run cancelled");
      return { status: "cancelled" };
    }
    const message = err instanceof Error ? err.message : String(err);
    report.error(message);
    return { status: "failed", error: message };
  } finally {
    clearInterval(beat);
    if (sandbox) {
      try {
        await sandbox.destroy();
        report.info("Sandbox destroyed");
      } catch (err) {
        report.error(`Could not destroy sandbox ${sandbox.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
