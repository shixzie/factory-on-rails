"use client";

import {
  BotIcon,
  BrainIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
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
import { answerText, repoPath, type Block, type ToolCall, type WorkItem } from "@/lib/activity";
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
  indent,
  children,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  meta?: React.ReactNode;
  status?: "pending" | "error" | "done";
  defaultOpen?: boolean;
  indent?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen((o) => o || defaultOpen), [defaultOpen]);
  const expandable = !!children;
  return (
    <div className={cn("py-0.5", indent && "ml-3 border-l pl-3")}>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
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
  const common = { status: status as "pending" | "error" | "done" | undefined, indent: !!call.parentId };

  switch (call.name) {
    case "Bash":
      return (
        <Expandable
          {...common}
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

/** A run of work between the agent's messages: steps, tool calls and output, one line each. */
function WorkGroup({ items, live, latestPlanId }: { items: WorkItem[]; live: boolean; latestPlanId?: string }) {
  return (
    <div className="rounded-xl border bg-card/40 px-3 py-1.5">
      {items.map((item, i) => {
        const last = i === items.length - 1;
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
              <Expandable key={item.id} icon={<BrainIcon />} label="Thought" indent={!!item.parentId}>
                <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">{item.text}</p>
              </Expandable>
            );
          case "note":
            return (
              <div key={item.id} className="ml-3 border-l py-1 pl-3">
                <Markdown className="text-xs text-muted-foreground">{item.text}</Markdown>
              </div>
            );
          case "tool":
            return <ToolLine key={item.id} call={item} live={live} latestPlan={item.id === latestPlanId} />;
        }
      })}
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
}: {
  blocks: Block[];
  live: boolean;
  onAnswer: (text: string) => void;
  sending: boolean;
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

  return (
    <>
      {blocks.map((block, i) => {
        const lastBlock = i === blocks.length - 1;
        switch (block.type) {
          case "work":
            return <WorkGroup key={block.id} items={block.items} live={live && lastBlock} latestPlanId={latestPlanId} />;
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
