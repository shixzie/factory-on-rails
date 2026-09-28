"use client";

import {
  ChevronRightIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SquarePenIcon,
  SunIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useMemo, useState } from "react";
import { Logo } from "@/components/logo";
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import type { Api } from "@/lib/api";
import { runTitle, shortAge } from "@/lib/format";

const RUNS_PER_REPO = 6;

interface RepoGroup {
  repo: string;
  runs: Api.ApiRun[];
}

/** Runs grouped by repository, most recently active repository first (t3code's projects and threads). */
function groupByRepo(runs: ReadonlyArray<Api.ApiRun>): RepoGroup[] {
  const groups = new Map<string, Api.ApiRun[]>();
  for (const run of runs) {
    const list = groups.get(run.repo) ?? [];
    list.push(run);
    groups.set(run.repo, list);
  }
  return [...groups].map(([repo, runs]) => ({ repo, runs }));
}

function RepoRuns({ group, activeRunId }: { group: RepoGroup; activeRunId: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [owner, name] = group.repo.split("/");
  const shown = expanded ? group.runs : group.runs.slice(0, RUNS_PER_REPO);
  const hasActive = group.runs.some((r) => r.id === activeRunId);
  return (
    <Collapsible defaultOpen render={<SidebarMenuItem />} className="group/collapsible">
      <CollapsibleTrigger
        render={<SidebarMenuButton className="text-sidebar-foreground/80" />}
        data-active={hasActive || undefined}
      >
        <ChevronRightIcon className="size-3.5! text-muted-foreground transition-transform group-data-open/collapsible:rotate-90" />
        <span className="truncate">
          <span className="font-medium">{name}</span>
          <span className="ml-1.5 text-xs text-muted-foreground">{owner}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <SidebarMenuSub className="mr-0 pr-0">
          {shown.map((run) => (
            <SidebarMenuSubItem key={run.id}>
              <SidebarMenuSubButton
                isActive={run.id === activeRunId}
                render={<Link href={`/runs/${run.id}`} />}
                className="h-8 gap-2 pr-1.5"
              >
                <StatusDot status={run.status} awaiting={run.awaitingInput} />
                <span className="min-w-0 flex-1 truncate">{runTitle(run, 60)}</span>
                <span className="ml-auto text-[11px] text-muted-foreground tabular-nums" suppressHydrationWarning>
                  {shortAge(run.createdAt)}
                </span>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
          {group.runs.length > RUNS_PER_REPO ? (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                render={<button type="button" onClick={() => setExpanded((v) => !v)} />}
                className="h-7 text-xs text-muted-foreground"
              >
                {expanded ? "Show less" : `Show ${group.runs.length - RUNS_PER_REPO} more`}
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
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
  const groups = useMemo(() => groupByRepo(runs), [runs]);

  return (
    <Sidebar collapsible="offcanvas">
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
              render={<Link href="/" />}
              className="bg-sidebar-accent/40"
            >
              <SquarePenIcon />
              <span>New run</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
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
