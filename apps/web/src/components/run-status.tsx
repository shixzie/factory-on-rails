import { Api } from "@/lib/api";
import { cn } from "@/lib/utils";

const LABEL: Record<Api.RunStatus, string> = {
  queued: "Queued",
  running: "Working",
  cancelling: "Cancelling",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Tinted chips, the way Railway badges a deployment (ACTIVE, DEPLOYING, FAILED). */
const TONE: Record<Api.RunStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-info/15 text-info",
  cancelling: "bg-warning/15 text-warning",
  succeeded: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

const DOT: Record<Api.RunStatus, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-info animate-pulse",
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

/** A dot and a word on a chip tinted by state. */
export function StatusLabel({ status, awaiting, className }: { status: Api.RunStatus; awaiting?: boolean; className?: string }) {
  const input = needsInput(status, awaiting);
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-sm px-1.5 text-[11px] font-medium tracking-wide uppercase",
        input ? "bg-warning/15 text-warning" : TONE[status],
        className,
      )}
    >
      <StatusDot status={status} awaiting={awaiting} />
      {input ? "Needs input" : LABEL[status]}
    </span>
  );
}

const SANDBOX: Record<Exclude<Api.SandboxState, "none">, { label: string; dot: string; hint: string }> = {
  running: {
    label: "Sandbox running",
    dot: "bg-success",
    hint: `The sandbox stops after ${Api.SANDBOX_IDLE_STOP_MINUTES} minutes without activity and keeps its files.`,
  },
  stopping: { label: "Sandbox stopping", dot: "bg-warning animate-pulse", hint: "The sandbox is saving its files before it stops." },
  stopped: {
    label: "Sandbox stopped",
    dot: "bg-muted-foreground/50",
    hint: "The sandbox is stopped with its files saved. Sending a message starts it again.",
  },
  deleted: {
    label: "Sandbox deleted",
    dot: "bg-muted-foreground/30",
    hint: "The sandbox was deleted. Your next message starts a new one from the run's branch.",
  },
};

/** Whether the run's sandbox is up, stopped or gone, with what that means on hover. */
export function SandboxLabel({ state, className }: { state: Api.SandboxState; className?: string }) {
  if (state === "none") return null;
  const { label, dot, hint } = SANDBOX[state];
  return (
    <span title={hint} className={cn("inline-flex items-center gap-1.5 text-[11px] text-muted-foreground", className)}>
      <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", dot)} />
      {label}
    </span>
  );
}

export function sandboxHint(state: Api.SandboxState): string | undefined {
  return state === "none" ? undefined : SANDBOX[state].hint;
}
