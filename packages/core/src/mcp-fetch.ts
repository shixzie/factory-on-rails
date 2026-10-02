import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";

const privateNetworks = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) privateNetworks.addSubnet(address, prefix, "ipv4");
const publicV6 = new BlockList();
publicV6.addSubnet("2000::", 3, "ipv6");
privateNetworks.addSubnet("2001::", 23, "ipv6");
privateNetworks.addSubnet("2001:db8::", 32, "ipv6");
privateNetworks.addSubnet("2002::", 16, "ipv6");
privateNetworks.addSubnet("3fff::", 20, "ipv6");

export function isPublicMcpAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !privateNetworks.check(address, "ipv4")
    : family === 6 && publicV6.check(address, "ipv6") && !privateNetworks.check(address, "ipv6");
}

/** OAuth runs in the harness/runner network: never follow discovery into private services. */
export async function publicMcpUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("MCP OAuth requires a public HTTPS URL.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicMcpAddress(address))) {
    throw new Error("MCP OAuth requires a public HTTPS URL.");
  }
  return url;
}

/** DNS is checked at connection time too, preventing rebinding after validation. */
export const mcpOAuthFetch: typeof fetch = async (input, init) => {
  const url = await publicMcpUrl(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const dispatcher = new Agent({ connect: { lookup: (hostname, options, callback) => {
    lookup(hostname, { all: true }).then((addresses) => {
      if (!addresses.length || addresses.some(({ address }) => !isPublicMcpAddress(address))) {
        callback(new Error("MCP OAuth requires a public HTTPS URL."), [], 4);
      } else if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    }, (error: Error) => callback(error, [], 4));
  } } });
  try {
    const response = await fetch(url, {
      ...init, dispatcher, redirect: "error",
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    } as RequestInit & { dispatcher: Agent });
    // Auth responses are small documents. Bound the body and close the socket before returning.
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (response.body) for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 1_048_576) throw new Error("MCP OAuth response is too large.");
      chunks.push(chunk);
    }
    return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } finally {
    await dispatcher.close();
  }
};
