import "server-only";
import { harnessUrl } from "./server";

/** Hop-by-hop headers, and ones fetch re-computes, that must not be copied across the proxy. */
const DROP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding"];

/**
 * Forwards a request to the harness unchanged (method, path, query, cookies,
 * Origin, body) and hands its answer back, redirects and Set-Cookie included.
 * The harness is only reachable on the private network, and this keeps the
 * browser on one origin for the session cookie, OAuth callback and CSRF check.
 */
export async function proxyToHarness(req: Request): Promise<Response> {
  const incoming = new URL(req.url);
  const target = `${harnessUrl()}${incoming.pathname}${incoming.search}`;
  const headers = new Headers(req.headers);
  for (const name of DROP) headers.delete(name);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));

  const hasBody = !["GET", "HEAD"].includes(req.method);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return Response.json({ code: "unavailable", error: "The factory backend is not reachable." }, { status: 502 });
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROP.includes(name) && name !== "set-cookie") out.append(name, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
