"use client";

import {
  AppWindowIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CircleAlertIcon,
  CircleDotIcon,
  CircleSlashIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  SquareIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ChangedFiles, DiffPane, DiffStat, useDiffFiles } from "@/components/diff-view";
import { PageHeader } from "@/components/page-header";
import { PreviewPane } from "@/components/preview-pane";
import { RunActivity } from "@/components/run-activity";
import { RunFlow } from "@/components/run-flow";
import { RunTitle } from "@/components/run-title";
import { isActive, SandboxLabel, sandboxHint, StatusLabel } from "@/components/run-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFollow } from "@/hooks/use-follow";
import { openQuestion, toBlocks } from "@/lib/activity";
import { Api, api, runInBrowser } from "@/lib/api";
import { diffTotals } from "@/lib/diff";
import { ago, duration } from "@/lib/format";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;
/** While a finished run's sandbox is up, check now and then whether it has been stopped. */
const SANDBOX_POLL_MS = 15_000;
/** Sooner while the Preview tab is open, so servers the sandbox starts show up. */
const PREVIEW_POLL_MS = 4000;

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

/**
 * The box at the bottom of a run. While it is live, answers and new direction
 * go straight to the agent; once it has finished, a message starts its next turn.
 */
function MessageComposer({
  question,
  live,
  hint,
  disabled,
  sending,
  stopping,
  onSend,
  onStop,
}: {
  question: boolean;
  live: boolean;
  /** What happens when you send, once the run has finished. */
  hint?: string;
  disabled: boolean;
  sending: boolean;
  stopping: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const empty = text.trim().length === 0;
  const canSend = !disabled && !sending && !empty;
  // With nothing typed, a live run's send button stops it instead, as in t3code.
  const showStop = live && empty && !sending;
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
        placeholder={
          question ? "Answer the agent's question…" : live ? "Send the agent a message while it works…" : "Ask for changes or a next step…"
        }
        aria-label="Message to the agent"
        className="field-sizing-content block max-h-60 min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
      />
      <div className="flex items-center gap-2 px-2.5 pb-2.5">
        <span className="min-w-0 px-1.5 text-[11px] text-muted-foreground">
          {question
            ? "The agent is waiting for you."
            : live
              ? "It reads your message after its current step."
              : (hint ?? "The agent picks up where it left off.")}
        </span>
        <span className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
        </span>
        {showStop ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  className="rounded-full"
                  onClick={onStop}
                  disabled={stopping}
                  aria-label="Stop the run"
                />
              }
            >
              {stopping ? <Spinner /> : <SquareIcon className="size-3 fill-current" />}
            </TooltipTrigger>
            <TooltipContent>{stopping ? "Stopping…" : "Stop the run"}</TooltipContent>
          </Tooltip>
        ) : (
          <Button type="submit" size="icon-sm" className="rounded-full" disabled={!canSend} aria-label="Send to the agent">
            {sending ? <Spinner /> : <ArrowUpIcon />}
          </Button>
        )}
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
        <Button variant="outline" size="sm" nativeButton={false} render={<a href={run.pullRequestUrl} target="_blank" rel="noreferrer" />}>
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

type PanelTab = "flow" | "diff" | "preview";

