"use client";

import { ExternalLinkIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, runInBrowser } from "@/lib/api";

/**
 * Registers the factory's GitHub App from a manifest: the harness hands back
 * the form, and the browser posts it to GitHub, where the person confirms the
 * App. GitHub then sends them back to /auth/setup/github-app.
 */
export function CreateGitHubApp() {
  const [organization, setOrganization] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const create = () =>
    start(async () => {
      const result = await runInBrowser(api.createGitHubApp({ organization: organization.trim() || undefined }));
      if (result._tag === "Left") return setError(result.left.message);
      setError(null);
      const form = document.createElement("form");
      form.method = "post";
      form.action = result.right.action;
      const field = document.createElement("input");
      field.type = "hidden";
      field.name = "manifest";
      field.value = result.right.manifest;
      form.append(field);
      document.body.append(form);
      form.submit();
    });

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <div className="flex gap-2">
        <Input
          value={organization}
          onChange={(e) => setOrganization(e.target.value)}
          placeholder="Organization (optional)"
          aria-label="GitHub organization to create the App under"
          aria-invalid={!!error || undefined}
          autoComplete="off"
        />
        <Button type="submit" disabled={pending} className="shrink-0">
          {pending ? <Spinner /> : null} Create GitHub App
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  );
}

/** Pastes a Railway token once; the harness creates the `agents` environment and its own scoped token with it. */
export function ConnectSandboxes() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const connect = () =>
    start(async () => {
      const result = await runInBrowser(api.setupSandboxes(token));
      if (result._tag === "Left") return setError(result.left.message);
      setError(null);
      setToken("");
      toast.success("Sandboxes are set up.");
      router.refresh();
    });

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        connect();
      }}
    >
      <div className="flex gap-2">
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Railway account or workspace token"
          aria-label="Railway token"
          aria-invalid={!!error || undefined}
          autoComplete="off"
          className="font-mono"
        />
        <Button type="submit" disabled={pending || token.trim().length === 0} className="shrink-0">
          {pending ? <Spinner /> : null} Connect
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <p className="text-xs text-muted-foreground">
        <a
          href="https://railway.com/account/tokens"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 underline underline-offset-4"
        >
          Create a token <ExternalLinkIcon className="size-3" />
        </a>{" "}
        with access to this project. It is used once and not stored; you can delete it afterwards.
      </p>
    </form>
  );
}
