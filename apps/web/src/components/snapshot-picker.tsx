"use client";

import { BoxIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { api, runInBrowser, type Api } from "@/lib/api";

const DEFAULT = "__default__";

/**
 * Picks the sandbox snapshot the user's runs start from: one of the prepared
 * checkpoints the operator made available to them, or the platform default.
 */
export function SnapshotPicker({ initial }: { initial: Api.SnapshotSettings }) {
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [pending, start] = useTransition();

  if (settings.available.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
        No snapshots are set up for your account, so your runs start from the factory&apos;s default sandbox. Whoever runs
        this factory can prepare one for you (see &ldquo;Sandbox snapshots&rdquo; in docs/setup.md).
      </p>
    );
  }

  const items = [
    { value: DEFAULT, label: "Default sandbox" },
    ...settings.available.map((name) => ({ value: name, label: name })),
  ];
  const save = (value: string) =>
    start(async () => {
      const snapshot = value === DEFAULT ? null : value;
      const result = await runInBrowser(api.saveSnapshot(snapshot));
      if (result._tag === "Left") return void toast.error(result.left.message);
      setSettings(result.right);
      toast.success(snapshot ? `New runs start from ${snapshot}.` : "New runs start from the default sandbox.");
      router.refresh();
    });

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-4">
      <span className="flex size-8 items-center justify-center rounded-lg border bg-muted/50">
        <BoxIcon className="size-4 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1 text-xs text-muted-foreground">
        New sandboxes for your runs boot from this snapshot. Runs already in progress keep theirs.
      </div>
      {pending ? <Spinner className="size-4" /> : null}
      <Select items={items} value={settings.selected ?? DEFAULT} onValueChange={(v) => v && save(String(v))} disabled={pending}>
        <SelectTrigger aria-label="Sandbox snapshot" className="min-w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
