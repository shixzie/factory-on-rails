"use client";

import {
  BotIcon,
  BrainIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  FileTextIcon,
  FolderSearchIcon,
  GlobeIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  PencilIcon,
  FilePlusIcon,
  PlugIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DiffLines, DiffStat } from "@/components/diff-view";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { answerText, isSubagentTool, repoPath, type Block, type ToolCall, type WorkItem } from "@/lib/activity";
import { compact, describeCall, KIND_COLOR, laneColor, toolKind } from "@/lib/flow";
import { replacementLines, type DiffLine } from "@/lib/diff";
import { ago, duration } from "@/lib/format";
import { cn } from "@/lib/utils";

const s = (v: unknown) => (typeof v === "string" ? v : "");
const firstLine = (text: string) => text.trim().split("\n")[0] ?? "";

function Expandable({
  icon,
  label,
  meta,
  status,
  defaultOpen = false,
  children,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  meta?: React.ReactNode;
  status?: "pending" | "error" | "done";
  defaultOpen?: boolean;
  children?: React.ReactNode;
}) {
  // Follows `defaultOpen` both ways (a running command opens, then folds away when it
  // finishes) until the reader opens or closes it themselves.
  const [open, setOpen] = useState(defaultOpen);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setOpen(defaultOpen);
  }, [defaultOpen]);
  const expandable = !!children;
  return (
    <div className="py-0.5">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => {
          touched.current = true;
          setOpen((o) => !o);
        }}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          "group flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left text-xs",
          status === "error" ? "text-destructive" : "text-muted-foreground",
          expandable && "hover:text-foreground",
        )}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5">{icon}</span>
        <span className="min-w-0 truncate">{label}</span>
        {meta ? <span className="shrink-0">{meta}</span> : null}
        {status === "pending" ? <Spinner className="size-3 shrink-0" /> : null}
        {status === "error" ? <CircleAlertIcon className="size-3.5 shrink-0" /> : null}
        {expandable ? (
          <ChevronRightIcon className={cn("size-3.5 shrink-0 opacity-0 transition group-hover:opacity-100", open && "rotate-90 opacity-100")} />
        ) : null}
      </button>
      {open && children ? <div className="mt-1 mb-1.5 ml-5.5">{children}</div> : null}
    </div>
  );
}

function Pre({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-lg border bg-code p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words",
        tone === "error" ? "text-destructive/90" : "text-foreground/85",
      )}
    >
      {children}
    </pre>
  );
}

function DiffBox({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg border bg-code py-1">
      <DiffLines lines={lines} numbers={false} />
    </div>
  );
}

function Path({ path }: { path: string }) {
  return <span className="font-mono text-[11.5px] text-foreground/85">{repoPath(path)}</span>;
}

type TodoItem = { content?: string; status?: string; activeForm?: string };

