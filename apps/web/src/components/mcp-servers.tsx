"use client";

import { ExternalLinkIcon, PlusIcon, PlugIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, runInBrowser, type Api } from "@/lib/api";
import { mcpFormBody, mcpFormKeepsSecrets, mcpFormValues, type McpFormValues } from "@/lib/mcp-form";

type OnChange = (servers: ReadonlyArray<Api.ApiMcpServer>) => void;

const transports = [{ value: "http", label: "Remote HTTP" }, { value: "stdio", label: "Local command (stdio)" }];
const authMethods = [
  { value: "none", label: "No authentication" },
  { value: "bearer", label: "Bearer token" },
  { value: "oauth", label: "Sign in with OAuth" },
];

function McpServerForm({ server, onChange, onCancel }: { server?: Api.ApiMcpServer; onChange: OnChange; onCancel: () => void }) {
  const id = useId();
  const [values, setValues] = useState(() => mcpFormValues(server));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const keepsSecrets = mcpFormKeepsSecrets(values, server);
  const keepsToken = keepsSecrets && server?.config.transport === "http" && server.config.auth === "bearer" && server.authenticated;
  const change = <K extends keyof McpFormValues>(key: K, value: McpFormValues[K]) =>
    setValues((previous) => ({ ...previous, [key]: value }));

  const save = () => {
    let body: Api.SaveMcpServerBody;
    try {
      body = mcpFormBody(values);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the server configuration.");
      return;
    }
    setError(null);
    start(async () => {
      const result = await runInBrowser(server ? api.saveMcpServer(server.id, body) : api.createMcpServer(body));
      if (result._tag === "Left") return setError(result.left.message);
      onChange(result.right);
      toast.success(`${body.name} saved.${body.config.transport === "http" && body.config.auth === "oauth" ? " Use Sign in to connect it." : ""}`);
    });
  };

  return (
    <form className="rounded-lg border bg-card p-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <fieldset disabled={pending} className="flex min-w-0 flex-col gap-4">
        <legend className="mb-4 text-sm font-medium">{server ? `Edit ${server.name}` : "Add MCP server"}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-name`} className="text-xs font-medium">Name</label>
            <Input id={`${id}-name`} value={values.name} onChange={(event) => change("name", event.target.value)} placeholder="my-tools" pattern={"[A-Za-z0-9_\\-]{1,64}"} title="Use 1–64 letters, numbers, underscores or hyphens." maxLength={64} required autoComplete="off" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label id={`${id}-transport`} className="text-xs font-medium">Connection</label>
            <Select items={transports} value={values.transport} onValueChange={(value) => { if (value === "http" || value === "stdio") change("transport", value); }} disabled={pending}>
              <SelectTrigger aria-labelledby={`${id}-transport`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{transports.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        {values.transport === "http" ? (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-url`} className="text-xs font-medium">Server URL</label>
              <Input id={`${id}-url`} type="url" value={values.url} onChange={(event) => change("url", event.target.value)} placeholder="https://mcp.example.com/mcp" required autoComplete="off" />
            </div>
            <div className="flex flex-col gap-1.5">
              <label id={`${id}-auth`} className="text-xs font-medium">Authentication</label>
              <Select items={authMethods} value={values.auth} onValueChange={(value) => { if (value === "none" || value === "bearer" || value === "oauth") change("auth", value); }} disabled={pending}>
                <SelectTrigger aria-labelledby={`${id}-auth`} className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{authMethods.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {values.auth === "bearer" ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${id}-token`} className="text-xs font-medium">Bearer token</label>
                <Input id={`${id}-token`} type="password" autoComplete="new-password" value={values.bearerToken} onChange={(event) => change("bearerToken", event.target.value)} placeholder={keepsToken ? "Leave blank to keep the saved token" : "Paste your token"} required={values.enabled && !keepsToken} />
              </div>
            ) : null}
            {values.auth === "oauth" ? <p className="text-xs text-muted-foreground">Save this server, then choose Sign in. The server must use public HTTPS endpoints and support OAuth discovery and automatic client registration.</p> : null}
            <SecretMapField id={`${id}-headers`} label="HTTP headers (optional JSON)" value={values.headers} onChange={(value) => change("headers", value)} savedNames={keepsSecrets ? server?.secretNames.headers ?? [] : []} connectionChanged={!!server && !keepsSecrets} placeholder={'{"X-API-Key":"your-key"}'} />
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-command`} className="text-xs font-medium">Command</label>
              <Input id={`${id}-command`} value={values.command} onChange={(event) => change("command", event.target.value)} placeholder="npx" required autoComplete="off" />
              <p className="text-xs text-muted-foreground">Runs inside each thread&apos;s sandbox. The executable must be available there.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-args`} className="text-xs font-medium">Arguments (JSON array)</label>
              <Textarea id={`${id}-args`} value={values.args} onChange={(event) => change("args", event.target.value)} placeholder={'["-y","@example/mcp-server"]'} className="min-h-16 font-mono text-xs" autoComplete="off" spellCheck={false} />
            </div>
            <SecretMapField id={`${id}-env`} label="Environment variables (optional JSON)" value={values.env} onChange={(value) => change("env", value)} savedNames={keepsSecrets ? server?.secretNames.env ?? [] : []} connectionChanged={!!server && !keepsSecrets} placeholder={'{"API_KEY":"your-key"}'} />
          </>
        )}
        {server && !keepsSecrets ? <p role="status" className="text-xs text-warning">The connection has changed. Saving clears its previous credentials. Enter replacement tokens, headers or variables above, and sign in again if using OAuth.</p> : null}
        {server && !server.authenticated ? <p role="status" className="text-xs text-warning">This server needs credentials. Enter any required tokens, headers or environment variables again. For OAuth, save and choose Sign in.</p> : null}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={values.enabled} onCheckedChange={(checked) => change("enabled", checked)} disabled={pending} />
          Enable for my threads
        </label>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>{pending ? <Spinner /> : null} Save server</Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>
        </div>
      </fieldset>
    </form>
  );
}

function SecretMapField({ id, label, value, onChange, savedNames, connectionChanged, placeholder }: {
  id: string; label: string; value: string; onChange: (value: string) => void; savedNames: readonly string[]; connectionChanged: boolean; placeholder: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium">{label}</label>
      <Textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-describedby={`${id}-help`} autoComplete="off" spellCheck={false} className="min-h-16 font-mono text-xs [-webkit-text-security:disc]" />
      <p id={`${id}-help`} className="break-words text-xs text-muted-foreground">
        {savedNames.length ? `Saved: ${savedNames.join(", ")}. ` : ""}
        {connectionChanged ? "Enter new values for the changed connection. " : "Leave blank to keep saved values. "}
        A JSON object replaces all values; {"{}"} clears them. Values are encrypted and never shown again.
      </p>
    </div>
  );
}

function McpServerRow({ server, onChange, onEdit, disabled }: { server: Api.ApiMcpServer; onChange: OnChange; onEdit: () => void; disabled: boolean }) {
  const [pending, start] = useTransition();
  const isOAuth = server.config.transport === "http" && server.config.auth === "oauth";
  const needsAuth = !server.authenticated || (server.config.transport === "http" && server.config.auth !== "none");
  const update = (action: "toggle" | "remove" | "disconnect") => start(async () => {
    const effect = action === "remove" ? api.deleteMcpServer(server.id)
      : action === "disconnect" ? api.disconnectMcpServer(server.id)
      : api.saveMcpServer(server.id, { name: server.name, config: server.config, enabled: !server.enabled });
    const result = await runInBrowser(effect);
    if (result._tag === "Left") return void toast.error(result.left.message);
    onChange(result.right);
    toast.success(action === "remove" ? `${server.name} removed.` : action === "disconnect" ? `${server.name} disconnected.` : `${server.name} ${server.enabled ? "disabled" : "enabled"}.`);
  });
  const authenticate = () => start(async () => {
    const result = await runInBrowser(api.authenticateMcpServer(server.id));
    if (result._tag === "Left") return void toast.error(result.left.message);
    window.location.assign(result.right.url);
  });

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/50"><PlugIcon className="size-4 text-muted-foreground" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <span className="break-all">{server.name}</span>
            <Badge variant={server.enabled ? "secondary" : "outline"} className="font-normal">{server.enabled ? "Enabled" : "Disabled"}</Badge>
            {needsAuth ? <Badge variant="outline" className={server.authenticated ? "font-normal" : "font-normal text-warning"}>{server.authenticated ? isOAuth ? "Signed in" : "Token saved" : "Credentials needed"}</Badge> : null}
          </div>
          <p className="mt-1 break-all text-xs text-muted-foreground">{server.config.transport === "http" ? server.config.url : server.config.command}</p>
        </div>
        {pending ? <Spinner /> : null}
      </div>
      <div className="flex flex-wrap gap-1">
        {isOAuth ? <Button size="sm" variant="outline" disabled={disabled || pending} onClick={authenticate}>{server.authenticated ? "Reconnect" : "Sign in"}<ExternalLinkIcon /></Button> : null}
        {isOAuth && server.authenticated ? <Button size="sm" variant="ghost" disabled={disabled || pending} onClick={() => update("disconnect")}>Disconnect</Button> : null}
        <Button size="sm" variant="ghost" disabled={disabled || pending} onClick={onEdit}>Edit</Button>
        <Button size="sm" variant="ghost" disabled={disabled || pending} onClick={() => update("toggle")}>{server.enabled ? "Disable" : "Enable"}</Button>
        <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={disabled || pending} onClick={() => update("remove")}>Remove</Button>
      </div>
    </div>
  );
}

export function McpServers({ initial, oauthResult }: { initial: ReadonlyArray<Api.ApiMcpServer>; oauthResult?: string }) {
  const router = useRouter();
  const [servers, setServers] = useState(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const changed: OnChange = (next) => { setServers(next); setEditing(null); router.refresh(); };

  return (
    <div className="flex flex-col gap-3">
      {oauthResult === "connected" ? <p role="status" className="rounded-lg border p-3 text-sm">MCP server connected. Your next turn can use it.</p> : null}
      {oauthResult === "error" ? <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">Sign-in could not be completed. Try again and check that the server supports OAuth discovery and automatic client registration.</p> : null}
      {servers.length === 0 && editing !== "new" ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No MCP servers yet. Connect tools once and use them across your threads.</p> : null}
      {servers.map((server) => editing === server.id
        ? <McpServerForm key={server.id} server={server} onChange={changed} onCancel={() => setEditing(null)} />
        : <McpServerRow key={server.id} server={server} onChange={changed} onEdit={() => setEditing(server.id)} disabled={editing !== null} />)}
      {editing === "new" ? <McpServerForm onChange={changed} onCancel={() => setEditing(null)} /> : <div><Button variant="outline" onClick={() => setEditing("new")} disabled={editing !== null}><PlusIcon /> Add MCP server</Button></div>}
    </div>
  );
}
