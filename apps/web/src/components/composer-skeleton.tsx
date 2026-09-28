import { Skeleton } from "@/components/ui/skeleton";

export function ComposerSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl rounded-2xl border bg-card p-3">
      <Skeleton className="h-16 w-full bg-muted/60" />
      <div className="mt-3 flex gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-7 w-28" />
        <Skeleton className="ml-auto size-7 rounded-full" />
      </div>
    </div>
  );
}
