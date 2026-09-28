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

export function StatusDot({ status, className }: { status: Api.RunStatus; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT[status], className)} />;
}

/** A dot and a word, colored by state, the way t3code labels a thread. */
export function StatusLabel({ status, className }: { status: Api.RunStatus; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", TONE[status], className)}>
      <StatusDot status={status} />
      {LABEL[status]}
    </span>
  );
}
