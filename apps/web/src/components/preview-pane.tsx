"use client";

import { AppWindowIcon, ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Api, api, runInBrowser } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Ports dev servers usually pick, tried first when choosing what to show. */
const LIKELY = [5173, 3000, 4321, 8080, 8000, 4200, 3001, 5000, 6006, 8888];

/** The port to show when none is picked yet: a familiar dev-server port, else the first unprivileged one. */
export function defaultPort(ports: ReadonlyArray<Api.PreviewPort>): number | undefined {
  return (
    LIKELY.find((p) => ports.some((x) => x.port === p)) ?? ports.find((p) => p.port >= 1024)?.port ?? ports[0]?.port
  );
}

const normalizePath = (path: string) => {
  const p = path.trim() || "/";
  return p.startsWith("/") ? p : `/${p}`;
};

/**
 * A browser for servers running in the run's sandbox. Each port opens on its
 * own private origin through the preview gateway: the harness hands out a
 * one-time link (only to the run's owner), the gateway swaps it for a cookie
 * on that origin, and the page loads in the frame below or in a new tab.
 */
export function PreviewPane({ run, enabled }: { run: Api.ApiRun; enabled: boolean }) {
  const ports = run.previewPorts ?? [];
  const connected = run.previewPorts !== null;
  const sandboxUp = run.sandboxState === "running";
  const [port, setPort] = useState<number | undefined>(() => defaultPort(ports));
  const [path, setPath] = useState("/");
  const [src, setSrc] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [custom, setCustom] = useState("");
  const frameKey = useRef(0);

  // Pick a port once the sandbox reports one.
  useEffect(() => {
    if (port === undefined) setPort(defaultPort(ports));
  }, [ports.map((p) => p.port).join(",")]);

  const link = async (to: number, at: string) => {
    const result = await runInBrowser(api.openPreview(run.id, { port: to, path: normalizePath(at) }));
    if (result._tag === "Left") {
      setError(result.left.message);
      return undefined;
    }
    setError(undefined);
    return result.right.url;
  };

  const load = async (to = port, at = path) => {
    if (to === undefined || !enabled) return;
    setLoading(true);
    const url = await link(to, at);
    setLoading(false);
    if (!url) return;
    frameKey.current += 1;
    setSrc(url);
  };

  // Show the picked port as soon as there is one to show.
  useEffect(() => {
    if (port !== undefined && sandboxUp && connected) void load(port, path);
    else setSrc(undefined);
  }, [port, sandboxUp, connected]);

  const openTab = async () => {
    if (port === undefined) return;
    // Opened before the request, so the browser treats it as the click's own window.
    const tab = window.open("about:blank", "_blank");
    const url = await link(port, path);
    if (!tab) return;
    if (!url) return tab.close();
    // The preview is someone else's code: it must not be able to navigate this page.
    tab.opener = null;
    tab.location.href = url;
  };

  const pick = (to: number) => {
    setPath("/");
    if (to === port) void load(to, "/");
    else setPort(to);
  };

  const submitCustom = () => {
    const n = Number(custom.trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) return setError("Ports go from 1 to 65535.");
    setCustom("");
    pick(n);
  };

  if (!enabled) {
    return (
      <Empty title="Previews aren't set up">
        This factory has no preview gateway yet. Whoever runs it sets PREVIEW_DOMAIN and PREVIEW_SIGNING_KEY (see docs/setup.md).
      </Empty>
    );
  }

  const shown = [...ports];
  if (port !== undefined && !shown.some((p) => p.port === port)) shown.push({ port });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
        {shown.map((p) => (
          <button
            key={p.port}
            type="button"
            onClick={() => pick(p.port)}
            aria-pressed={p.port === port}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono text-[11px] transition-colors",
              p.port === port ? "border-ring/60 bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", ports.some((x) => x.port === p.port) ? "bg-success" : "bg-muted-foreground/40")}
            />
            {p.port}
            {p.process ? <span className="font-sans text-muted-foreground">{p.process}</span> : null}
          </button>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitCustom();
          }}
          className="ml-auto flex items-center gap-1"
        >
          <Input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            inputMode="numeric"
            placeholder="Port"
            aria-label="Open another port"
            className="h-6 w-20 px-2 font-mono text-[11px] md:text-[11px]"
          />
        </form>
      </div>

      {port !== undefined && sandboxUp && connected ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
          className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5"
        >
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            aria-label="Path to open"
            className="h-7 flex-1 font-mono text-xs md:text-xs"
          />
          <Tooltip>
            <TooltipTrigger render={<Button type="submit" variant="ghost" size="icon-sm" aria-label="Reload the preview" />}>
              {loading ? <Spinner /> : <RotateCwIcon />}
            </TooltipTrigger>
            <TooltipContent>Reload</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" onClick={openTab} aria-label="Open in a new tab" />}>
              <ExternalLinkIcon />
            </TooltipTrigger>
            <TooltipContent>Open in a new tab</TooltipContent>
          </Tooltip>
        </form>
      ) : null}

      {error ? <p className="shrink-0 border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p> : null}

      {!sandboxUp ? (
        <Empty title={run.sandboxState === "stopped" || run.sandboxState === "stopping" ? "The sandbox is stopped" : "No sandbox is running"}>
          Send the agent a message to start it again. Stopped sandboxes keep their files but not running processes, so ask it to start the server too.
        </Empty>
      ) : !connected ? (
        <Empty title="Connecting to the sandbox" spinner>
          The sandbox connects for previews at the start of each turn.
        </Empty>
      ) : port === undefined ? (
        <Empty title="Nothing is listening yet">
          Ask the agent to start the dev server (for example, “run the app so I can see it”). Its port shows up here, or type one above.
        </Empty>
      ) : src ? (
        <iframe
          key={frameKey.current}
          src={src}
          title={`Preview of port ${port}`}
          className="min-h-0 w-full flex-1 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
          allow="clipboard-read; clipboard-write"
          referrerPolicy="no-referrer"
        />
      ) : (
        <Empty title="Opening the preview" spinner />
      )}
    </div>
  );
}

function Empty({ title, spinner, children }: { title: string; spinner?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      {spinner ? <Spinner className="size-5 text-muted-foreground" /> : <AppWindowIcon className="size-6 text-muted-foreground/60" />}
      <div className="text-sm font-medium">{title}</div>
      {children ? <p className="max-w-sm text-xs text-muted-foreground">{children}</p> : null}
    </div>
  );
}
