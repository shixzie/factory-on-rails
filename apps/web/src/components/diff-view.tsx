"use client";

import { ChevronRightIcon, FileCodeIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { Api } from "@/lib/api";
import { diffTotals, parseDiff, type DiffFile, type DiffLine } from "@/lib/diff";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

const LINE_TONE: Record<DiffLine["type"], string> = {
  add: "bg-success/10 text-foreground dark:bg-success/15",
  del: "bg-destructive/10 text-foreground dark:bg-destructive/15",
  ctx: "text-foreground/80",
  note: "text-muted-foreground italic",
};

const SIGN: Record<DiffLine["type"], string> = { add: "+", del: "-", ctx: " ", note: "" };

/** "+12 −3", green and red, as t3code shows a change's size. */
export function DiffStat({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) {
  return (
    <span className={cn("inline-flex gap-1.5 font-mono text-[11px] tabular-nums", className)}>
      <span className="text-success">+{additions}</span>
      <span className="text-destructive">−{deletions}</span>
    </span>
  );
}

/** Diff lines in a monospace grid, with line numbers when they are known. */
export function DiffLines({ lines, numbers = true }: { lines: ReadonlyArray<DiffLine>; numbers?: boolean }) {
  return (
    <div className="min-w-fit font-mono text-[12px] leading-5">
      {lines.map((line, i) => (
        <div key={i} className={cn("flex", LINE_TONE[line.type])}>
          {numbers ? (
            <>
              <span className="w-10 shrink-0 pr-2 text-right text-muted-foreground/60 select-none">{line.oldNo ?? ""}</span>
              <span className="w-10 shrink-0 pr-2 text-right text-muted-foreground/60 select-none">{line.newNo ?? ""}</span>
            </>
          ) : null}
          <span
            className={cn(
              "w-4 shrink-0 text-center select-none",
              line.type === "add" ? "text-success" : line.type === "del" ? "text-destructive" : "text-muted-foreground/50",
            )}
          >
            {SIGN[line.type]}
          </span>
          <span className="pr-4 whitespace-pre">{line.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

const STATUS_LABEL: Record<DiffFile["status"], string> = { added: "A", deleted: "D", modified: "M", renamed: "R" };
const STATUS_TONE: Record<DiffFile["status"], string> = {
  added: "text-success",
  deleted: "text-destructive",
  modified: "text-warning",
  renamed: "text-info",
};

function FileDiff({ file, open, onToggle }: { file: DiffFile; open: boolean; onToggle: () => void }) {
  return (
    <div id={`diff-${file.path}`} className="scroll-mt-2 overflow-hidden rounded-lg border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="sticky top-0 z-[1] flex w-full items-center gap-2 border-b bg-card px-3 py-2 text-left text-xs hover:bg-accent"
      >
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className={cn("w-3 shrink-0 font-mono text-[11px] font-semibold", STATUS_TONE[file.status])}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
          {file.oldPath ? <span className="text-muted-foreground">{file.oldPath} → </span> : null}
          {file.path}
        </span>
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </button>
      {open ? (
        file.binary ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">Binary file</div>
        ) : file.hunks.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">No content changes</div>
        ) : (
          <div className="overflow-x-auto bg-code py-1">
            {file.hunks.map((hunk, i) => (
              <div key={i}>
                <div className="px-3 py-1 font-mono text-[11px] text-info/80">{hunk.header}</div>
                <DiffLines lines={hunk.lines} />
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

export function useDiffFiles(diff: Api.ApiRunDiff | null) {
  return useMemo(() => (diff ? parseDiff(diff.patch) : []), [diff]);
}

/**
 * The run's changes, file by file, like t3code's diff panel (the Diff tab of
 * the run's side panel). `focus` scrolls to a file.
 */
export function DiffPane({
  diff,
  files,
  live,
  focus,
}: {
  diff: Api.ApiRunDiff | null;
  files: DiffFile[];
  live: boolean;
  focus?: { path: string; n: number };
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const totals = diffTotals(files);

  useEffect(() => {
    if (!focus) return;
    setClosed((c) => {
      const next = new Set(c);
      next.delete(focus.path);
      return next;
    });
    requestAnimationFrame(() => document.getElementById(`diff-${focus.path}`)?.scrollIntoView({ block: "start" }));
  }, [focus]);

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <FileCodeIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <DiffStat additions={totals.additions} deletions={totals.deletions} />
        {diff ? (
          <span className="text-muted-foreground" suppressHydrationWarning>
            · {live ? "updated" : "as of"} {ago(diff.updatedAt)}
          </span>
        ) : null}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {diff?.truncated ? (
          <p className="mb-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            The diff was too large to store in full, so some files are missing here. The pull request has everything.
          </p>
        ) : null}
        {files.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {live ? "No files changed yet. They show up here as the agent edits them." : "This run did not change any files."}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {files.map((file) => (
              <FileDiff
                key={file.path}
                file={file}
                open={!closed.has(file.path)}
                onToggle={() =>
                  setClosed((c) => {
                    const next = new Set(c);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                  })
                }
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** The files a turn changed, as a compact list under the thread; each opens the diff panel at that file. */
export function ChangedFiles({ files, onOpen }: { files: DiffFile[]; onOpen: (path?: string) => void }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const totals = diffTotals(files);
  if (files.length === 0) return null;
  return (
    <div className="rounded-lg border bg-card/40">
      <div className="flex items-center text-xs font-medium text-muted-foreground">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={listId}
          className="flex min-w-0 flex-1 items-center gap-2 px-3.5 py-2.5 text-left hover:text-foreground"
        >
          <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
          <span>
            {files.length} {files.length === 1 ? "file" : "files"} changed
          </span>
          <DiffStat additions={totals.additions} deletions={totals.deletions} />
        </button>
        <button type="button" onClick={() => onOpen()} className="shrink-0 px-3.5 py-2.5 hover:text-foreground">
          View diff
        </button>
      </div>
      <div id={listId} hidden={!open} className="max-h-[min(15rem,30dvh)] overflow-y-auto overscroll-contain border-t px-1.5 py-1.5">
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            onClick={() => onOpen(file.path)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-accent"
          >
            <span className={cn("w-3 shrink-0 font-mono text-[11px] font-semibold", STATUS_TONE[file.status])}>
              {STATUS_LABEL[file.status]}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-foreground/85">{file.path}</span>
            <DiffStat additions={file.additions} deletions={file.deletions} />
          </button>
        ))}
      </div>
    </div>
  );
}
