/**
 * The preview gateway's HTTP side. It serves two kinds of host under
 * PREVIEW_DOMAIN:
 *
 * - `tunnel.<domain>`: sandboxes' preview agents connect here with their run's
 *   `tunnel` grant, one WebSocket per sandbox (a newer one replaces an older).
 * - `p<port>-<run>.<domain>`: one origin per run and port. `/__factory/open`
 *   swaps the harness's one-time `open` grant for a `session` cookie on that
 *   origin; every other request needs that cookie, for that run and port, and
 *   is sent down the run's tunnel to `localhost:<port>` in the sandbox.
 *   WebSocket upgrades (hot reload, say) and streamed responses pass through.
 *
 * It is plain Node (node:http plus `ws`) because it hands raw sockets and
 * streams around; index.ts wires it into Effect for config, Postgres and
 * lifecycle.
 */
import {
  isPreviewPort,
  parsePreviewHost,
  PREVIEW_COOKIE,
  PREVIEW_OPEN_PATH,
  PREVIEW_TTL_SECONDS,
  PREVIEW_TUNNEL_PATH,
  sessionGrant,
  signPreviewGrant,
  verifyPreviewGrant,
  type PreviewPort,
  type SandboxState,
} from "@factory/core";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { OpenFailed, Tunnel } from "./tunnel.js";

/** What the gateway needs from the database. */
export interface PreviewBackend {
  readonly setPorts: (runId: string, ports: ReadonlyArray<PreviewPort> | null) => Promise<void>;
  /** Counts preview traffic as activity on the run. */
  readonly touch: (runId: string) => Promise<void>;
  readonly sandboxState: (runId: string) => Promise<SandboxState | undefined>;
}

export interface GatewayOptions {
  /** e.g. `preview.shixzie.com`; hosts are `<label>.<domain>`. */
  readonly domain: string;
  readonly signingKey: string;
  /** The factory's own origin, for links back to runs and who may frame preview pages. */
  readonly webUrl: string;
  readonly backend: PreviewBackend;
  readonly log?: (level: "info" | "warn", message: string) => void;
}