/** Beside the thread on wide screens, over it on small ones: the flow map, the diff, or a preview. */
function SidePanel({
  tab,
  onTab,
  onClose,
  fileCount,
  previews,
  children,
}: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  fileCount: number;
  /** Show the Preview tab. */
  previews: boolean;
  children: React.ReactNode;
}) {
  const tabs: { id: PanelTab; label: string; icon: React.ReactNode }[] = [
    { id: "flow", label: "Flow", icon: <WorkflowIcon /> },
    { id: "diff", label: fileCount ? `Diff · ${fileCount}` : "Diff", icon: <FileDiffIcon /> },
    ...(previews ? [{ id: "preview" as const, label: "Preview", icon: <AppWindowIcon /> }] : []),
  ];
  return (
    <aside className="fixed inset-x-0 top-12 bottom-0 z-20 flex flex-col border-l bg-background lg:sticky lg:inset-auto lg:top-12 lg:z-auto lg:h-[calc(100svh-3rem)] lg:w-[min(46rem,48%)] lg:min-w-0 lg:shrink-0 lg:self-start">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2" role="tablist" aria-label="Side panel">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => onTab(t.id)}
            className={cn(
              "relative inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors [&_svg]:size-3.5",
              tab === t.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onClose} aria-label="Close the side panel">
          <XIcon />
        </Button>
      </div>
      {children}
    </aside>
  );
}

/**
 * One run as a thread: the task as the user's message, then what the agent
 * said and did (polled while the run is live), questions it asked, and the
 * outcome, with the files it changed in a diff panel beside it.
 */
export function RunView({ initial }: { initial: Api.RunDetail }) {
  const router = useRouter();
  const [run, setRun] = useState(initial.run);
  const [events, setEvents] = useState(initial.events);
  const [diff, setDiff] = useState(initial.diff);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [focusAgent, setFocusAgent] = useState<{ id: string; n: number }>();
  const [focus, setFocus] = useState<{ path: string; n: number }>();
  const [cancelling, startCancel] = useTransition();
  const [sending, setSending] = useState(false);
  const active = isActive(run.status);
  // A finished run's sandbox is stopped after a few idle minutes; keep the label honest.
  const sandboxUp = run.sandboxState === "running" || run.sandboxState === "stopping";
  const now = useNow(active);
  const pollNow = useRef<() => void>(() => {});
  const previewing = useRef(false);
  previewing.current = panel === "preview";

  // Poll for new activity while the run is live (and page through a long
  // finished run); refresh the sidebar when the run settles.
  useEffect(() => {
    if (!isActive(run.status) && !initial.hasMore && !sandboxUp) return;
    let stopped = false;
    let after = events.at(-1)?.id ?? "0";
    let diffAt = diff?.updatedAt.getTime() ?? 0;
    let title = run.title;
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
        // A title is written just after the run starts; show it in the sidebar too.
        if (page.run.title !== title) {
          title = page.run.title;
          router.refresh();
        }
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
          if (page.run.sandboxState !== "running" && page.run.sandboxState !== "stopping") return;
          delay = previewing.current ? PREVIEW_POLL_MS : SANDBOX_POLL_MS;
        }
      }
      timer = setTimeout(tick, delay);
    };
    pollNow.current = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      void tick();
    };
    timer = setTimeout(tick, initial.hasMore ? 0 : active ? POLL_MS : SANDBOX_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      pollNow.current = () => {};
    };
    // Restart only when the run, its liveness or its sandbox changes; cursors are tracked inside.
  }, [run.id, active, sandboxUp]);

  // The sidebar shows which runs need an answer; keep it in step.
  const awaiting = run.awaitingInput;
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) firstRender.current = false;
    else router.refresh();
  }, [awaiting]);

  // Follow the run as it works; scrolling up pauses that until you come back down.
  const follow = useFollow(events.length, active);

  // A live run opens with its flow map beside it, where there is room.
  useEffect(() => {
    if (active && window.matchMedia("(min-width: 1024px)").matches) setPanel((p) => p ?? "flow");
  }, []);

  const blocks = useMemo(() => toBlocks(events), [events]);
  const files = useDiffFiles(diff);
  const totals = diffTotals(files);
  const question = active ? openQuestion(blocks) : undefined;

  const openDiff = (path?: string) => {
    setPanel("diff");
    if (path) setFocus((f) => ({ path, n: (f?.n ?? 0) + 1 }));
  };

  const togglePanel = (tab: PanelTab) => {
    setPanel((p) => (p === tab ? null : tab));
    // Opening the preview wants fresh ports rather than the next slow poll.
    if (tab === "preview") pollNow.current();
  };

  const previewPorts = run.previewPorts?.length ?? 0;
  const showPreview = initial.previewsEnabled && (active || sandboxUp || previewPorts > 0 || panel === "preview");

  // Picking a subagent on the map opens its card in the thread (closing the map where it covers the thread).
  const selectAgent = (id: string) => {
    setFocusAgent((f) => ({ id, n: (f?.n ?? 0) + 1 }));
    if (!window.matchMedia("(min-width: 1024px)").matches) setPanel(null);
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
    // A message to a finished run starts its next turn; the sidebar shows it working again.
    if (!active) router.refresh();
    return true;
  };

  const started = run.startedAt ?? run.createdAt;
  const elapsed = duration(started, run.finishedAt ?? new Date(now));
  const liveLabel =
    run.status === "queued"
      ? run.sandboxState === "stopped" || run.sandboxState === "stopping"
        ? "Starting the sandbox again"
        : "Waiting for a sandbox"
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
            {events.length > 0 || active ? (
              <Button
                variant={panel === "flow" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => togglePanel("flow")}
                aria-pressed={panel === "flow"}
                aria-label="Toggle the flow map"
              >
                <WorkflowIcon />
                <span className="hidden sm:inline">Flow</span>
              </Button>
            ) : null}
            {files.length > 0 || active ? (
              <Button
                variant={panel === "diff" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => togglePanel("diff")}
                aria-pressed={panel === "diff"}
                aria-label="Toggle the diff"
              >
                <FileDiffIcon />
                <span className="hidden sm:inline">Diff</span>
                {files.length > 0 ? <DiffStat additions={totals.additions} deletions={totals.deletions} /> : null}
              </Button>
            ) : null}
            {showPreview ? (
              <Button
                variant={panel === "preview" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => togglePanel("preview")}
                aria-pressed={panel === "preview"}
                aria-label="Toggle the preview"
              >
                <AppWindowIcon />
                <span className="hidden sm:inline">Preview</span>
                {previewPorts > 0 ? (
                  <span className="rounded bg-success/15 px-1 font-mono text-[10px] text-success">{previewPorts}</span>
                ) : null}
              </Button>
            ) : null}
            {run.pullRequestUrl ? (
              <Button variant="outline" size="sm" nativeButton={false} render={<a href={run.pullRequestUrl} target="_blank" rel="noreferrer" />}>
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
        <RunTitle
          run={run}
          onRenamed={(renamed) => {
            setRun(renamed);
            router.refresh();
          }}
        />
        <Badge variant="outline" className="hidden shrink-0 font-normal text-muted-foreground sm:inline-flex">
          {run.repo}
        </Badge>
        <StatusLabel status={run.status} awaiting={run.awaitingInput} className="shrink-0" />
        <SandboxLabel state={run.sandboxState} className="hidden shrink-0 md:inline-flex" />
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
                  <span>{Api.AGENT_LABELS[run.agent]}</span>
                  <span>·</span>
                  <GitBranchIcon className="size-3" />
                  <span>{run.branch ? `${run.baseBranch} ← ${run.branch}` : run.baseBranch}</span>
                  <span>·</span>
                  <span>{ago(run.createdAt)}</span>
                </div>
              </div>

              <RunActivity blocks={blocks} live={active} onAnswer={send} sending={sending} focusAgent={focusAgent} />

              {active ? (
                <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                  {question ? <CircleDotIcon className="size-3.5 text-warning" /> : <Spinner className="size-3.5" />}
                  <span suppressHydrationWarning>{liveLabel}</span>
                </div>
              ) : run.startedAt ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
                  <span>Worked for {elapsed}</span>
                  <SandboxLabel state={run.sandboxState} className="md:hidden" />
                </div>
              ) : null}

              <ChangedFiles files={files} onOpen={openDiff} />
              <Outcome run={run} />
            </div>
          </div>

          <div className="sticky bottom-0 bg-gradient-to-t from-background via-background to-transparent px-4 pt-6 pb-4">
            {active && !follow.following ? (
              <div className="pointer-events-none absolute inset-x-0 -top-6 flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={follow.jump}
                  className="pointer-events-auto animate-in rounded-full bg-background/95 shadow-md backdrop-blur fade-in slide-in-from-bottom-2 dark:bg-card/95"
                >
                  {follow.unseen ? (
                    <span className="relative flex size-2">
                      <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60" />
                      <span className="relative size-2 rounded-full bg-primary" />
                    </span>
                  ) : null}
                  {follow.unseen ? "New activity" : "Jump to latest"}
                  <ArrowDownIcon />
                </Button>
              </div>
            ) : null}
            <MessageComposer
              question={!!question}
              live={active}
              hint={sandboxHint(run.sandboxState)}
              disabled={run.status === "cancelling"}
              sending={sending}
              stopping={cancelling || run.status === "cancelling"}
              onSend={send}
              onStop={cancel}
            />
            {!active ? (
              <p className="mx-auto mt-2 max-w-3xl px-1 text-center text-[11px] text-muted-foreground/80">
                Runs are deleted after {Api.RUN_RETENTION_DAYS} days without activity, along with their sandbox.
              </p>
            ) : null}
          </div>
        </div>

        {panel ? (
          <SidePanel
            tab={panel}
            onTab={setPanel}
            onClose={() => setPanel(null)}
            fileCount={files.length}
            previews={initial.previewsEnabled}
          >
            {panel === "preview" ? (
              <PreviewPane run={run} enabled={initial.previewsEnabled} />
            ) : panel === "flow" ? (
              <div className="flex-1 overflow-y-auto p-4">
                <RunFlow
                  events={events}
                  live={active}
                  awaiting={!!question}
                  pullRequestUrl={run.pullRequestUrl}
                  filesChanged={files.length}
                  onSelectAgent={selectAgent}
                />
              </div>
            ) : (
              <DiffPane diff={diff} files={files} live={active} focus={focus} />
            )}
          </SidePanel>
        ) : null}
      </div>
    </>
  );
}