function Todos({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="space-y-1 text-xs">
      {todos.map((t, i) => (
        <li key={i} className={cn("flex items-start gap-2", t.status === "completed" && "text-muted-foreground line-through")}>
          {t.status === "completed" ? (
            <CircleCheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" />
          ) : t.status === "in_progress" ? (
            <CircleDotIcon className="mt-0.5 size-3.5 shrink-0 text-info" />
          ) : (
            <CircleDashedIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span>{t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}</span>
        </li>
      ))}
    </ul>
  );
}

/** One tool call as a single line (verb and target), expanding to its input and output. */
function ToolLine({ call, live, latestPlan }: { call: ToolCall; live: boolean; latestPlan: boolean }) {
  const { input, result } = call;
  const status = !result ? (live ? "pending" : undefined) : result.isError ? "error" : "done";
  const output = result?.text ? <Pre tone={result.isError ? "error" : undefined}>{result.text}</Pre> : null;
  const common = { status: status as "pending" | "error" | "done" | undefined };

  switch (call.name) {
    case "Bash":
      return (
        <Expandable
          {...common}
          defaultOpen={status === "pending"}
          icon={<TerminalIcon />}
          label={
            <>
              {s(input.description) ? `${s(input.description)} ` : "Ran "}
              <code className="font-mono text-[11.5px] text-foreground/85">{firstLine(s(input.command))}</code>
            </>
          }
        >
          <Pre tone={result?.isError ? "error" : undefined}>
            <span className="text-muted-foreground">$ </span>
            {s(input.command)}
            {result?.text ? `\n\n${result.text}` : ""}
          </Pre>
        </Expandable>
      );
    case "Read":
      return (
        <Expandable {...common} icon={<FileTextIcon />} label={<>Read <Path path={s(input.file_path)} /></>}>
          {result?.isError ? output : null}
        </Expandable>
      );
    case "Edit":
    case "MultiEdit": {
      const edits: { old_string?: unknown; new_string?: unknown }[] =
        call.name === "MultiEdit" && Array.isArray(input.edits) ? input.edits : [input];
      const lines = edits.flatMap((e) => replacementLines(s(e.old_string), s(e.new_string)));
      const adds = lines.filter((l) => l.type === "add").length;
      return (
        <Expandable
          {...common}
          icon={<PencilIcon />}
          label={<>Edited <Path path={s(input.file_path)} /></>}
          meta={<DiffStat additions={adds} deletions={lines.length - adds} />}
        >
          {result?.isError ? output : <DiffBox lines={lines} />}
        </Expandable>
      );
    }
    case "Write": {
      const lines = replacementLines("", s(input.content));
      return (
        <Expandable
          {...common}
          icon={<FilePlusIcon />}
          label={<>Wrote <Path path={s(input.file_path)} /></>}
          meta={<DiffStat additions={lines.length} deletions={0} />}
        >
          {result?.isError ? output : <DiffBox lines={lines} />}
        </Expandable>
      );
    }
    case "NotebookEdit":
      return <Expandable {...common} icon={<PencilIcon />} label={<>Edited <Path path={s(input.notebook_path)} /></>}>{output}</Expandable>;
    case "Glob":
    case "LS":
      return (
        <Expandable
          {...common}
          icon={<FolderSearchIcon />}
          label={<>Listed <code className="font-mono text-[11.5px] text-foreground/85">{s(input.pattern) || repoPath(s(input.path)) || "."}</code></>}
        >
          {output}
        </Expandable>
      );
    case "Grep":
      return (
        <Expandable
          {...common}
          icon={<SearchIcon />}
          label={<>Searched for <code className="font-mono text-[11.5px] text-foreground/85">{s(input.pattern)}</code></>}
        >
          {output}
        </Expandable>
      );
    case "WebFetch":
      return <Expandable {...common} icon={<GlobeIcon />} label={<>Fetched <span className="text-foreground/85">{s(input.url)}</span></>}>{output}</Expandable>;
    case "WebSearch":
      return <Expandable {...common} icon={<GlobeIcon />} label={<>Searched the web for “{s(input.query)}”</>}>{output}</Expandable>;
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as TodoItem[]) : [];
      const done = todos.filter((t) => t.status === "completed").length;
      return (
        <Expandable
          {...common}
          status={common.status === "error" ? "error" : undefined}
          icon={<ListChecksIcon />}
          label="Updated the plan"
          meta={<span className="tabular-nums opacity-70">{done}/{todos.length}</span>}
          defaultOpen={latestPlan}
        >
          <Todos todos={todos} />
        </Expandable>
      );
    }
    case "Task":
    case "Agent":
      return (
        <Expandable {...common} icon={<BotIcon />} label={<>Delegated: {s(input.description) || s(input.subagent_type) || "a subtask"}</>}>
          <div className="space-y-2">
            {s(input.prompt) ? <Pre>{s(input.prompt)}</Pre> : null}
            {result?.text ? <Markdown className="rounded-lg border bg-card px-3 py-2 text-xs">{result.text}</Markdown> : null}
          </div>
        </Expandable>
      );
    default: {
      const mcp = call.name.startsWith("mcp__");
      return (
        <Expandable
          {...common}
          icon={mcp ? <PlugIcon /> : <WrenchIcon />}
          label={<>Used <span className="font-mono text-[11.5px] text-foreground/85">{mcp ? call.name.split("__").slice(1).join(" · ") : call.name}</span></>}
        >
          <div className="space-y-2">
            <Pre>{JSON.stringify(input, null, 2)}</Pre>
            {output}
          </div>
        </Expandable>
      );
    }
  }
}

