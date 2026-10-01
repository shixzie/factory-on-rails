"use client";

import { ExternalLinkIcon, GitPullRequestIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Api, api, runInBrowser } from "@/lib/api";
import { threadPullRequests } from "@/lib/threads";
import { PullRequestStatus } from "@/components/pull-request-status";

/** Older harness versions only return the latest URL. */
export function pullRequests(run: Api.ApiRun): readonly string[] {
  return threadPullRequests(run).map((pr) => pr.url);
}

export function RunPullRequests({ run, onLinked }: { run: Api.ApiRun; onLinked: (run: Api.ApiRun) => void }) {
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const prs = threadPullRequests(run);

  const link = async () => {
    if (saving || !url.trim()) return;
    setSaving(true);
    const result = await runInBrowser(api.linkPullRequest(run.id, url.trim()));
    setSaving(false);
    if (result._tag === "Left") {
      toast.error(result.left.message);
      return;
    }
    onLinked(result.right);
    setUrl("");
  };

  return (
    <details className="relative">
      <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium hover:bg-accent focus-visible:outline-ring">
        <GitPullRequestIcon className="size-4" />
        <span>PRs{prs.length ? ` (${prs.length})` : ""}</span>
      </summary>
      <div className="absolute right-0 top-full z-20 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-3 text-popover-foreground shadow-md">
        <div className="mb-2 text-sm font-medium">Pull requests</div>
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {prs.map((pr) => (
            <a key={pr.url} href={pr.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded px-1 py-1.5 text-xs hover:bg-accent">
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="break-all">{pr.url.replace("https://github.com/", "")}</span>
                <PullRequestStatus pr={pr} />
              </span>
              <ExternalLinkIcon className="size-3 shrink-0" />
            </a>
          ))}
          {!prs.length && <p className="text-xs text-muted-foreground">No pull requests linked yet.</p>}
        </div>
        <form className="mt-3 space-y-2 border-t pt-3" onSubmit={(e) => { e.preventDefault(); void link(); }}>
          <label htmlFor="link-pr-url" className="text-xs font-medium">Link a pull request</label>
          <Input id="link-pr-url" type="url" required placeholder="https://github.com/owner/repo/pull/123" value={url} onChange={(e) => setUrl(e.target.value)} disabled={saving} />
          <Button type="submit" size="sm" disabled={saving || !url.trim()}>{saving ? "Linking…" : "Link PR"}</Button>
        </form>
      </div>
    </details>
  );
}
