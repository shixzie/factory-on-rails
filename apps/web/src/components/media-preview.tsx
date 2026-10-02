"use client";

import { ExternalLinkIcon, FileTextIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { Api } from "@/lib/api";
import type { DiffFile } from "@/lib/diff";
import { mediaUrl, probeDelays } from "@/lib/media";
import { cn } from "@/lib/utils";

/** Transparent pixels show as a checkerboard, so a transparent PNG doesn't vanish into the page. */
const CHECKERBOARD = {
  backgroundImage: "repeating-conic-gradient(var(--muted) 0% 25%, transparent 0% 50%)",
  backgroundSize: "16px 16px",
} as const;

type Availability = "checking" | "ready" | "missing";

/**
 * Whether a preview exists yet. While the run is live the runner copies a
 * file out of the sandbox just after the diff that names it is saved, so a
 * 404 is retried a few times before the file counts as having no preview
 * (too large, or never copied). Once the run is done, a 404 is final.
 */
function useAvailability(url: string, live: boolean): Availability {
  const [state, setState] = useState<{ url: string; value: Availability }>({ url, value: "checking" });
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (n: number) => {
      const response = await fetch(url, { headers: { range: "bytes=0-0" }, cache: "no-store" }).catch(() => undefined);
      if (cancelled) return;
      if (response?.ok) return setState({ url, value: "ready" });
      const delay = probeDelays[n];
      if (response?.status === 404 && live && delay !== undefined) timer = setTimeout(() => void attempt(n + 1), delay);
      else setState({ url, value: "missing" });
    };
    void attempt(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, live]);
  return state.url === url ? state.value : "checking";
}

/** One image, video or PDF from a run, for its owner (the harness checks). */
export function MediaPreview({
  runId,
  sha,
  mediaType,
  label,
  live,
  size = "md",
}: {
  runId: string;
  sha: string;
  mediaType: Api.MediaType;
  label: string;
  /** The run is still going, so a preview that isn't there may be on its way. */
  live: boolean;
  size?: "sm" | "md";
}) {
  const url = mediaUrl(runId, sha);
  const availability = useAvailability(url, live);
  const kind = Api.mediaKind(mediaType);
  const box = size === "sm" ? "max-h-40" : "max-h-80";

  if (availability !== "ready") {
    return (
      <div className={cn("flex items-center gap-2 rounded-md border border-dashed px-3 text-xs text-muted-foreground", size === "sm" ? "h-12" : "h-16")}>
        {availability === "checking" ? <Spinner className="size-3" /> : null}
        {availability === "checking" ? "Loading preview" : "No preview for this file (it may be too large)"}
      </div>
    );
  }
  if (kind === "video") {
    return (
      <video src={url} controls preload="metadata" playsInline aria-label={label} className={cn("max-w-full rounded-md border bg-black", box)} />
    );
  }
  if (kind === "pdf") {
    return (
      <div className="overflow-hidden rounded-md border">
        <iframe src={url} title={label} className={cn("block w-full bg-white", size === "sm" ? "h-60" : "h-[28rem]")} />
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 border-t px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <FileTextIcon className="size-3.5" />
          Open PDF
          <ExternalLinkIcon className="size-3" />
        </a>
      </div>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${label}`}
      className="block w-fit max-w-full overflow-hidden rounded-md border focus-visible:outline-2 focus-visible:outline-ring"
      style={CHECKERBOARD}
    >
      <img src={url} alt={label} loading="lazy" className={cn("block max-w-full object-contain", box)} />
    </a>
  );
}

/** A changed file's preview: what it looks like now, beside what it looked like before when both exist. */
export function FilePreview({ runId, file, mediaType, live }: { runId: string; file: DiffFile; mediaType: Api.MediaType; live: boolean }) {
  const before = file.status === "added" ? undefined : file.oldSha;
  const after = file.status === "deleted" ? undefined : file.newSha;
  const sides = [
    before && before !== after ? { label: "Before", sha: before } : undefined,
    after ? { label: before && before !== after ? "After" : undefined, sha: after } : undefined,
  ].filter((side) => side !== undefined);
  if (sides.length === 0) return null;
  const sideBySide = sides.length > 1 && Api.mediaKind(mediaType) === "image";
  return (
    <div className={cn("grid gap-3 p-3", sideBySide && "sm:grid-cols-2")}>
      {sides.map((side) => (
        <figure key={side.sha} className="min-w-0 space-y-1.5">
          {side.label ? <figcaption className="text-[11px] font-medium text-muted-foreground uppercase">{side.label}</figcaption> : null}
          <MediaPreview runId={runId} sha={side.sha} mediaType={mediaType} live={live} label={`${file.path}${side.label ? ` (${side.label.toLowerCase()})` : ""}`} />
        </figure>
      ))}
    </div>
  );
}

/** Images (screenshots, files it read) a tool result showed the agent. */
export function ToolMedia({ runId, media, label, live }: { runId: string; media: readonly Api.MediaRef[]; label: string; live: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {media.map((item, i) => (
        <MediaPreview key={`${item.sha}-${i}`} runId={runId} sha={item.sha} mediaType={item.mediaType} label={label} live={live} size="sm" />
      ))}
    </div>
  );
}
