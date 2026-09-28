/**
 * End to end, in one process: a "dev server" standing in for an app in the
 * sandbox, the real preview agent script (run with node, as in a sandbox),
 * and the gateway, with requests made the way a browser would.
 */
import {
  openGrant,
  PREVIEW_AGENT_SCRIPT,
  PREVIEW_COOKIE,
  previewHost,
  signPreviewGrant,
  tunnelGrant,
  type PreviewPort,
} from "@factory/core";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { cookie, makeGateway, safePath, stripCookie } from "../src/gateway.js";

const KEY = "k".repeat(40);
const DOMAIN = "preview.test";
const RUN = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_RUN = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const USER = "user-1";

const ports: Array<ReadonlyArray<PreviewPort> | null> = [];
const touched: string[] = [];

let app: http.Server;
let appPort: number;
let gateway: ReturnType<typeof makeGateway>;
let gatewayPort: number;
let agent: ChildProcess;

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

const until = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A request to the gateway as the browser would send it to `host`. */
const request = (host: string, path: string, headers: Record<string, string> = {}, body?: string) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: gatewayPort, path, method: body ? "POST" : "GET", headers: { host, ...headers } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });

const appHost = (port = appPort, run = RUN) => previewHost(DOMAIN, run, port);

/** Signs in to one preview origin the way the web app does: open grant, then the cookie. */
const signIn = async (port = appPort, run = RUN) => {
  const token = signPreviewGrant(KEY, openGrant(run, port, USER));
  const res = await request(appHost(port, run), `/__factory/open?token=${token}&path=${encodeURIComponent("/hello?x=1")}`);
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe("/hello?x=1");
  const set = String(res.headers["set-cookie"]);
  expect(set).toContain("HttpOnly");
  expect(set).toContain("Partitioned");
  return `${PREVIEW_COOKIE}=${cookie(set.split(";")[0], PREVIEW_COOKIE)}`;
};