/** Preview traffic bumps a run's activity at most this often. */
const TOUCH_EVERY_MS = 30_000;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function makeGateway(options: GatewayOptions) {
  const { domain, signingKey, backend } = options;
  const webUrl = options.webUrl.replace(/\/$/, "");
  const log = options.log ?? (() => {});
  const tunnels = new Map<string, Tunnel>();
  const touched = new Map<string, number>();
  /** `open` grants already used, until they expire. */
  const usedOpens = new Map<string, number>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  const quietly = (p: Promise<unknown>, what: string) =>
    p.catch((err) => log("warn", `${what}: ${err instanceof Error ? err.message : String(err)}`));

  const touch = (runId: string) => {
    const now = Date.now();
    if (now - (touched.get(runId) ?? 0) < TOUCH_EVERY_MS) return;
    touched.set(runId, now);
    void quietly(backend.touch(runId), "Could not record preview activity");
  };

  // ---- pages the gateway answers itself -------------------------------------------

  const page = (res: ServerResponse, status: number, title: string, body: string, runId?: string) => {
    const link = runId ? `<p><a href="${webUrl}/runs/${runId}" target="_top">Back to the run</a></p>` : "";
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self' ${webUrl}`,
      "referrer-policy": "no-referrer",
    });
    res.end(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escape(title)}</title>` +
        `<style>:root{color-scheme:light dark}body{font:14px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:Canvas;color:CanvasText}` +
        `main{max-width:28rem;padding:24px}h1{font-size:16px;margin:0 0 8px}p{margin:0 0 8px;opacity:.8}a{color:inherit}</style>` +
        `<main><h1>${escape(title)}</h1><p>${body}</p>${link}</main>`,
    );
  };

  const noTunnel = async (res: ServerResponse, runId: string) => {
    const state = await backend.sandboxState(runId).catch(() => undefined);
    if (state === "stopped" || state === "stopping") {
      return page(
        res,
        503,
        "This run's sandbox is stopped",
        "Idle sandboxes stop after a few minutes. Send the agent a message to start it again. Stopped sandboxes keep their files but not running processes, so ask the agent to start the server again too.",
        runId,
      );
    }
    if (state === "running") {
      return page(
        res,
        503,
        "Waiting for the sandbox",
        "The sandbox is running but its preview connection is not up. It connects at the start of each turn, so send the agent a message if this persists.",
        runId,
      );
    }
    return page(res, 404, "No sandbox", "This run has no sandbox right now. Send the agent a message to start one.", runId);
  };

  // ---- auth -------------------------------------------------------------------------

  /** The session cookie's grant, if it is for this run and port. */
  const sessionFor = (req: IncomingMessage, runId: string, port: number) => {
    const grant = verifyPreviewGrant(signingKey, cookie(req.headers.cookie, PREVIEW_COOKIE), "session");
    return grant && grant.run === runId && grant.port === port ? grant : undefined;
  };

  const handleOpen = (req: IncomingMessage, res: ServerResponse, url: URL, runId: string, port: number) => {
    const token = url.searchParams.get("token") ?? undefined;
    const grant = verifyPreviewGrant(signingKey, token, "open");
    const now = Date.now();
    for (const [nonce, exp] of usedOpens) if (exp * 1000 <= now) usedOpens.delete(nonce);
    if (!grant || grant.run !== runId || grant.port !== port || usedOpens.has(grant.nonce)) {
      return page(res, 403, "This preview link has expired", "Open the preview again from its run.", runId);
    }
    usedOpens.set(grant.nonce, grant.exp);
    const session = signPreviewGrant(signingKey, sessionGrant(runId, port, grant.user));
    const next = safePath(url.searchParams.get("path"));
    res.writeHead(302, {
      location: next,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      // Partitioned: inside the factory's iframe it lives in the factory's cookie jar only.
      "set-cookie": `${PREVIEW_COOKIE}=${session}; Path=/; Max-Age=${PREVIEW_TTL_SECONDS.session}; Secure; HttpOnly; SameSite=None; Partitioned`,
    });
    res.end();
  };

  // ---- proxying ---------------------------------------------------------------------

  /** Request headers as the app in the sandbox should see them. */
  const upstreamHeaders = (req: IncomingMessage, port: number, keepUpgrade: boolean) => {
    const host = req.headers.host ?? "";
    const origin = `${scheme(req)}://${host}`;
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === "host") continue;
      if (HOP_BY_HOP.has(name) && !(keepUpgrade && (name === "connection" || name === "upgrade"))) continue;
      out[name] = value;
    }
    // Dev servers check Host (Vite's allowedHosts) and, for their own requests, Origin.
    out.host = `localhost:${port}`;
    if (out.origin === origin) out.origin = `http://localhost:${port}`;
    const cookies = stripCookie(req.headers.cookie, PREVIEW_COOKIE);
    if (cookies) out.cookie = cookies;
    else delete out.cookie;
    out["x-forwarded-host"] = host;
    out["x-forwarded-proto"] = scheme(req);
    return out;
  };

  /** Response headers for the browser: redirects to localhost point back at the preview origin. */
  const downstreamHeaders = (headers: IncomingHttpHeaders, origin: string, port: number) => {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue;
      out[name] = value;
    }
    if (typeof out.location === "string") {
      out.location = out.location.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):${port}(?=/|$)`), origin);
    }
    return out;
  };

  const proxy = (req: IncomingMessage, res: ServerResponse, tunnel: Tunnel, port: number) => {
    const origin = `${scheme(req)}://${req.headers.host ?? ""}`;
    const upstream = http.request({
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, port, false),
      createConnection: (_opts, cb) => {
        tunnel.open(port).then(
          (stream) => cb(null, stream),
          (err: Error) => cb(err, undefined as never),
        );
        return undefined;
      },
    });
    upstream.on("response", (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, downstreamHeaders(up.headers, origin, port));
      up.pipe(res);
      up.on("error", () => res.destroy());
    });
    upstream.on("error", (err) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof OpenFailed && /ECONNREFUSED/.test(err.reason)) {
        return page(
          res,
          502,
          `Nothing is listening on port ${port}`,
          "No server in the sandbox is listening on this port right now. Ask the agent to start it, or pick another port.",
          tunnel.runId,
        );
      }
      page(res, 502, "The sandbox did not answer", escape(err.message), tunnel.runId);
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  };

  const proxyUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer, tunnel: Tunnel, port: number) => {
    let stream: Duplex;
    try {
      stream = await tunnel.open(port);
    } catch {
      return reject(socket, 502, "Bad Gateway");
    }
    const headers = upstreamHeaders(req, port, true);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [name, value] of Object.entries(headers)) {
      for (const v of Array.isArray(value) ? value : [value]) raw += `${name}: ${v.replace(/[\r\n]/g, "")}\r\n`;
    }
    stream.write(raw + "\r\n");
    if (head.length > 0) stream.write(head);
    stream.pipe(socket);
    socket.pipe(stream);
    const done = () => {
      stream.destroy();
      socket.destroy();
    };
    stream.on("error", done);
    socket.on("error", done);
    stream.on("close", done);
    socket.on("close", done);
  };

  // ---- tunnels ----------------------------------------------------------------------

  const acceptTunnel = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "https://gateway");
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const grant = url.pathname === PREVIEW_TUNNEL_PATH ? verifyPreviewGrant(signingKey, bearer, "tunnel") : undefined;
    if (!grant) return reject(socket, 401, "Unauthorized");
    wss.handleUpgrade(req, socket, head, (ws) => {
      const runId = grant.run;
      const tunnel: Tunnel = new Tunnel(ws, runId, {
        onPorts: (ports) => {
          if (tunnels.get(runId) === tunnel) void quietly(backend.setPorts(runId, ports), "Could not record the sandbox's ports");
        },
        onClose: () => {
          if (tunnels.get(runId) !== tunnel) return;
          tunnels.delete(runId);
          log("info", `Tunnel for run ${runId} closed`);
          void quietly(backend.setPorts(runId, null), "Could not clear the sandbox's ports");
        },
      });
      const previous = tunnels.get(runId);
      tunnels.set(runId, tunnel);
      previous?.close(4000, "replaced");
      log("info", `Tunnel for run ${runId} connected`);
    });
  };

  // ---- server -----------------------------------------------------------------------

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "https://gateway");
    const target = parsePreviewHost(domain, req.headers.host);
    if (!target || target.kind === "tunnel") {
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("ok");
      }
      return page(res, 404, "Not found", "This is the Factory on Rails preview gateway.");
    }
    const { run, port } = target;
    if (url.pathname === PREVIEW_OPEN_PATH) return handleOpen(req, res, url, run, port);
    if (!sessionFor(req, run, port)) {
      return page(res, 401, "Open this preview from its run", "Previews are private to the person who started the run.", run);
    }
    const tunnel = tunnels.get(run);
    if (!tunnel) return void noTunnel(res, run);
    touch(run);
    proxy(req, res, tunnel, port);
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const target = parsePreviewHost(domain, req.headers.host);
    if (target?.kind === "tunnel") return acceptTunnel(req, socket, head);
    if (!target || !isPreviewPort(target.port)) return reject(socket, 404, "Not Found");
    if (!sessionFor(req, target.run, target.port)) return reject(socket, 401, "Unauthorized");
    const tunnel = tunnels.get(target.run);
    if (!tunnel) return reject(socket, 503, "Service Unavailable");
    touch(target.run);
    void proxyUpgrade(req, socket, head, tunnel, target.port);
  });

  // Preview apps hold connections open for hot reload and streaming.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  return {
    server,
    tunnels,
    close: () => {
      for (const t of tunnels.values()) t.close(1001, "gateway stopping");
      wss.close();
    },
  };
}

/**
 * The scheme the browser used: Railway's edge terminates TLS and says so in
 * X-Forwarded-Proto. Without one, `*.localhost` is local development over http.
 */
function scheme(req: IncomingMessage): "http" | "https" {
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim();
  if (forwarded) return forwarded === "http" ? "http" : "https";
  return /\.localhost(:\d+)?$/.test(req.headers.host ?? "") ? "http" : "https";
}

function reject(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Only same-origin paths: `/x`, never `//evil.example` or `https://…`. */
export function safePath(path: string | null): string {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return "/";
  return path;
}

export function cookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** The Cookie header without `name`, so the app in the sandbox never sees the preview session. */
export function stripCookie(header: string | undefined, name: string): string {
  return (header ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && (p.includes("=") ? p.slice(0, p.indexOf("=")) : p).trim() !== name)
    .join("; ");
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
