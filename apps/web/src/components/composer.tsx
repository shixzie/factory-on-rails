"use client";

import { ArrowUpIcon, BotIcon, GitBranchIcon, KeyRoundIcon, PlugIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Api, api, runInBrowser } from "@/lib/api";
import { cn } from "@/lib/utils";

const repoKey = (r: Pick<Api.ApiRepo, "installationId" | "fullName">) => `${r.installationId}:${r.fullName}`;

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * The prompt box pinned to the bottom of the main pane, as in t3code: a task,
 * then the agent, the repository and base branch it runs against, and send.
 */
export function Composer({
  me,
  repos,
  reposError,
  defaultRepo,
  defaultBaseBranch,
  defaultAgent,
  placeholder = "Describe the change you want. The agent works in its own sandbox and opens a pull request.",
  autoFocus,
}: {
  me: Api.Me;
  repos: ReadonlyArray<Api.ApiRepo>;
  /** Why the repository list could not be loaded, if it couldn't. */
  reposError?: string | null;
  defaultRepo?: string;
  defaultBaseBranch?: string;
  /** The agent to start on (the one used last); otherwise the first one the user can run. */
  defaultAgent?: Api.AgentId;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const initial = repos.find((r) => r.fullName === defaultRepo) ?? repos[0];
  const [repo, setRepo] = useState(initial ? repoKey(initial) : "");
  const [baseBranch, setBaseBranch] = useState(defaultBaseBranch ?? "");
  const [agent, setAgent] = useState<Api.AgentId>(
    () => (me.agents.find((a) => a.id === defaultAgent && a.ready) ?? me.agents.find((a) => a.ready) ?? me.agents[0])?.id ?? "claude",
  );
  const [task, setTask] = useState("");
  const [pending, startTransition] = useTransition();

  const selected = repos.find((r) => repoKey(r) === repo);
  const agentReady = me.agents.find((a) => a.id === agent)?.ready ?? false;
  const blocked = !me.hasApiKey || repos.length === 0;
  const canSend = !blocked && agentReady && !!selected && task.trim().length > 0 && !pending;

  const submit = () => {
    if (!canSend || !selected) return;
    startTransition(async () => {
      const result = await runInBrowser(
        api.createRun({
          installationId: selected.installationId,
          repo: selected.fullName,
          task,
          baseBranch: baseBranch.trim() || undefined,
          agent,
        }),
      );
      if (result._tag === "Left") {
        toast.error(result.left.message);
        if (result.left.code === "api_key_required") router.push("/settings");
        return;
      }
      setTask("");
      router.push(`/runs/${result.right.id}`);
      router.refresh();
    });
  };

  const items = repos.map((r) => ({ value: repoKey(r), label: r.fullName }));
  const agentItems = me.agents.map((a) => ({ value: a.id, label: a.label }));
  const agentLabel = Api.AGENT_LABELS[agent];

  return (
    <div className="mx-auto w-full max-w-3xl">
      {!me.hasApiKey ? (
        <Notice icon={<KeyRoundIcon />}>
          Runs use your own model API key. <Link href="/settings" className="font-medium text-foreground underline underline-offset-4">Add it in Settings</Link> to start one.
        </Notice>
      ) : !agentReady ? (
        <Notice icon={<KeyRoundIcon />}>
          {agentLabel} needs your key.{" "}
          <Link href="/settings" className="font-medium text-foreground underline underline-offset-4">Add it in Settings</Link> or pick another agent.
        </Notice>
      ) : reposError ? (
        <Notice icon={<PlugIcon />}>Couldn&apos;t load your repositories from GitHub: {reposError} Reload to try again.</Notice>
      ) : repos.length === 0 ? (
        <Notice icon={<PlugIcon />}>
          The GitHub App can't see any of your repositories yet.{" "}
          <a href={me.installUrl} className="font-medium text-foreground underline underline-offset-4">
            Install it
          </a>{" "}
          on the repos the factory should work on, then reload.
        </Notice>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className={cn(
          "rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-ring/60 dark:shadow-none",
          blocked && "opacity-60",
        )}
      >
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          disabled={blocked || pending}
          autoFocus={autoFocus}
          rows={3}
          placeholder={placeholder}
          aria-label="Task"
          className="field-sizing-content block max-h-80 min-h-20 w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
        />
        <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
          <Select items={agentItems} value={agent} onValueChange={(v) => v && setAgent(v as Api.AgentId)} disabled={blocked || pending}>
            <SelectTrigger
              size="sm"
              aria-label="Agent"
              className="border-transparent bg-transparent text-xs text-muted-foreground hover:bg-accent dark:bg-transparent"
            >
              <BotIcon className="size-3.5" />
              <SelectValue placeholder="Agent" />
            </SelectTrigger>
            <SelectContent>
              {me.agents.map((a) => (
                <SelectItem key={a.id} value={a.id} className="text-xs">
                  {a.label}
                  {a.ready ? null : <span className="text-muted-foreground">(needs a key)</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select items={items} value={repo} onValueChange={(v) => setRepo(String(v ?? ""))} disabled={blocked || pending}>
            <SelectTrigger
              size="sm"
              aria-label="Repository"
              className="max-w-64 border-transparent bg-transparent text-xs text-muted-foreground hover:bg-accent dark:bg-transparent"
            >
              <GitHubMark className="size-3.5" />
              <SelectValue placeholder="Repository" />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value} className="text-xs">
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent focus-within:bg-accent">
            <GitBranchIcon className="size-3.5 shrink-0" />
            <input
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              disabled={blocked || pending}
              placeholder={selected?.defaultBranch ?? "base branch"}
              aria-label="Base branch"
              className="w-28 bg-transparent outline-none placeholder:text-muted-foreground/70"
            />
          </label>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd>
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button type="submit" size="icon-sm" className="rounded-full" disabled={!canSend} aria-label="Start run" />
                }
              >
                {pending ? <Spinner /> : <ArrowUpIcon />}
              </TooltipTrigger>
              <TooltipContent>Start run</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </form>
    </div>
  );
}

function Notice({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mx-3 -mb-px flex items-center gap-2 rounded-t-xl border border-b-0 bg-muted/60 px-3 py-2 text-xs text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
      {icon}
      <span>{children}</span>
    </div>
  );
}
