"use client";

import { Combobox } from "@base-ui/react/combobox";
import type { ApiRepo } from "@factory/core/api";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function ComposerRepoPicker({
  repos,
  value,
  onValueChange,
  disabled,
}: {
  repos: ReadonlyArray<ApiRepo>;
  value: ApiRepo | undefined;
  onValueChange: (repo: ApiRepo) => void;
  disabled?: boolean;
}) {
  return (
    <Combobox.Root
      items={repos}
      value={value ?? null}
      onValueChange={(next) => { if (next) onValueChange(next); }}
      itemToStringLabel={(repo) => repo.fullName}
      itemToStringValue={(repo) => `${repo.installationId}:${repo.fullName}`}
      isItemEqualToValue={(a, b) => a.installationId === b.installationId && a.fullName === b.fullName}
      autoHighlight
      disabled={disabled}
    >
      <Combobox.Trigger
        aria-label="Repository"
        title={value?.fullName}
        className="flex h-7 max-w-64 items-center gap-1.5 rounded-md border border-transparent bg-transparent pr-2 pl-2.5 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <GitHubMark className="size-3.5 shrink-0" />
        <span className="truncate"><Combobox.Value placeholder="Repository" /></span>
        <ChevronDownIcon className="size-4 shrink-0" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="start" sideOffset={4} className="z-50">
          <Combobox.Popup aria-label="Choose repository" className="flex max-h-(--available-height) w-80 max-w-(--available-width) flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-border">
            <div className="flex shrink-0 items-center gap-2 border-b px-3">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <Combobox.Input
                aria-label="Search repositories"
                placeholder="Search repositories…"
                className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Combobox.Empty className="px-3 py-3 text-sm text-muted-foreground empty:py-0">
              No repositories found.
            </Combobox.Empty>
            <Combobox.List aria-label="Repositories" className="min-h-0 max-h-64 scroll-py-1 overflow-y-auto p-1 empty:p-0">
              {(repo: ApiRepo) => (
                <Combobox.Item
                  key={`${repo.installationId}:${repo.fullName}`}
                  value={repo}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <span className="min-w-0 flex-1 truncate" title={repo.fullName}>{repo.fullName}</span>
                  <Combobox.ItemIndicator className="shrink-0">
                    <CheckIcon className="size-3.5" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
