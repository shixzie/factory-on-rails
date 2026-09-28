"use client";

import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { isActive, StatusLabel } from "@/components/run-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, runInBrowser, type Api } from "@/lib/api";
import { ago, duration, taskTitle } from "@/lib/format";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;

type Entry =
  | { type: "step"; id: string; kind: "info" | "error"; message: string }
  | { type: "output"; id: string; chunks: { kind: "stdout" | "stderr"; text: string }[] };

/** Info and error events become steps; consecutive output becomes one terminal block. */
function toEntries(events: ReadonlyArray<Api.ApiRunEvent>): Entry[] {
  const entries: Entry[] = [];
  for (const e of events) {
    if (e.kind === "info" || e.kind === "error") {
      entries.push({ type: "step", id: e.id, kind: e.kind, message: e.message });
      continue;
    }
    const last = entries.at(-1);
    if (last?.type === "output") last.chunks.push({ kind: e.kind, text: e.message });
    else entries.push({ type: "output", id: e.id, chunks: [{ kind: e.kind, text: e.message }] });
  }
  return entries;
}

/** Re-renders every second while `on`, for live durations. */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function OutputBlock({ chunks, open: defaultOpen }: { chunks: Extract<Entry, { type: "output" }>["chunks"]; open: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const preRef = useRef<HTMLPreElement>(null);
  const lines = useMemo(() => chunks.reduce((n, c) => n + (c.text.match(/\n/g)?.length ?? 0), 0), [chunks]);
  useEffect(() => setOpen((o) => o || defaultOpen), [defaultOpen]);
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (pre && open) pre.scrollTop = pre.scrollHeight;
  }, [chunks, open]);
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-2 rounded-md py-1 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <TerminalIcon className="size-3.5 shrink-0" />
        <span>Output</span>
        <span className="tabular-nums opacity-60">{Math.max(lines, 1)} lines</span>
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <pre
          ref={preRef}
          className="mt-1 max-h-96 overflow-auto rounded-lg border bg-code p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-foreground/85"
        >
          {chunks.map((c, i) => (
            <span key={i} className={c.kind === "stderr" ? "text-destructive/90" : undefined}>
              {c.text}
            </span>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

function WorkLog({ run, entries, now }: { run: Api.ApiRun; entries: Entry[]; now: number }) {
  const active = isActive(run.status);
  const [open, setOpen] = useState(true);
  const started = run.startedAt ?? run.createdAt;
  const elapsed = duration(started, run.finishedAt ?? new Date(now));
  const title =
    run.status === "queued"
      ? "Waiting for a sandbox"
      : active
        ? `Working for ${elapsed}`
        : run.startedAt
          ? `Worked for ${elapsed}`
          : "Did not start";
  return (
    <div className="rounded-xl border bg-card/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {active ? <Spinner className="size-3.5" /> : <CircleCheckIcon className="size-3.5" />}
        <span suppressHydrationWarning>{title}</span>
        <span className="opacity-60">· {entries.length} steps</span>
        <ChevronRightIcon className={cn("ml-auto size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      {open && entries.length > 0 ? (
        <div className="border-t px-3.5 py-2">
          {entries.map((entry, i) =>
            entry.type === "step" ? (
              <div
                key={entry.id}
                className={cn(
                  "flex items-start gap-2 py-1 text-xs leading-relaxed",
                  entry.kind === "error" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {entry.kind === "error" ? (
                  <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                )}
                <span className="min-w-0 break-words">{entry.message}</span>
              </div>
            ) : (
              <OutputBlock key={entry.id} chunks={entry.chunks} open={active && i === entries.length - 1} />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function Outcome({ run }: { run: Api.ApiRun }) {
  if (run.status === "succeeded" && run.pullRequestUrl) {
    return (
      <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-success/15 text-success">
          <GitPullRequestIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Pull request opened</div>
          <div className="truncate text-xs text-muted-foreground">{run.pullRequestUrl.replace("https://github.com/", "")}</div>
        </div>
        <Button variant="outline" size="sm" render={<a href={run.pullRequestUrl} target="_blank" rel="noreferrer" />}>
          Review <ExternalLinkIcon />
        </Button>
      </div>
    );
  }
  if (run.status === "succeeded") {
    return <p className="text-sm text-muted-foreground">The agent finished without changing anything, so there is no pull request.</p>;
  }
  if (run.status === "failed") {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
        <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-medium text-destructive">Run failed</div>
          {run.error ? <div className="mt-0.5 break-words text-muted-foreground">{run.error}</div> : null}
        </div>
      </div>
    );
  }
  if (run.status === "cancelled") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CircleSlashIcon className="size-4" /> Cancelled.
      </p>
    );
  }
  return null;
}

/**
 * One run as a thread: the task as the user's message, the agent's work log
 * under it (polled while the run is live), and the outcome at the end.
 */
export function RunView({ initial, children }: { initial: Api.RunDetail; children?: React.ReactNode }) {
  const router = useRouter();
  const [run, setRun] = useState(initial.run);
  const [events, setEvents] = useState(initial.events);
  const [cancelling, startCancel] = useTransition();
  const active = isActive(run.status);
  const now = useNow(active);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Poll for new output while the run is live; refresh the sidebar when it settles.
  useEffect(() => {
    if (!isActive(run.status)) return;
    let stopped = false;
    let after = events.at(-1)?.id ?? "0";
    const tick = async () => {
      const result = await runInBrowser(api.runEvents(run.id, after));
      if (stopped) return;
      if (result._tag === "Right") {
        const page = result.right;
        if (page.events.length > 0) {
          after = page.events.at(-1)!.id;
          setEvents((prev) => [...prev, ...page.events]);
        }
        setRun(page.run);
        if (!isActive(page.run.status)) {
          router.refresh();
          return;
        }
      }
      timer = setTimeout(tick, POLL_MS);
    };
    let timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // Restart only when the run or its liveness changes; `after` is tracked inside.
  }, [run.id, active]);

  // Follow new output when the reader is already at the bottom.
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
    if (nearBottom) el.scrollIntoView({ block: "end" });
  }, [events.length, run.status]);

  const entries = useMemo(() => toEntries(events), [events]);

  const cancel = () =>
    startCancel(async () => {
      const result = await runInBrowser(api.cancelRun(run.id));
      if (result._tag === "Left") toast.error(result.left.message);
      else setRun(result.right);
    });

  return (
    <>
      <PageHeader
        actions={
          <>
            {run.pullRequestUrl ? (
              <Button variant="outline" size="sm" render={<a href={run.pullRequestUrl} target="_blank" rel="noreferrer" />}>
                <GitPullRequestIcon /> Pull request
              </Button>
            ) : null}
            {active ? (
              <Button variant="ghost" size="sm" onClick={cancel} disabled={cancelling || run.status === "cancelling"}>
                {cancelling ? <Spinner /> : <SquareIcon className="fill-current" />} Stop
              </Button>
            ) : null}
          </>
        }
      >
        <span className="truncate font-medium">{taskTitle(run.task)}</span>
        <Badge variant="outline" className="hidden shrink-0 font-normal text-muted-foreground sm:inline-flex">
          {run.repo}
        </Badge>
        <StatusLabel status={run.status} className="shrink-0" />
      </PageHeader>

      <div className="flex-1 px-4 pt-8 pb-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          <div className="flex flex-col items-end gap-1.5">
            <div className="max-w-[85%] rounded-2xl rounded-br-md border bg-secondary px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
              {run.task}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1.5 text-[11px] text-muted-foreground" suppressHydrationWarning>
              <span>{run.repo}</span>
              <span>·</span>
              <GitBranchIcon className="size-3" />
              <span>{run.branch ? `${run.baseBranch} ← ${run.branch}` : run.baseBranch}</span>
              <span>·</span>
              <span>{ago(run.createdAt)}</span>
            </div>
          </div>

          <WorkLog run={run} entries={entries} now={now} />
          <Outcome run={run} />
          <div ref={bottomRef} />
        </div>
      </div>

      {children}
    </>
  );
}
