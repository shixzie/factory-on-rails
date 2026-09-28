/**
 * Previews: reaching a server that runs inside a run's sandbox (a dev server
 * the agent started, say) from the browser, and only for the run's owner.
 *
 * Sandboxes stay ISOLATED, so nothing can connect into them. Instead a small
 * agent in each sandbox (preview-agent.ts) dials out to the preview gateway
 * (apps/preview) over one WebSocket, and the gateway sends browser requests
 * down it to `localhost:<port>` inside the sandbox. Every port gets its own
 * origin, `p<port>-<run id>.<PREVIEW_DOMAIN>`, so apps work at `/` and can't
 * read each other's cookies or storage, and none of them share an origin with
 * the factory itself.
 *
 * Access is by short-lived signed grants (HMAC-SHA256 with PREVIEW_SIGNING_KEY):
 * - `tunnel`: lets a sandbox's agent connect as that run's tunnel. The runner
 *   writes it into the sandbox each turn.
 * - `open`: minted by the harness for the run's owner, good for one minute
 *   and one use. The gateway swaps it for a `session` cookie on that origin.
 * - `session`: the cookie, scoped to one run and port.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Config, Option, Redacted } from "effect";

export type PreviewGrant =
  | { readonly kind: "tunnel"; readonly run: string; readonly exp: number }
  | {
      readonly kind: "open";
      readonly run: string;
      readonly port: number;
      readonly user: string;
      readonly exp: number;
      readonly nonce: string;
    }
  | { readonly kind: "session"; readonly run: string; readonly port: number; readonly user: string; readonly exp: number };

/** How long each kind of grant lasts. */
export const PREVIEW_TTL_SECONDS = {
  /** Rewritten every turn; a sandbox that outlives this reconnects with the next turn's. */
  tunnel: 8 * 24 * 3600,
  open: 60,
  session: 12 * 3600,
} as const;

/** The cookie a preview origin keeps its `session` grant in. */
export const PREVIEW_COOKIE = "__Host-factory_preview";
/** Paths the gateway answers itself on every preview origin. */
export const PREVIEW_OPEN_PATH = "/__factory/open";
/** Where sandboxes connect, on `tunnel.<PREVIEW_DOMAIN>`. */
export const PREVIEW_TUNNEL_PATH = "/connect";
export const PREVIEW_TUNNEL_HOST = "tunnel";

const b64 = (buf: Buffer) => buf.toString("base64url");
const mac = (key: string, payload: string) => createHmac("sha256", key).update(`factory-preview.v1.${payload}`).digest();

export function signPreviewGrant(key: string, grant: PreviewGrant): string {
  const payload = b64(Buffer.from(JSON.stringify(grant)));
  return `${payload}.${b64(mac(key, payload))}`;
}

/** The grant, if the token is ours, unexpired and of the `kind` asked for. */
export function verifyPreviewGrant<K extends PreviewGrant["kind"]>(
  key: string,
  token: string | undefined,
  kind: K,
  now = Date.now(),
): Extract<PreviewGrant, { kind: K }> | undefined {
  if (!token) return undefined;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return undefined;
  const expected = mac(key, payload);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let grant: PreviewGrant;
  try {
    grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (grant.kind !== kind || typeof grant.exp !== "number" || grant.exp * 1000 <= now) return undefined;
  return grant as Extract<PreviewGrant, { kind: K }>;
}

const expiry = (kind: PreviewGrant["kind"], now: number) => Math.floor(now / 1000) + PREVIEW_TTL_SECONDS[kind];

export const tunnelGrant = (run: string, now = Date.now()): PreviewGrant => ({ kind: "tunnel", run, exp: expiry("tunnel", now) });

export const openGrant = (run: string, port: number, user: string, now = Date.now()): PreviewGrant => ({
  kind: "open",
  run,
  port,
  user,
  exp: expiry("open", now),
  nonce: b64(randomBytes(12)),
});

export const sessionGrant = (run: string, port: number, user: string, now = Date.now()): PreviewGrant => ({
  kind: "session",
  run,
  port,
  user,
  exp: expiry("session", now),
});

export const isPreviewPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;

/** `p5173-<run id without dashes>.<domain>`: one origin per run and port. */
export function previewHost(domain: string, runId: string, port: number): string {
  return `p${port}-${runId.replace(/-/g, "").toLowerCase()}.${domain}`;
}

/**
 * The origin a port's preview is served on. `PREVIEW_DOMAIN` may carry a port
 * for local development (`preview.localhost:8090`); `*.localhost` is served
 * over plain http, everything else over https.
 */
export function previewOrigin(domain: string, runId: string, port: number): string {
  const [name, listen] = domain.split(":");
  const local = name === "localhost" || name!.endsWith(".localhost");
  return `${local ? "http" : "https"}://${previewHost(name!, runId, port)}${listen ? `:${listen}` : ""}`;
}

export type PreviewTarget = { readonly kind: "tunnel" } | { readonly kind: "app"; readonly run: string; readonly port: number };

/** What a request's Host names: the tunnel endpoint, one run's port, or nothing of ours. */
export function parsePreviewHost(domain: string, host: string | undefined): PreviewTarget | undefined {
  if (!host) return undefined;
  const name = host.toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${domain.toLowerCase().replace(/:\d+$/, "")}`;
  if (!name.endsWith(suffix)) return undefined;
  const label = name.slice(0, -suffix.length);
  if (label === PREVIEW_TUNNEL_HOST) return { kind: "tunnel" };
  const m = /^p(\d{1,5})-([0-9a-f]{32})$/.exec(label);
  if (!m) return undefined;
  const port = Number(m[1]);
  if (!isPreviewPort(port)) return undefined;
  const h = m[2]!;
  return { kind: "app", port, run: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` };
}

/**
 * The tunnel's wire format: binary WebSocket messages of
 * `[type: u8][stream: u32 BE][payload]`. The gateway opens streams; the
 * sandbox's agent reports listening ports on stream 0. PAUSE and RESUME are
 * per-stream backpressure: the side whose socket is full asks the other to
 * stop reading until it drains.
 */
export const Frame = {
  /** gateway → agent: connect to the port in the payload (u16 BE). */
  Open: 1,
  Data: 2,
  /** No more data from this side (half-close). */
  End: 3,
  /** The stream is gone; the payload may carry a reason. */
  Close: 4,
  /** agent → gateway: the port accepted the connection. */
  Opened: 5,
  /** agent → gateway: JSON array of listening ports. */
  Ports: 6,
  Pause: 7,
  Resume: 8,
} as const;
export type FrameType = (typeof Frame)[keyof typeof Frame];

export function encodeFrame(type: FrameType, stream: number, payload?: Uint8Array): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(stream, 1);
  return payload && payload.length > 0 ? Buffer.concat([head, payload]) : head;
}

export function decodeFrame(buf: Buffer): { type: number; stream: number; payload: Buffer } | undefined {
  if (buf.length < 5) return undefined;
  return { type: buf.readUInt8(0), stream: buf.readUInt32BE(1), payload: buf.subarray(5) };
}

/**
 * PREVIEW_SIGNING_KEY, shared by the harness, the runner and the gateway.
 * Unset (or too short) turns previews off in the harness and the runner.
 */
export const previewSigningKeyConfig: Config.Config<Option.Option<Redacted.Redacted<string>>> = Config.option(
  Config.redacted("PREVIEW_SIGNING_KEY"),
).pipe(Config.map(Option.filter((key) => Redacted.value(key).trim().length >= 32)));