function OutputBlock({ chunks, open: defaultOpen }: { chunks: Extract<WorkItem, { type: "output" }>["chunks"]; open: boolean }) {
  const preRef = useRef<HTMLPreElement>(null);
  const lines = useMemo(() => chunks.reduce((n, c) => n + (c.text.match(/\n/g)?.length ?? 0), 0), [chunks]);
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [chunks]);
  return (
    <Expandable
      icon={<TerminalIcon />}
      label="Output"
      meta={<span className="tabular-nums opacity-60">{Math.max(lines, 1)} {lines > 1 ? "lines" : "line"}</span>}
      defaultOpen={defaultOpen}
    >
      <pre
        ref={preRef}
        className="max-h-96 overflow-auto rounded-lg border bg-code p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-foreground/85"
      >
        {chunks.map((c, i) => (
          <span key={i} className={c.kind === "stderr" ? "text-destructive/90" : undefined}>
            {c.text}
          </span>
        ))}
      </pre>
    </Expandable>
  );
}

interface WorkContext {
  /** Whether this stretch of work is still going (the newest one, while the run is live). */
  live: boolean;
  /** Whether the run is live at all; a subagent that never reported back is only still working then. */
  runLive: boolean;
  latestPlanId?: string;
  /** Each top-level subagent's place, which picks its color (the same one the flow map uses). */
  lanes: Map<string, number>;
  /** A subagent picked on the flow map, to open and scroll to. */
  focus?: { id: string; n: number };
}

/** Consecutive subagent calls were started together and run side by side. */
type Segment = { type: "item"; item: WorkItem; last: boolean } | { type: "parallel"; calls: ToolCall[]; last: boolean };

function segments(items: WorkItem[]): Segment[] {
  const out: Segment[] = [];
  items.forEach((item, i) => {
    const last = i === items.length - 1;
    const prev = out.at(-1);
    if (item.type === "tool" && isSubagentTool(item.name)) {
      if (prev?.type === "parallel") {
        prev.calls.push(item);
        prev.last = last;
        return;
      }
      if (prev?.type === "item" && prev.item.type === "tool" && isSubagentTool(prev.item.name)) {
        out[out.length - 1] = { type: "parallel", calls: [prev.item, item], last };
        return;
      }
    }
    out.push({ type: "item", item, last });
  });
  return out;
}

