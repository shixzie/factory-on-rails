import { cn } from "@/lib/utils";

/** Two rails and a sleeper: the factory's mark. */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm",
        className,
      )}
    >
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M5 2.5 3.5 13.5M11 2.5l1.5 11M4.3 6h7.4M3.8 10h8.4" strokeLinecap="round" />
      </svg>
    </span>
  );
}
