"use client";

import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { api, runInBrowser, type Api } from "@/lib/api";

export function NewRepoForm({ installUrl }: { installUrl: string }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Api.ApiRepo | null>(null);
  const [pending, start] = useTransition();

  if (created) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-5 text-sm">
        <p>
          Created{" "}
          <a href={created.htmlUrl} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
            {created.fullName}
          </a>
          . If it doesn&apos;t show up in the run composer, grant the app access to it.
        </p>
        <div className="flex gap-2">
          <Button render={<Link href="/" />}>Start a run</Button>
          <Button variant="outline" render={<a href={installUrl} target="_blank" rel="noreferrer" />}>
            Manage access <ExternalLinkIcon />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-5 rounded-lg border bg-card p-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const result = await runInBrowser(
            api.createRepo({ name, description: description || undefined, private: isPrivate }),
          );
          if (result._tag === "Left") return setError(result.left.message);
          setCreated(result.right);
        });
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          required
          pattern="[A-Za-z0-9._\-]+"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-new-service"
          className="font-mono"
          aria-invalid={!!error || undefined}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="description">Description</Label>
        <Input id="description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
      </div>
      <Label className="flex items-center gap-2 font-normal">
        <Checkbox checked={isPrivate} onCheckedChange={(v) => setPrivate(v === true)} />
        Private repository
      </Label>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div>
        <Button type="submit" disabled={pending || !name.trim()}>
          {pending ? <Spinner /> : null} Create repository
        </Button>
      </div>
    </form>
  );
}
