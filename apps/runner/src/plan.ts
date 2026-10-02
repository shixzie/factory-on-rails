/** Pure helpers that decide what runs inside a sandbox. Kept free of I/O so they are easy to test. */

export const WORKSPACE = "/workspace";
export const REPO_DIR = `${WORKSPACE}/repo`;
export const TASK_FILE = `${WORKSPACE}/TASK.md`;
export const COMMIT_MSG_FILE = `${WORKSPACE}/COMMIT_MSG`;
export const NO_CHANGES_MARKER = "FACTORY_NO_CHANGES";
/** Printed by the publish script when the branch on GitHub already has every commit. */
export const UP_TO_DATE_MARKER = "FACTORY_UP_TO_DATE";
/** Printed by the resume script when the agent has run in this sandbox before, so it can continue its session. */
export const HAS_SESSION_MARKER = "FACTORY_HAS_SESSION";
/** Outside the repo: the agent's tools, its inbox and the base commit (see agent-tools.ts). */
export const FACTORY_DIR = `${WORKSPACE}/.factory`;
export const BASE_SHA_FILE = `${FACTORY_DIR}/base-sha`;
/**
 * The repo-scoped installation token, rewritten at the start of every turn
 * because it expires after an hour and a sandbox can outlive that. Every
 * command exports it as GH_TOKEN, and git reads it through a credential
 * helper, so it is never baked into the sandbox env or `.git/config`.
 */
export const TOKEN_FILE = `${FACTORY_DIR}/gh-token`;
/** The preview agent and its `tunnel` grant (see packages/core/src/preview.ts), rewritten every turn. */
export const PREVIEW_AGENT_FILE = `${FACTORY_DIR}/preview-agent.mjs`;
export const PREVIEW_TOKEN_FILE = `${FACTORY_DIR}/preview-token`;
const PREVIEW_PID_FILE = `${FACTORY_DIR}/preview-agent.pid`;
const PREVIEW_LOG_FILE = `${FACTORY_DIR}/preview-agent.log`;
/** Written when the agent starts, so a later turn knows there is a session to continue. */
export const AGENT_RAN_FILE = `${FACTORY_DIR}/agent-ran`;
/** What the agent is asked when it writes the pull request (see describePrompt). */
export const DESCRIBE_FILE = `${FACTORY_DIR}/describe-prompt.md`;
/** Where the agent's pull request title and description land. */
export const PR_FILE = `${FACTORY_DIR}/pull-request.md`;
/** Where blobs wait for the runner to copy them out as previews (see media.ts); cleared every time. */
export const MEDIA_DIR = `${FACTORY_DIR}/media`;
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
 * and git refuses `--global` config (and the agent CLI its config dir) without
 * it. It also exports the current GitHub token (see TOKEN_FILE).
 */