/** Steps, tool calls and output, one line each; subagents as cards of their own. */
function WorkItems({ items, ctx }: { items: WorkItem[]; ctx: WorkContext }) {
  const { live, latestPlanId } = ctx;
  return (
    <>
      {segments(items).map((seg) => {
        if (seg.type === "parallel") return <ParallelAgents key={seg.calls[0]!.id} calls={seg.calls} ctx={ctx} />;
        const { item, last } = seg;
        switch (item.type) {
          case "step":
            return (
              <div
                key={item.id}
                className={cn(
                  "flex items-start gap-2 py-1 text-xs leading-relaxed",
                  item.kind === "error" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {item.kind === "error" ? (
                  <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <span className="flex size-3.5 shrink-0 items-center justify-center pt-[7px]">
                    <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                  </span>
                )}
                <span className="min-w-0 break-words">{item.text}</span>
              </div>
            );
          case "output":
            return <OutputBlock key={item.id} chunks={item.chunks} open={live && last} />;
          case "thinking":
            return (
              <Expandable key={item.id} icon={<BrainIcon />} label="Thought">
                <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{item.text}</p>
              </Expandable>
            );
          case "note":
            return (
              <div key={item.id} className="py-1 pl-5.5">
                <Markdown className="text-xs text-muted-foreground">{item.text}</Markdown>
              </div>
            );
          case "tool":
            if (item.children) return <SubagentCard key={item.id} call={item} ctx={ctx} />;
            return <ToolLine key={item.id} call={item} live={live} latestPlan={item.id === latestPlanId} />;
        }
      })}
    </>
  );
}

/** A run of work between the agent's messages. */
function WorkGroup({ items, ctx }: { items: WorkItem[]; ctx: WorkContext }) {
  return (
    <div className="rounded-xl border bg-card/40 px-3 py-1.5">
      <WorkItems items={items} ctx={ctx} />
    </div>
  );
}

/** Every tool call a subagent made, as a strip of colored ticks: blue reads, green edits, magenta commands. */
function ToolStrip({ calls, live }: { calls: ToolCall[]; live: boolean }) {
  const shown = calls.slice(-48);
  if (shown.length === 0) return null;
  return (
    <span className="flex h-2.5 items-end gap-[2px]" aria-hidden>
      {shown.map((c, i) => {
        const pending = !c.result && live;
        return (
          <span
            key={c.id}
            className={cn("flow-pop w-[3px] rounded-full", pending && i === shown.length - 1 && "animate-pulse")}
            style={{
              height: c.result?.isError ? 10 : toolKind(c.name) === "edit" ? 10 : toolKind(c.name) === "run" ? 8 : 6,
              background: c.result?.isError ? "var(--destructive)" : KIND_COLOR[toolKind(c.name)],
              opacity: pending ? 0.55 : 0.9,
            }}
          />
        );
      })}
    </span>
  );
}

function agentSummary(call: ToolCall, tools: ToolCall[]) {
  const took = call.stats?.durationMs ?? (call.doneAt ? call.doneAt.getTime() - call.at.getTime() : undefined);
  const count = call.stats?.toolUses ?? tools.length;
  const parts = [`${count} ${count === 1 ? "tool" : "tools"}`];
  if (took !== undefined) parts.unshift(duration(new Date(0), new Date(took)));
  if (call.stats?.tokens) parts.push(`${compact(call.stats.tokens)} tokens`);
  return parts.join(" · ");
}

/**
 * A subagent: what it was asked, what it is doing now (live), every tool it
 * used, and what it reported back. Its color matches its node on the flow map.
 */
function SubagentCard({ call, ctx }: { call: ToolCall; ctx: WorkContext }) {
  const { input, result } = call;
  const lane = ctx.lanes.get(call.id) ?? ctx.lanes.get(call.parentId ?? "") ?? 0;
  const color = laneColor(lane);
  const children = call.children ?? [];
  const tools = children.filter((c): c is ToolCall => c.type === "tool");
  const running = !result && ctx.runLive;
  const stopped = !result && !ctx.runLive;
  const lastTool = tools.at(-1);
  const now = running && lastTool ? describeCall(lastTool.name, lastTool.input) : undefined;
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ctx.focus?.id !== call.id) return;
    setOpen(true);
    setFlash((n) => n + 1);
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [ctx.focus, call.id]);

  return (
    <div
      ref={ref}
      id={`agent-${call.id}`}
      className="relative my-1.5 scroll-mt-20 overflow-hidden rounded-lg border bg-card"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />
      {flash ? (
        <span key={flash} aria-hidden className="flow-ring pointer-events-none absolute inset-0 rounded-lg border-2" style={{ borderColor: color }} />
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex w-full min-w-0 items-center gap-2.5 py-2 pr-2.5 pl-3.5 text-left"
      >
        <span
          className="relative flex size-7 shrink-0 items-center justify-center rounded-lg [&_svg]:size-3.5"
          style={{ background: `color-mix(in oklch, ${color} 16%, transparent)`, color }}
        >
          {running ? (
            <span aria-hidden className="flow-breathe absolute -inset-1 rounded-[10px] border-2" style={{ borderColor: color }} />
          ) : null}
          <BotIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-xs font-medium">{s(input.description) || "Subtask"}</span>
            <span className="shrink-0 text-[10.5px] text-muted-foreground">{s(input.subagent_type) || "agent"}</span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-2">
            <span className="relative block h-4 min-w-0 flex-1 overflow-hidden text-[11px] leading-4 text-muted-foreground">
              <span key={now ?? "summary"} className="flow-tick block truncate">
                {running
                  ? (now ?? "Starting…")
                  : stopped
                    ? "Stopped with the run"
                    : result?.isError
                      ? `Failed · ${agentSummary(call, tools)}`
                      : `Done · ${agentSummary(call, tools)}`}
              </span>
            </span>
          </span>
        </span>
        <span className="hidden shrink-0 sm:block">
          <ToolStrip calls={tools} live={running} />
        </span>
        <span className="flex size-4 shrink-0 items-center justify-center">
          {running ? (
            <Spinner className="size-3.5 text-muted-foreground" />
          ) : stopped ? (
            <CircleSlashIcon className="size-3.5 text-muted-foreground" />
          ) : result?.isError ? (
            <CircleAlertIcon className="size-3.5 text-destructive" />
          ) : (
            <CircleCheckIcon className="flow-check size-3.5 text-success" />
          )}
        </span>
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="border-t px-3.5 py-1.5">
          {s(input.prompt) ? (
            <Expandable icon={<FileTextIcon />} label="What it was asked">
              <Pre>{s(input.prompt)}</Pre>
            </Expandable>
          ) : null}
          {children.length ? (
            <WorkItems items={children} ctx={{ ...ctx, live: running }} />
          ) : (
            <p className="py-1 pl-5.5 text-xs text-muted-foreground">{running ? "Its steps show up here as it works." : "No steps were recorded."}</p>
          )}
          {result?.text ? (
            <div className="pt-1 pb-1.5">
              <div className="mb-1 pl-5.5 text-[11px] font-medium text-muted-foreground">What it reported</div>
              <Markdown className="ml-5.5 rounded-lg border bg-background px-3 py-2 text-xs">{result.text}</Markdown>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Subagents the agent started at once: a fan-out with each one's card on its own branch. */
function ParallelAgents({ calls, ctx }: { calls: ToolCall[]; ctx: WorkContext }) {
  const working = calls.filter((c) => !c.result && ctx.runLive).length;
  return (
    <div className="py-1">
      <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <svg viewBox="0 0 14 14" className="size-3.5" aria-hidden>
            <path d="M2 7h3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
            {calls.slice(0, 3).map((c, i) => {
              const y = calls.length === 1 ? 7 : 2.5 + (9 * i) / (Math.min(calls.length, 3) - 1);
              return (
                <path
                  key={c.id}
                  d={`M5 7 C8 7 8 ${y} 11 ${y}`}
                  stroke={laneColor(ctx.lanes.get(c.id) ?? 0)}
                  strokeWidth="1.4"
                  fill="none"
                  strokeLinecap="round"
                />
              );
            })}
          </svg>
        </span>
        <span>
          {working ? `${working} of ${calls.length} agents working in parallel` : `Ran ${calls.length} agents in parallel`}
        </span>
      </div>
      <div className="relative ml-[7px] border-l pl-3">
        {calls.map((call) => (
          <div key={call.id} className="relative">
            <span aria-hidden className="absolute top-[26px] -left-3 h-px w-3 bg-border" />
            <SubagentCard call={call} ctx={ctx} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A question the agent asked with ask_user: the options to pick from while it waits, then what was answered. */
function Question({
  call,
  live,
  onAnswer,
  sending,
}: {
  call: ToolCall;
  live: boolean;
  onAnswer: (text: string) => void;
  sending: boolean;
}) {
  const question = s(call.input.question);
  const options = Array.isArray(call.input.options) ? call.input.options.filter((o): o is string => typeof o === "string") : [];
  const waiting = !call.result && live;
  return (
    <div className={cn("rounded-xl border px-4 py-3", waiting ? "border-warning/40 bg-warning/5" : "bg-card/40")}>
      <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <MessageCircleQuestionIcon className={cn("size-3.5", waiting && "text-warning")} />
        {waiting ? "The agent is waiting for your answer" : call.result ? "The agent asked" : "The agent asked (no answer)"}
      </div>
      <Markdown>{question}</Markdown>
      {waiting && options.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {options.map((option) => (
            <Button key={option} variant="outline" size="sm" disabled={sending} onClick={() => onAnswer(option)}>
              {option}
            </Button>
          ))}
        </div>
      ) : null}
      {call.result ? (
        <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">Answer: </span>
          {firstLine(answerText(call.result.text))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The run's activity as a thread: the agent's messages, what it did between
 * them, the questions it asked and what you told it.
 */
export function RunActivity({
  blocks,
  live,
  onAnswer,
  sending,
  focusAgent,
}: {
  blocks: Block[];
  live: boolean;
  onAnswer: (text: string) => void;
  sending: boolean;
  focusAgent?: { id: string; n: number };
}) {
  // Only the newest plan is shown open; older ones stay one line.
  const latestPlanId = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]!;
      if (b.type !== "work") continue;
      const plan = b.items.findLast((item) => item.type === "tool" && item.name === "TodoWrite");
      if (plan) return plan.id;
    }
    return undefined;
  }, [blocks]);

  // Subagents take colors in the order they started, as on the flow map.
  const lanes = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of blocks) {
      if (b.type !== "work") continue;
      for (const item of b.items) if (item.type === "tool" && item.children && !item.parentId) map.set(item.id, map.size);
    }
    return map;
  }, [blocks]);

  return (
    <>
      {blocks.map((block, i) => {
        const lastBlock = i === blocks.length - 1;
        switch (block.type) {
          case "work":
            return (
              <WorkGroup key={block.id} items={block.items} ctx={{ live: live && lastBlock, runLive: live, latestPlanId, lanes, focus: focusAgent }} />
            );
          case "message":
            return <Markdown key={block.id} className="px-1">{block.text}</Markdown>;
          case "user":
            return (
              <div key={block.id} className="flex flex-col items-end gap-1">
                <div className="max-w-[85%] rounded-2xl rounded-br-md border bg-secondary px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                  {block.text}
                </div>
                <span className="text-[11px] text-muted-foreground" suppressHydrationWarning>
                  {ago(block.at)}
                </span>
              </div>
            );
          case "question":
            return <Question key={block.id} call={block.call} live={live} onAnswer={onAnswer} sending={sending} />;
          case "result":
            return (
              <div
                key={block.id}
                className={cn("flex flex-wrap items-center gap-x-2 px-1 text-[11px] text-muted-foreground", block.isError && "text-destructive")}
              >
                {block.isError ? <CircleAlertIcon className="size-3.5" /> : <CircleCheckIcon className="size-3.5 text-success" />}
                <span>{block.isError ? firstLine(block.text) || "The agent stopped with an error" : "Agent finished"}</span>
                {block.durationMs !== undefined ? <span>· {duration(new Date(0), new Date(block.durationMs))}</span> : null}
                {block.turns !== undefined ? <span>· {block.turns} turns</span> : null}
                {block.costUsd !== undefined ? <span>· ${block.costUsd.toFixed(2)}</span> : null}
              </div>
            );
        }
      })}
    </>
  );
}
