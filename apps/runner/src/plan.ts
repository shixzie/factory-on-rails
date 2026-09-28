/** Pure helpers that decide what runs inside a sandbox. Kept free of I/O so they are easy to test. */

export const WORKSPACE = "/workspace";
export const REPO_DIR = `${WORKSPACE}/repo`;
export const TASK_FILE = `${WORKSPACE}/TASK.md`;
export const COMMIT_MSG_FILE = `${WORKSPACE}/COMMIT_MSG`;
export const NO_CHANGES_MARKER = "FACTORY_NO_CHANGES";
/** Outside the repo: the agent's tools, its inbox and the base commit (see agent-tools.ts). */
export const FACTORY_DIR = `${WORKSPACE}/.factory`;
export const BASE_SHA_FILE = `${FACTORY_DIR}/base-sha`;
/** Largest diff stored per run; bigger ones are cut at a file boundary. */
export const MAX_DIFF_BYTES = 1024 * 1024;

/** POSIX single-quote escaping. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function branchName(runId: string): string {
  return `factory/run-${runId.slice(0, 8)}`;
}

export function summarizeTask(task: string, max = 72): string {
  const first = task.trim().split("\n")[0]!.trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** Part of git's push error when the App token can't touch `.github/workflows`. */
export const WORKFLOWS_PERMISSION_REFUSAL = "without `workflows` permission";

/** Printed by Railway when a sandbox VM boots without outbound network. */
export const RECOVERY_CONSOLE_BANNER = "Railway recovery console";

/**
 * Every step runs through this. Railway's exec can start a shell without HOME,
 * and git refuses `--global` config (and the agent CLI its config dir) without it.
 */
export function withHome(command: string): string {
  return `export HOME="\${HOME:-/root}"\n${command}`;
}

/**
 * Waits until the sandbox can reach the repo on GitHub, so a sandbox without
 * outbound network fails with a clear message instead of a git error mid-clone.
 */
export function networkCheckScript(p: { repo: string; attempts?: number; delaySec?: number }): string {
  const attempts = p.attempts ?? 12;
  return [
    `for i in $(seq 1 ${attempts}); do`,
    `  git ls-remote "https://x-access-token:$GH_TOKEN@github.com/${p.repo}.git" HEAD >/dev/null 2>&1 && exit 0`,
    `  sleep ${p.delaySec ?? 5}`,
    "done",
    `echo "Cannot reach github.com/${p.repo} from the sandbox" >&2`,
    "exit 1",
  ].join("\n");
}

/**
 * Clones with the repo-scoped installation token, which is baked into the
 * sandbox env as GH_TOKEN at create time (so it never appears in `ps`).
 */
export function cloneScript(p: { repo: string; baseBranch: string; branch: string; authorName: string; authorEmail: string }): string {
  return [
    "set -eu",
    `git config --global user.name ${shellQuote(p.authorName)}`,
    `git config --global user.email ${shellQuote(p.authorEmail)}`,
    `git clone --depth 50 --branch ${shellQuote(p.baseBranch)} "https://x-access-token:$GH_TOKEN@github.com/${p.repo}.git" ${REPO_DIR}`,
    `cd ${REPO_DIR}`,
    `git checkout -b ${shellQuote(p.branch)}`,
    `mkdir -p ${FACTORY_DIR}/inbox ${FACTORY_DIR}/delivered`,
    `git rev-parse HEAD > ${BASE_SHA_FILE}`,
  ].join("\n");
}

/**
 * Prints everything the run changed since the base commit (commits and
 * uncommitted work, new files included) as one unified diff. It stages into a
 * throwaway index so the agent's own index, and any git command it is
 * running, is never touched.
 */
export function diffScript(): string {
  return [
    "set -eu",
    `cd ${REPO_DIR}`,
    `export GIT_INDEX_FILE=${FACTORY_DIR}/diff-index`,
    `cp .git/index "$GIT_INDEX_FILE" 2>/dev/null || git read-tree HEAD`,
    "git add -A",
    `git diff --cached --no-color --no-ext-diff --no-textconv --find-renames "$(cat ${BASE_SHA_FILE})"`,
  ].join("\n");
}

/** Keeps a patch under `maxBytes` by dropping whole files from the end. */
export function capPatch(patch: string, maxBytes = MAX_DIFF_BYTES): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch) <= maxBytes) return { patch, truncated: false };
  let cut = patch.slice(0, maxBytes);
  while (Buffer.byteLength(cut) > maxBytes) cut = cut.slice(0, -1024);
  const lastFile = cut.lastIndexOf("\ndiff --git ");
  return { patch: lastFile > 0 ? cut.slice(0, lastFile + 1) : "", truncated: true };
}

/** Commits anything the agent left uncommitted, then pushes if the branch moved. */
export function publishScript(p: { baseBranch: string; branch: string }): string {
  return [
    "set -eu",
    `cd ${REPO_DIR}`,
    "git add -A",
    `git diff --cached --quiet || git commit -q -F ${COMMIT_MSG_FILE}`,
    `if [ "$(git rev-list --count ${shellQuote(`origin/${p.baseBranch}`)}..HEAD)" = "0" ]; then echo ${NO_CHANGES_MARKER}; exit 0; fi`,
    `git push -q origin ${shellQuote(`HEAD:refs/heads/${p.branch}`)}`,
  ].join("\n");
}

export function commitMessage(task: string, runId: string): string {
  return `${summarizeTask(task)}\n\nFactory run ${runId}\n`;
}

export function pullRequestBody(p: { task: string; runId: string; runUrl?: string }): string {
  const link = p.runUrl ? `[${p.runId}](${p.runUrl})` : p.runId;
  return `Opened by Factory on Rails, run ${link}.\n\n### Task\n\n${p.task.trim()}\n`;
}