export function withHome(command: string): string {
  return [
    'export HOME="${HOME:-/root}"',
    `if [ -r ${TOKEN_FILE} ]; then export GH_TOKEN="$(cat ${TOKEN_FILE})"; fi`,
    command,
  ].join("\n");
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

/** Git asks this for credentials and gets the token from TOKEN_FILE, whatever its age. */
export const CREDENTIAL_HELPER = `!f() { if [ "$1" = get ]; then echo username=x-access-token; echo "password=$(cat ${TOKEN_FILE})"; fi; }; f`;

const repoUrl = (repo: string) => `https://github.com/${repo}.git`;

/**
 * Clones the repository into a new sandbox. The run's branch is checked out
 * from GitHub when an earlier turn pushed it (the sandbox that had it is gone),
 * otherwise it is started from the base branch.
 */
export function cloneScript(p: { repo: string; baseBranch: string; branch: string; authorName: string; authorEmail: string }): string {
  const branch = shellQuote(p.branch);
  const base = shellQuote(`origin/${p.baseBranch}`);
  return [
    "set -eu",
    `git config --global user.name ${shellQuote(p.authorName)}`,
    `git config --global user.email ${shellQuote(p.authorEmail)}`,
    `git config --global credential.helper ${shellQuote(CREDENTIAL_HELPER)}`,
    `git clone --depth 50 --branch ${shellQuote(p.baseBranch)} ${repoUrl(p.repo)} ${REPO_DIR}`,
    `cd ${REPO_DIR}`,
    `mkdir -p ${FACTORY_DIR}/inbox ${FACTORY_DIR}/delivered`,
    `if git fetch -q --depth 50 origin ${shellQuote(`refs/heads/${p.branch}:refs/remotes/origin/${p.branch}`)} 2>/dev/null; then`,
    `  git checkout -q -b ${branch} ${shellQuote(`origin/${p.branch}`)}`,
    `  git merge-base HEAD ${base} > ${BASE_SHA_FILE} 2>/dev/null || git rev-parse ${base} > ${BASE_SHA_FILE}`,
    "else",
    `  git checkout -b ${branch}`,
    `  git rev-parse HEAD > ${BASE_SHA_FILE}`,
    "fi",
  ].join("\n");
}

/**
 * Picks a kept sandbox back up for the next turn: its checkout is as the last
 * turn left it. Points git at the credential helper (a sandbox from before it
 * existed has a token in its remote URL) and says whether the agent has a
 * session here to continue.
 */
export function resumeScript(p: { repo: string }): string {
  return [
    "set -eu",
    `git config --global credential.helper ${shellQuote(CREDENTIAL_HELPER)}`,
    `cd ${REPO_DIR}`,
    `git remote set-url origin ${repoUrl(p.repo)}`,
    `mkdir -p ${FACTORY_DIR}/inbox ${FACTORY_DIR}/delivered`,
    `if [ -f ${AGENT_RAN_FILE} ]; then echo ${HAS_SESSION_MARKER}; fi`,
  ].join("\n");
}

/** Run before a sandbox is checkpointed, so the saved disk holds no token. */
export const SCRUB_SCRIPT = [
  `rm -f ${TOKEN_FILE} ${PREVIEW_TOKEN_FILE} ${FACTORY_DIR}/mcp.json ${FACTORY_DIR}/codex-config`,
  // A saved auth document is restored from encrypted storage next turn. Do
  // not bake it into a Railway checkpoint (or remove snapshot-only auth).
  'if [ -n "${CODEX_AUTH_JSON:-}" ]; then rm -f "$HOME/.codex/auth.json"; fi',
].join("\n");

/** Installs a saved ChatGPT device-login document where Codex reads it. */
export const CODEX_AUTH_SCRIPT = [
  'if [ -n "${CODEX_AUTH_JSON:-}" ]; then',
  '  mkdir -p "$HOME/.codex"',
  '  printf %s "$CODEX_AUTH_JSON" > "$HOME/.codex/auth.json"',
  '  chmod 600 "$HOME/.codex/auth.json"',
  "fi",
].join("\n");

/**
 * Starts the preview agent in the background, detached from the exec session
 * so it keeps running between turns (it replaces one left by an earlier turn).
 * A background process doesn't count as sandbox activity, so it never keeps
 * an idle sandbox up.
 */
export function previewAgentScript(tunnelUrl: string): string {
  return [
    "set -eu",
    `export FACTORY_PREVIEW_URL=${shellQuote(tunnelUrl)}`,
    `export FACTORY_PREVIEW_TOKEN_FILE=${PREVIEW_TOKEN_FILE}`,
    `export FACTORY_PREVIEW_PID_FILE=${PREVIEW_PID_FILE}`,
    "detach=; if command -v setsid >/dev/null 2>&1; then detach=setsid; fi",
    `$detach nohup node ${PREVIEW_AGENT_FILE} > ${PREVIEW_LOG_FILE} 2>&1 < /dev/null &`,
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
    // Full blob ids let the run page ask for a changed image by the id in the patch.
    `git diff --cached --no-color --no-ext-diff --no-textconv --find-renames --full-index "$(cat ${BASE_SHA_FILE})"`,
  ].join("\n");
}

/**
 * Lists the files in the last diff snapshot with their blob ids, from the
 * index `diffScript` left behind, as `git diff --raw -z`.
 */
export function changedFilesScript(): string {
  return [
    "set -eu",
    `cd ${REPO_DIR}`,
    `export GIT_INDEX_FILE=${FACTORY_DIR}/diff-index`,
    `git diff --cached --raw -z --no-abbrev --find-renames "$(cat ${BASE_SHA_FILE})"`,
  ].join("\n");
}

/**
 * Copies blobs out of git into MEDIA_DIR for the runner to read, skipping any
 * over `maxBytes`, and prints `<sha> <size>` for each blob that exists.
 */
export function extractBlobsScript(shas: ReadonlyArray<string>, maxBytes: number): string {
  if (shas.some((sha) => !/^[0-9a-f]{40}$/.test(sha))) throw new Error("Invalid blob id");
  return [
    "set -eu",
    `cd ${REPO_DIR}`,
    `rm -rf ${MEDIA_DIR}`,
    `mkdir -p ${MEDIA_DIR}`,
    `for sha in ${shas.join(" ")}; do`,
    `  size=$(git cat-file -s "$sha" 2>/dev/null) || continue`,
    `  if [ "$size" -le ${maxBytes} ]; then git cat-file blob "$sha" > ${MEDIA_DIR}/"$sha"; fi`,
    `  echo "$sha $size"`,
    "done",
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

/**
 * Commits anything the agent left uncommitted, then pushes if the branch has
 * commits GitHub doesn't (a later turn pushes to the same branch).
 */
export function publishScript(p: { baseBranch: string; branch: string }): string {
  const remote = shellQuote(`refs/remotes/origin/${p.branch}`);
  return [
    "set -eu",
    `cd ${REPO_DIR}`,
    "git add -A",
    `git diff --cached --quiet || git commit -q -F ${COMMIT_MSG_FILE}`,
    `if [ "$(git rev-list --count ${shellQuote(`origin/${p.baseBranch}`)}..HEAD)" = "0" ]; then echo ${NO_CHANGES_MARKER}; exit 0; fi`,
    `if [ "$(git rev-parse HEAD)" = "$(git rev-parse -q --verify ${remote} || true)" ]; then echo ${UP_TO_DATE_MARKER}; exit 0; fi`,
    `git push -q origin ${shellQuote(`HEAD:refs/heads/${p.branch}`)}`,
    `git update-ref ${remote} HEAD`,
  ].join("\n");
}

/**
 * What the agent is asked on a turn after the first. With its earlier session
 * to continue, the user's new messages are enough; in a new sandbox it also
 * needs the original task, and is told the earlier work is on the branch.
 */
export function followUpPrompt(p: { task: string; messages: ReadonlyArray<string>; continuing: boolean }): string {
  const messages = p.messages.join("\n\n");
  if (p.continuing) return messages;
  return [
    "You are continuing an earlier task in this repository. The work done so far is committed on the current branch.",
    "",
    "## The original task",
    "",
    p.task.trim(),
    "",
    "## What the user asks now",
    "",
    messages,
  ].join("\n");
}

export function commitMessage(task: string, runId: string): string {
  return `${summarizeTask(task)}\n\nFactory run ${runId}\n`;
}

/** GitHub's own limit on a pull request title. */
const MAX_TITLE = 256;
/** Keeps a description a reviewer will read; the prompt asks for far less. */
export const MAX_DESCRIPTION = 12_000;

/**
 * What the run's agent is asked once its work is pushed: the pull request's
 * title and description, as its whole reply. It continues its own session,
 * so it knows why it did what it did, and it reads the final diff for what
 * actually changed. On a later turn the PR already exists and the new text
 * replaces the old, so it covers the whole branch, not only the new commits.
 */
export function describePrompt(p: { baseBranch: string; existing: boolean }): string {
  const base = shellQuote(`origin/${p.baseBranch}`);
  return [
    p.existing
      ? "Your work is pushed, and this branch already has a pull request from an earlier round. Write its title and description again so they cover everything the branch changes now, not only this latest round."
      : "Your work is pushed. Now write the title and description of the pull request for it.",
    "",
    `First look at what the branch changes: \`git log --oneline ${base}..HEAD\` and \`git diff --stat ${base}...HEAD\`, then \`git diff ${base}...HEAD\` for the parts you need to describe accurately. Don't change any files.`,
    "",
    "Reply with the pull request and nothing else, no preamble and no code fence:",
    "",
    "- Line 1 is the title: under 72 characters, imperative mood, specific about what changes (\"Retry sandbox exec while the sandbox is still starting\", not \"Fix bug\" or \"Update files\"). Use a prefix like \"feat:\" only if the repository's commit history does.",
    "- Then a blank line, then the description in GitHub Markdown.",
    "",
    "If the repository has a pull request template (.github/pull_request_template.md, .github/PULL_REQUEST_TEMPLATE.md, a file in .github/PULL_REQUEST_TEMPLATE/, PULL_REQUEST_TEMPLATE.md or docs/pull_request_template.md), use its headings and fill in each section. Otherwise use this shape:",
    "",
    "1. One or two sentences on what changes and why, for someone who hasn't seen the task.",
    "2. `## Changes`: one bullet per meaningful change, naming the files, modules or behaviour involved. Group small related edits into one bullet.",
    "3. `## How to verify`: the commands to run or the behaviour to check, including tests you added or ran and their result.",
    "4. `## Notes`: assumptions you made, anything left undone, follow-ups or risks. Leave the section out when there is nothing to say.",
    "",
    "Be detailed but not verbose. Each line should tell a reviewer something the diff doesn't make obvious at a glance. Aim for under 250 words, more only for a large change. Don't restate the task word for word, narrate your attempts, or pad with filler.",
  ].join("\n");
}

/**
 * The agent's reply read as a pull request: its first line (without a
 * heading mark, "Title:" or quotes) as the title and the rest as the
 * description. Undefined when there is no usable title.
 */
export function parsePullRequest(text: string): { title: string; description: string } | undefined {
  let lines = text.replace(/\r\n?/g, "\n").trim().split("\n");
  // A reply wrapped in a code fence despite the prompt.
  if (/^```/.test(lines[0] ?? "") && /^```\s*$/.test(lines.at(-1) ?? "")) lines = lines.slice(1, -1);
  const start = lines.findIndex((l) => l.trim() !== "");
  if (start < 0) return undefined;
  const title = lines[start]!
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/^title:\s*/i, "")
    .replace(/^(["'`])(.*)\1$/, "$2")
    .trim();
  if (!title) return undefined;
  let description = lines.slice(start + 1).join("\n").trim();
  if (description.length > MAX_DESCRIPTION) description = `${description.slice(0, MAX_DESCRIPTION).trimEnd()}\n\n…`;
  return { title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title, description };
}

/**
 * The pull request description: the agent's own when it wrote one, then a
 * footer linking the run with the task folded away; without one, the task.
 */
export function pullRequestBody(p: { task: string; runId: string; runUrl?: string; description?: string }): string {
  const link = p.runUrl ? `[${p.runId}](${p.runUrl})` : p.runId;
  if (!p.description) return `Opened by Factory on Rails, run ${link}.\n\n### Task\n\n${p.task.trim()}\n`;
  return [
    p.description.trim(),
    "",
    "---",
    "",
    `Opened by Factory on Rails, run ${link}.`,
    "",
    "<details><summary>Task</summary>",
    "",
    p.task.trim(),
    "",
    "</details>",
    "",
  ].join("\n");
}
