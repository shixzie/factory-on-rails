import type { Api } from "@/lib/api";
import { cn } from "@/lib/utils";

const LABEL: Record<Api.RunStatus, string> = {
  queued: "Queued",
  running: "Working",
  cancelling: "Cancelling",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const TONE: Record<Api.RunStatus, string> = {
  queued: "text-muted-foreground",
  running: "text-sky-600 dark:text-sky-400",
  cancelling: "text-warning",
  succeeded: "text-success",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

const DOT: Record<Api.RunStatus, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-sky-500 animate-pulse",
  cancelling: "bg-warning animate-pulse",
  succeeded: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/30",
};

export const isActive = (status: Api.RunStatus) => status === "queued" || status === "running" || status === "cancelling";

/** A live run whose agent asked a question and is waiting for the user. */
const needsInput = (status: Api.RunStatus, awaiting?: boolean) => !!awaiting && status === "running";

export function StatusDot({ status, awaiting, className }: { status: Api.RunStatus; awaiting?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        needsInput(status, awaiting) ? "bg-warning animate-pulse" : DOT[status],
        className,
      )}
    />
  );
}

/** A dot and a word, colored by state, the way t3code labels a thread. */
export function StatusLabel({ status, awaiting, className }: { status: Api.RunStatus; awaiting?: boolean; className?: string }) {
  const input = needsInput(status, awaiting);
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", input ? "text-warning" : TONE[status], className)}>
      <StatusDot status={status} awaiting={awaiting} />
      {input ? "Needs input" : LABEL[status]}
    </span>
  );
}
