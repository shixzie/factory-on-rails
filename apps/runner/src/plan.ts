/** Pure helpers that decide what runs inside a sandbox. Kept free of I/O so they are easy to test. */

export const WORKSPACE = "/workspace";
export const REPO_DIR = `${WORKSPACE}/repo`;
export const TASK_FILE = `${WORKSPACE}/TASK.md`;
export const COMMIT_MSG_FILE = `${WORKSPACE}/COMMIT_MSG`;
export const NO_CHANGES_MARKER = "FACTORY_NO_CHANGES";

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
  ].join("\n");
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
