import { GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon } from "lucide-react";
import { type PullRequest, threadPullRequests } from "@/lib/threads";
import type { Api } from "@/lib/api";
import { cn } from "@/lib/utils";

const LABEL = { open: "Open", draft: "Draft", closed: "Closed", merged: "Merged", unknown: "Status unavailable" };
const TONE = { open: "text-success", draft: "text-muted-foreground", closed: "text-destructive", merged: "text-primary", unknown: "text-muted-foreground" };
const ICON = { open: GitPullRequestIcon, draft: GitPullRequestDraftIcon, closed: GitPullRequestClosedIcon, merged: GitMergeIcon, unknown: GitPullRequestIcon };

export function PullRequestStatus({ pr, className }: { pr: PullRequest; className?: string }) {
  const Icon = ICON[pr.state];
  const number = pr.url.match(/\/pull\/(\d+)$/)?.[1];
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-[11px]", TONE[pr.state], className)} title={`${pr.url} · ${LABEL[pr.state]}`}>
      <Icon className="size-3! shrink-0" aria-hidden />
      <span className="truncate">{number ? `#${number} ` : "PR "}{LABEL[pr.state]}</span>
    </span>
  );
}

export function ThreadPullRequestStatus({ run }: { run: Api.ApiRun }) {
  const prs = threadPullRequests(run);
  if (!prs.length) return <span className="text-[11px] text-muted-foreground">No PR yet</span>;
  if (prs.length === 1) return <PullRequestStatus pr={prs[0]!} />;
  const counts = new Map<PullRequest["state"], number>();
  for (const pr of prs) counts.set(pr.state, (counts.get(pr.state) ?? 0) + 1);
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground" title={prs.map((pr) => `${pr.url} · ${LABEL[pr.state]}`).join("\n")}>
      <GitPullRequestIcon className="size-3! shrink-0" aria-hidden />
      <span className="truncate">{[...counts].map(([state, count]) => `${count} ${state === "unknown" ? "unknown" : LABEL[state].toLowerCase()}`).join(" · ")}</span>
    </span>
  );
}
