"use client";

import {
  ArrowUpIcon,
  CircleAlertIcon,
  CircleDotIcon,
  CircleSlashIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  SquareIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ChangedFiles, DiffPanel, DiffStat, useDiffFiles } from "@/components/diff-view";
import { PageHeader } from "@/components/page-header";
import { RunActivity } from "@/components/run-activity";
import { isActive, StatusLabel } from "@/components/run-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { openQuestion, toBlocks } from "@/lib/activity";
import { api, runInBrowser, type Api } from "@/lib/api";
import { diffTotals } from "@/lib/diff";
import { ago, duration, taskTitle } from "@/lib/format";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;

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

/** The box at the bottom while a run is live: answers and new direction go straight to the agent. */
function MessageComposer({
  question,
  disabled,
  sending,
  onSend,
}: {
  question: boolean;
  disabled: boolean;
  sending: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend = !disabled && !sending && text.trim().length > 0;
  useEffect(() => {
    if (question) ref.current?.focus();
  }, [question]);
  const submit = async () => {
    if (!canSend) return;
    if (await onSend(text)) setText("");
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className={cn(
        "mx-auto w-full max-w-3xl rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-ring/60 dark:shadow-none",
        question && "border-warning/50",
        disabled && "opacity-60",
      )}
    >
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        disabled={disabled}
        rows={2}
        placeholder={question ? "Answer the agent's question…" : "Send the agent a message while it works…"}
        aria-label="Message to the agent"
        className="field-sizing-content block max-h-60 min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
      />
      <div className="flex items-center gap-2 px-2.5 pb-2.5">
        <span className="px-1.5 text-[11px] text-muted-foreground">
          {question ? "The agent is waiting for you." : "It reads your message after its current step."}
        </span>
        <span className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
        </span>
        <Button type="submit" size="icon-sm" className="rounded-full" disabled={!canSend} aria-label="Send to the agent">
          {sending ? <Spinner /> : <ArrowUpIcon />}
        </Button>
      </div>
    </form>
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
 * One run as a thread: the task as the user's message, then what the agent
 * said and did (polled while the run is live), questions it asked, and the
 * outcome, with the files it changed in a diff panel beside it.
 */
export function RunView({ initial, children }: { initial: Api.RunDetail; children?: React.ReactNode }) {
  const router = useRouter();
  const [run, setRun] = useState(initial.run);
  const [events, setEvents] = useState(initial.events);
  const [diff, setDiff] = useState(initial.diff);
  const [diffOpen, setDiffOpen] = useState(false);
  const [focus, setFocus] = useState<{ path: string; n: number }>();
  const [cancelling, startCancel] = useTransition();
  const [sending, setSending] = useState(false);
  const active = isActive(run.status);
  const now = useNow(active);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pollNow = useRef<() => void>(() => {});

  // Poll for new activity while the run is live (and page through a long
  // finished run); refresh the sidebar when the run settles.
  useEffect(() => {
    if (!isActive(run.status) && !initial.hasMore) return;
    let stopped = false;
    let after = events.at(-1)?.id ?? "0";
    let diffAt = diff?.updatedAt.getTime() ?? 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      timer = undefined;
      const result = await runInBrowser(api.runEvents(run.id, after));
      if (stopped) return;
      let delay = POLL_MS;
      if (result._tag === "Right") {
        const page = result.right;
        if (page.events.length > 0) {
          after = page.events.at(-1)!.id;
          setEvents((prev) => [...prev, ...page.events]);
        }
        setRun(page.run);
        if (page.diffUpdatedAt && page.diffUpdatedAt.getTime() !== diffAt) {
          const fresh = await runInBrowser(api.runDiff(run.id));
          if (stopped) return;
          if (fresh._tag === "Right") {
            diffAt = fresh.right.updatedAt.getTime();
            setDiff(fresh.right);
          }
        }
        if (page.hasMore) delay = 0;
        else if (!isActive(page.run.status)) {
          if (isActive(run.status)) router.refresh();
          return;
        }
      }
      timer = setTimeout(tick, delay);
    };
    pollNow.current = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      void tick();
    };
    timer = setTimeout(tick, initial.hasMore ? 0 : POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      pollNow.current = () => {};
    };
    // Restart only when the run or its liveness changes; cursors are tracked inside.
  }, [run.id, active]);

  // The sidebar shows which runs need an answer; keep it in step.
  const awaiting = run.awaitingInput;
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) firstRender.current = false;
    else router.refresh();
  }, [awaiting]);

  // Follow new activity when the reader is already at the bottom.
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
    if (nearBottom) el.scrollIntoView({ block: "end" });
  }, [events.length, run.status]);

  const blocks = useMemo(() => toBlocks(events), [events]);
  const files = useDiffFiles(diff);
  const totals = diffTotals(files);
  const question = active ? openQuestion(blocks) : undefined;

  const openDiff = (path?: string) => {
    setDiffOpen(true);
    if (path) setFocus((f) => ({ path, n: (f?.n ?? 0) + 1 }));
  };

  const cancel = () =>
    startCancel(async () => {
      const result = await runInBrowser(api.cancelRun(run.id));
      if (result._tag === "Left") toast.error(result.left.message);
      else setRun(result.right);
    });

  const send = async (text: string) => {
    setSending(true);
    const result = await runInBrowser(api.sendMessage(run.id, text));
    setSending(false);
    if (result._tag === "Left") {
      toast.error(result.left.message);
      return false;
    }
    setRun(result.right);
    pollNow.current();
    return true;
  };

  const started = run.startedAt ?? run.createdAt;
  const elapsed = duration(started, run.finishedAt ?? new Date(now));
  const liveLabel =
    run.status === "queued"
      ? "Waiting for a sandbox"
      : run.status === "cancelling"
        ? "Stopping the agent"
        : question
          ? "Waiting for your answer"
          : `Working for ${elapsed}`;

  return (
    <>
      <PageHeader
        actions={
          <>
            {files.length > 0 || active ? (
              <Button
                variant={diffOpen ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setDiffOpen((o) => !o)}
                aria-pressed={diffOpen}
                aria-label="Toggle the diff"
              >
                <FileDiffIcon />
                <span className="hidden sm:inline">Diff</span>
                {files.length > 0 ? <DiffStat additions={totals.additions} deletions={totals.deletions} /> : null}
              </Button>
            ) : null}
            {run.pullRequestUrl ? (
              <Button variant="outline" size="sm" render={<a href={run.pullRequestUrl} target="_blank" rel="noreferrer" />}>
                <GitPullRequestIcon /> <span className="hidden sm:inline">Pull request</span>
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
        <StatusLabel status={run.status} awaiting={run.awaitingInput} className="shrink-0" />
      </PageHeader>

      <div className="flex flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 px-4 pt-8 pb-6">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
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

              <RunActivity blocks={blocks} live={active} onAnswer={send} sending={sending} />

              {active ? (
                <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                  {question ? <CircleDotIcon className="size-3.5 text-warning" /> : <Spinner className="size-3.5" />}
                  <span suppressHydrationWarning>{liveLabel}</span>
                </div>
              ) : run.startedAt ? (
                <div className="px-1 text-[11px] text-muted-foreground">Worked for {elapsed}</div>
              ) : null}

              <ChangedFiles files={files} onOpen={openDiff} />
              <Outcome run={run} />
              <div ref={bottomRef} />
            </div>
          </div>

          {active ? (
            <div className="sticky bottom-0 bg-gradient-to-t from-background via-background to-transparent px-4 pt-6 pb-4">
              <MessageComposer question={!!question} disabled={run.status === "cancelling"} sending={sending} onSend={send} />
            </div>
          ) : (
            children
          )}
        </div>

        {diffOpen ? (
          <DiffPanel diff={diff} files={files} live={active} focus={focus} onClose={() => setDiffOpen(false)} />
        ) : null}
      </div>
    </>
  );
}
