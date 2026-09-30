"use client";

import {
  ArchiveIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  SunIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";
import { Logo } from "@/components/logo";
import { NewThreadLink } from "@/components/new-thread-link";
import { ThreadPullRequestStatus } from "@/components/pull-request-status";
import { StatusDot } from "@/components/run-status";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { api, runInBrowser, type Api } from "@/lib/api";
import { runTitle, shortAge } from "@/lib/format";
import { sidebarThreads, threadActivityLabel, visibleRecentThreads, type RepoThreads } from "@/lib/threads";
import { cn } from "@/lib/utils";

const RUNS_PER_REPO = 6;

/** Refresh across every page, including when a PR merges after its run has finished. */
function useSidebarRuns(initial: readonly Api.ApiRun[]) {
  const [runs, setRuns] = useState(initial);
  useEffect(() => {
    setRuns(initial);
    let stopped = false;
    let pending = false;
    const refresh = async () => {
      if (document.visibilityState === "hidden" || pending) return;
      pending = true;
      try {
        const result = await runInBrowser(api.runs);
        if (!stopped && result._tag === "Right") setRuns(result.right);
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => void refresh(), 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [initial]);
  return runs;
}

function RecentThread({ run, selectedId }: { run: Api.ApiRun; selectedId: string | null }) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        isActive={run.id === selectedId}
        render={<Link href={`/runs/${run.id}`} aria-current={run.id === selectedId ? "page" : undefined} />}
        className="h-auto min-h-11 flex-col items-stretch gap-1 py-1.5 pr-1.5"
        title={runTitle(run, 200)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot status={run.status} awaiting={run.awaitingInput} />
          <span className="truncate">{runTitle(run, 60)}</span>
          <span className="sr-only">{threadActivityLabel(run)}</span>
        </span>
        <span className="flex items-center gap-2 pl-3.5">
          <ThreadPullRequestStatus run={run} />
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums" suppressHydrationWarning>
            {shortAge(run.lastActivityAt ?? run.createdAt)}
          </span>
        </span>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

function ActiveThread({ run, selectedId }: { run: Api.ApiRun; selectedId: string | null }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={run.id === selectedId}
        render={<Link href={`/runs/${run.id}`} aria-current={run.id === selectedId ? "page" : undefined} />}
        title={runTitle(run, 200)}
        className={cn(
          "h-auto min-h-20 flex-col items-stretch gap-1.5 border border-info/15 bg-info/5 py-2.5",
          run.awaitingInput && "border-warning/25 bg-warning/5",
        )}
      >
        <span className="flex min-w-0 items-center gap-2 font-medium">
          <StatusDot status={run.status} awaiting={run.awaitingInput} />
          <span className="truncate">{runTitle(run, 60)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-2 text-[11px]">
          <span className="truncate text-muted-foreground">{run.repo}</span>
          <span className={cn("ml-auto shrink-0 font-medium text-info", run.awaitingInput && "text-warning")}>
            {threadActivityLabel(run)}
          </span>
        </span>
        <ThreadPullRequestStatus run={run} />
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function RepoRuns({ group, activeRunId }: { group: RepoThreads; activeRunId: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [owner, name] = group.repo.split("/");
  const shown = visibleRecentThreads(group.recent, expanded, activeRunId, RUNS_PER_REPO);
  const hiddenCount = group.recent.length - shown.length;
  const hasSelected = group.recent.some((r) => r.id === activeRunId);
  return (
    <Collapsible defaultOpen render={<SidebarMenuItem />} className="group/collapsible">
      <CollapsibleTrigger
        render={<SidebarMenuButton className="text-sidebar-foreground/80" />}
        data-active={hasSelected || undefined}
      >
        <ChevronRightIcon className="size-3.5! text-muted-foreground transition-transform group-data-open/collapsible:rotate-90" />
        <span className="truncate">
          <span className="font-medium">{name}</span>
          <span className="ml-1.5 text-xs text-muted-foreground">{owner}</span>
        </span>
      </CollapsibleTrigger>
      <SidebarMenuAction
        showOnHover
        render={<NewThreadLink repo={group.repo} />}
        title={`New thread in ${group.repo}`}
        aria-label={`New thread in ${group.repo}`}
        className="[@media(hover:none)]:opacity-100"
      >
        <PlusIcon />
      </SidebarMenuAction>
      <CollapsibleContent>
        <SidebarMenuSub className="mr-0 pr-0">
          {shown.map((run) => <RecentThread key={run.id} run={run} selectedId={activeRunId} />)}
          {hiddenCount > 0 || expanded ? (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                render={<button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} />}
                className="h-7 text-xs text-muted-foreground"
              >
                {expanded ? "Show less" : `Show ${hiddenCount} more`}
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ) : null}
          {!group.recent.length && group.activeCount > 0 ? (
            <SidebarMenuSubItem className="px-2 py-1 text-xs text-muted-foreground">
              {group.activeCount} active {group.activeCount === 1 ? "thread" : "threads"} above
            </SidebarMenuSubItem>
          ) : null}
          {group.settled.length > 0 ? (
            <Collapsible render={<SidebarMenuSubItem />} className="group/settled">
              <CollapsibleTrigger render={<SidebarMenuSubButton render={<button type="button" />} className="h-7 w-full text-xs text-muted-foreground" />}>
                <ArchiveIcon className="size-3!" />
                <span>Settled ({group.settled.length})</span>
                <ChevronRightIcon className="ml-auto size-3! transition-transform group-data-open/settled:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarMenuSub className="mx-0 border-0 px-0">
                  {group.settled.map((run) => <RecentThread key={run.id} run={run} selectedId={activeRunId} />)}
                </SidebarMenuSub>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}

async function signOut() {
  await fetch("/auth/logout", { method: "POST", redirect: "manual" }).catch(() => undefined);
  window.location.assign("/login");
}

function UserMenu({ me }: { me: Api.Me }) {
  const { theme, setTheme } = useTheme();
  const { login, name, avatarUrl } = me.user;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
        <Avatar className="size-7 rounded-md">
          {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
          <AvatarFallback className="rounded-md text-xs">{login.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="grid min-w-0 flex-1 text-left leading-tight">
          <span className="truncate text-sm font-medium">{name ?? login}</span>
          <span className="truncate text-xs text-muted-foreground">@{login}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-(--anchor-width) min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={(v) => setTheme(String(v))}>
            <DropdownMenuRadioItem value="system">
              <MonitorIcon /> System
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">
              <SunIcon /> Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <MoonIcon /> Dark
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut}>
          <LogOutIcon /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppSidebar({ me, runs }: { me: Api.Me; runs: ReadonlyArray<Api.ApiRun> }) {
  const pathname = usePathname();
  const activeRunId = pathname.startsWith("/runs/") ? (pathname.split("/")[2] ?? null) : null;
  const currentRuns = useSidebarRuns(runs);
  const { active, repos: groups } = useMemo(() => sidebarThreads(currentRuns, activeRunId), [currentRuns, activeRunId]);

  return (
    <Sidebar collapsible="offcanvas" variant="inset">
      <SidebarHeader className="gap-3 px-3 pt-3">
        <Link href="/" className="flex items-center gap-2 px-1">
          <Logo />
          <span className="text-sm font-semibold tracking-tight">Factory on Rails</span>
        </Link>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              variant="outline"
              isActive={pathname === "/"}
              render={<NewThreadLink />}
              className="bg-sidebar-accent/40"
            >
              <SquarePenIcon />
              <span>New thread</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {active.length > 0 ? (
          <SidebarGroup>
            <SidebarGroupLabel className="text-foreground">
              Active
              <span className="ml-2 rounded bg-info/10 px-1.5 text-[10px] font-semibold text-info">{active.length}</span>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {active.map((run) => <ActiveThread key={run.id} run={run} selectedId={activeRunId} />)}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}
        <SidebarGroup>
          <SidebarGroupLabel>Repositories</SidebarGroupLabel>
          <SidebarGroupAction render={<Link href="/repos/new" />} title="Create a repository">
            <FolderPlusIcon />
            <span className="sr-only">Create a repository</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            {groups.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-3 py-8 text-center text-xs text-muted-foreground">
                <FolderGit2Icon className="size-5 opacity-60" />
                Runs you start show up here, grouped by repository.
              </div>
            ) : (
              <SidebarMenu>
                {groups.map((group) => (
                  <RepoRuns key={group.repo} group={group} activeRunId={activeRunId} />
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname === "/settings"} render={<Link href="/settings" />}>
              <SettingsIcon />
              <span>Settings</span>
              {!me.hasApiKey ? <span className="ml-auto size-1.5 rounded-full bg-warning" aria-label="Needs an API key" /> : null}
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <UserMenu me={me} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
