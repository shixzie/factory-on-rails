"use client";

import { PencilIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Api, api, runInBrowser } from "@/lib/api";
import { runTitle } from "@/lib/format";

/**
 * The run's name in its header. Clicking it renames the run: Enter or leaving
 * the field saves, Escape keeps the old name. A name the user gives is never
 * replaced by a generated one.
 */
export function RunTitle({ run, onRenamed }: { run: Api.ApiRun; onRenamed: (run: Api.ApiRun) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Enter, blur and Escape can all end one edit; only the first one counts.
  const settled = useRef(false);
  const title = runTitle(run);

  const edit = () => {
    settled.current = false;
    setDraft(run.title ?? title);
    setEditing(true);
  };

  const save = async () => {
    if (settled.current) return;
    settled.current = true;
    const next = draft.replace(/\s+/g, " ").trim();
    if (!next || next === title) {
      setEditing(false);
      return;
    }
    const result = await runInBrowser(api.renameRun(run.id, next));
    if (result._tag === "Left") {
      toast.error(result.left.message);
      settled.current = false;
      return;
    }
    onRenamed(result.right);
    setEditing(false);
  };

  const cancel = () => {
    settled.current = true;
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={edit}
        title="Rename this run"
        className="group/title -mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="truncate font-medium">{title}</span>
        <PencilIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100" />
      </button>
    );
  }

  return (
    <form
      className="min-w-0 flex-1 sm:max-w-md"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Input
        autoFocus
        aria-label="Run name"
        value={draft}
        maxLength={Api.RUN_TITLE_MAX_CHARS}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
        }}
        className="h-7 font-medium"
      />
    </form>
  );
}
