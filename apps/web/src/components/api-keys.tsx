"use client";

import { ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, runInBrowser, type Api } from "@/lib/api";

function KeyRow({ slot, onChange }: { slot: Api.ApiKeySlot; onChange: (slots: ReadonlyArray<Api.ApiKeySlot>) => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const result = await runInBrowser(api.saveKey(slot.provider, key));
      if (result._tag === "Left") return setError(result.left.message);
      setError(null);
      setKey("");
      onChange(result.right);
      toast.success(`${slot.label} key saved.`);
    });

  const remove = () =>
    start(async () => {
      const result = await runInBrowser(api.deleteKey(slot.provider));
      if (result._tag === "Left") return void toast.error(result.left.message);
      onChange(result.right);
      toast.success(`${slot.label} key removed.`);
    });

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-8 items-center justify-center rounded-lg border bg-muted/50">
          <KeyRoundIcon className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            {slot.label}
            {slot.saved ? (
              <Badge variant="secondary" className="font-mono font-normal">
                …{slot.saved.hint}
              </Badge>
            ) : (
              <Badge variant="outline" className="font-normal text-warning">
                Not set
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {slot.saved ? `Saved ${slot.saved.updatedAt.toISOString().slice(0, 10)}.` : "Runs can't start until you add a key."}{" "}
            <a href={slot.consoleUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline underline-offset-4">
              Get a key <ExternalLinkIcon className="size-3" />
            </a>
          </div>
        </div>
        {slot.saved ? (
          <Button variant="ghost" size="sm" onClick={remove} disabled={pending} className="text-muted-foreground">
            Remove
          </Button>
        ) : null}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={slot.saved ? "Paste a new key to replace it" : slot.placeholder}
          aria-label={`${slot.label} API key`}
          aria-invalid={!!error || undefined}
          className="font-mono"
        />
        <Button type="submit" disabled={pending || key.trim().length === 0}>
          {pending ? <Spinner /> : null} Save
        </Button>
      </form>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function ApiKeys({ initial }: { initial: ReadonlyArray<Api.ApiKeySlot> }) {
  const router = useRouter();
  const [slots, setSlots] = useState(initial);
  return (
    <div className="divide-y rounded-xl border bg-card">
      {slots.map((slot) => (
        <KeyRow
          key={slot.provider}
          slot={slot}
          onChange={(next) => {
            setSlots(next);
            router.refresh();
          }}
        />
      ))}
    </div>
  );
}
