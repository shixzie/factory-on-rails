import type { Api } from "./api";

export type PullRequest = Api.ApiRun["pullRequests"][number];

/** Include legacy links too: a missing state must never make a thread disappear. */
export function threadPullRequests(run: Pick<Api.ApiRun, "pullRequestUrl" | "pullRequestUrls" | "pullRequests">): PullRequest[] {
  const states = new Map(run.pullRequests.map((pr) => [pr.url.toLowerCase().replace(/\/$/, ""), pr.state]));
  const urls = new Set([
    ...run.pullRequestUrls,
    ...(run.pullRequestUrl ? [run.pullRequestUrl] : []),
    ...run.pullRequests.map((pr) => pr.url),
  ].map((url) => url.toLowerCase().replace(/\/$/, "")));
  return [...urls].map((url) => ({ url, state: states.get(url) ?? "unknown" }));
}

export function isThreadActive(run: Pick<Api.ApiRun, "status" | "awaitingInput">): boolean {
  return run.awaitingInput || run.status === "queued" || run.status === "running" || run.status === "cancelling";
}

export function isThreadSettled(run: Api.ApiRun): boolean {
  if (isThreadActive(run)) return false;
  if (run.settledAt) return true;
  const prs = threadPullRequests(run);
  return prs.length > 0 && prs.every((pr) => pr.state === "merged");
}

export function threadActivityLabel(run: Pick<Api.ApiRun, "status" | "awaitingInput">): string {
  if (run.awaitingInput) return "Needs input";
  return { queued: "Queued", running: "Working", cancelling: "Stopping", succeeded: "Done", failed: "Failed", cancelled: "Cancelled" }[run.status];
}

const activityTime = (run: Api.ApiRun) => (run.lastActivityAt ?? run.createdAt).getTime();
const byActivity = (a: Api.ApiRun, b: Api.ApiRun) => activityTime(b) - activityTime(a);

export interface RepoThreads {
  repo: string;
  recent: Api.ApiRun[];
  settled: Api.ApiRun[];
  activeCount: number;
}

/** Active work is never capped by the recent-history limit or a project disclosure. */
export function sidebarThreads(runs: readonly Api.ApiRun[], selectedId: string | null) {
  const sorted = [...runs].sort(byActivity);
  const active = sorted.filter(isThreadActive).sort((a, b) => Number(b.awaitingInput) - Number(a.awaitingInput));
  const repos = new Map<string, RepoThreads>();
  for (const run of sorted) {
    const group = repos.get(run.repo) ?? { repo: run.repo, recent: [], settled: [], activeCount: 0 };
    repos.set(run.repo, group);
    if (isThreadActive(run)) group.activeCount++;
    // Automatic settlement keeps the thread being read visible; an explicit
    // settlement moves it into history immediately, even when selected.
    else if (isThreadSettled(run) && (run.settledAt || run.id !== selectedId)) group.settled.push(run);
    else group.recent.push(run);
  }
  return { active, repos: [...repos.values()] };
}

export function visibleRecentThreads(runs: readonly Api.ApiRun[], expanded: boolean, selectedId: string | null, limit = 6) {
  if (expanded) return runs;
  return runs.filter((run, index) => index < limit || run.id === selectedId);
}