beforeAll(async () => {
  app = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://localhost:${appPort}/after` });
      return res.end();
    }
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 50);
      return;
    }
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(Buffer.alloc(3 * 1024 * 1024, 7));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "app=1; Path=/" });
      res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body }));
    });
  });
  new WebSocketServer({ server: app }).on("connection", (ws) => ws.on("message", (m) => ws.send(`echo:${m}`)));
  appPort = await listen(app);

  gateway = makeGateway({
    domain: DOMAIN,
    signingKey: KEY,
    webUrl: "https://factory.test",
    backend: {
      setPorts: async (_run, p) => void ports.push(p),
      touch: async (run) => void touched.push(run),
      sandboxState: async (run) => (run === OTHER_RUN ? "stopped" : "running"),
    },
  });
  gatewayPort = await listen(gateway.server);

  const dir = mkdtempSync(join(tmpdir(), "preview-agent-"));
  writeFileSync(join(dir, "preview-agent.mjs"), PREVIEW_AGENT_SCRIPT);
  writeFileSync(join(dir, "token"), signPreviewGrant(KEY, tunnelGrant(RUN)));
  agent = spawn(process.execPath, [join(dir, "preview-agent.mjs")], {
    env: {
      ...process.env,
      FACTORY_PREVIEW_URL: `ws://tunnel.${DOMAIN}/connect`,
      FACTORY_PREVIEW_CONNECT: `127.0.0.1:${gatewayPort}`,
      FACTORY_PREVIEW_TOKEN_FILE: join(dir, "token"),
      FACTORY_PREVIEW_PID_FILE: join(dir, "pid"),
      FACTORY_PREVIEW_SCAN_MS: "200",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  await until(() => gateway.tunnels.has(RUN));
});

afterAll(async () => {
  agent?.kill();
  gateway?.close();
  gateway?.server.closeAllConnections();
  app?.closeAllConnections();
  await Promise.all([new Promise((r) => gateway?.server.close(r)), new Promise((r) => app?.close(r))]);
});

describe("preview gateway", () => {
  it("reports the sandbox's listening ports", async () => {
    await until(() => ports.some((p) => p?.some((x) => x.port === appPort)));
    const last = ports.filter(Boolean).at(-1)!;
    expect(last.find((p) => p.port === appPort)?.process).toBeTruthy();
  });

  it("proxies requests for the run's owner to the port in the sandbox", async () => {
    const session = await signIn();
    const res = await request(appHost(), "/hello?x=1", { cookie: `${session}; theirs=1`, origin: `https://${appHost()}` });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toEqual(["app=1; Path=/"]);
    const seen = JSON.parse(res.body);
    expect(seen.url).toBe("/hello?x=1");
    // The app sees itself on localhost, never the preview session.
    expect(seen.headers.host).toBe(`localhost:${appPort}`);
    expect(seen.headers.origin).toBe(`http://localhost:${appPort}`);
    expect(seen.headers.cookie).toBe("theirs=1");
    expect(seen.headers["x-forwarded-host"]).toBe(appHost());
    expect(touched).toContain(RUN);
  });

  it("passes request bodies, redirects, streams and large responses through", async () => {
    const session = await signIn();
    const posted = await request(appHost(), "/form", { cookie: session, "content-type": "text/plain" }, "a".repeat(200_000));
    expect(JSON.parse(posted.body).body).toHaveLength(200_000);

    const redirect = await request(appHost(), "/redirect", { cookie: session });
    expect(redirect.headers.location).toBe(`https://${appHost()}/after`);

    const stream = await request(appHost(), "/stream", { cookie: session });
    expect(stream.body).toBe("data: one\n\ndata: two\n\n");

    const big = await request(appHost(), "/big", { cookie: session });
    expect(big.body).toHaveLength(3 * 1024 * 1024);
  });

  it("passes WebSockets through", async () => {
    const session = await signIn();
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/`, { headers: { host: appHost(), cookie: session } });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("hi"));
      ws.on("message", (m) => resolve(String(m)));
      ws.on("error", reject);
    });
    ws.close();
    expect(reply).toBe("echo:hi");
  });

  it("turns away anyone without a session for that run and port", async () => {
    expect((await request(appHost(), "/")).status).toBe(401);
    const session = await signIn();
    // Another port on the same run is another origin, with its own cookie.
    expect((await request(appHost(appPort + 1), "/", { cookie: session })).status).toBe(401);
    const forged = signPreviewGrant("x".repeat(40), openGrant(RUN, appPort, USER));
    expect((await request(appHost(), `/__factory/open?token=${forged}`)).status).toBe(403);
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/`, { headers: { host: appHost() } });
    await expect(new Promise((_, reject) => ws.on("error", reject))).rejects.toThrow(/401/);
  });

  it("accepts each open link once", async () => {
    const token = signPreviewGrant(KEY, openGrant(RUN, appPort, USER));
    expect((await request(appHost(), `/__factory/open?token=${token}`)).status).toBe(302);
    expect((await request(appHost(), `/__factory/open?token=${token}`)).status).toBe(403);
  });

  it("refuses tunnels without a valid grant", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/connect`, {
      headers: { host: `tunnel.${DOMAIN}`, authorization: `Bearer ${signPreviewGrant(KEY, openGrant(RUN, 1, USER))}` },
    });
    await expect(new Promise((_, reject) => ws.on("error", reject))).rejects.toThrow(/401/);
  });

  it("says when nothing listens on the port, or the sandbox is stopped", async () => {
    const idle = http.createServer();
    const idlePort = await listen(idle);
    await new Promise((r) => idle.close(r));
    const session = await signIn(idlePort);
    const res = await request(appHost(idlePort), "/", { cookie: session });
    expect(res.status).toBe(502);
    expect(res.body).toContain(`Nothing is listening on port ${idlePort}`);

    const stopped = await signIn(appPort, OTHER_RUN);
    const other = await request(appHost(appPort, OTHER_RUN), "/", { cookie: stopped });
    expect(other.status).toBe(503);
    expect(other.body).toContain("stopped");
  });
});

describe("helpers", () => {
  it("only redirects within the preview origin", () => {
    expect(safePath("/a?b")).toBe("/a?b");
    expect(safePath("//evil.example")).toBe("/");
    expect(safePath("/\\evil.example")).toBe("/");
    expect(safePath("https://evil.example")).toBe("/");
    expect(safePath(null)).toBe("/");
  });

  it("reads and strips cookies", () => {
    expect(cookie("a=1; b=2", "b")).toBe("2");
    expect(stripCookie(`a=1; ${PREVIEW_COOKIE}=x; b=2`, PREVIEW_COOKIE)).toBe("a=1; b=2");
  });
});
