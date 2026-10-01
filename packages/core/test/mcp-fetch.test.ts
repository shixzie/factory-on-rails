import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPublicMcpAddress, mcpOAuthFetch, publicMcpUrl } from "../src/mcp-fetch.js";

type ConnectLookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void;
const network = vi.hoisted(() => ({
  lookup: vi.fn(), fetch: vi.fn<typeof fetch>(), close: vi.fn<() => Promise<void>>(),
  connector: undefined as ConnectLookup | undefined,
}));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("undici", () => ({ Agent: class {
  constructor(options: { connect: { lookup: ConnectLookup } }) { network.connector = options.connect.lookup; }
  close() { return network.close(); }
} }));

beforeEach(() => {
  network.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  network.fetch.mockReset().mockResolvedValue(Response.json({ ok: true }));
  network.close.mockReset().mockResolvedValue(undefined);
  network.connector = undefined;
  vi.stubGlobal("fetch", network.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("MCP OAuth network boundary", () => {
  it("allows public IPv4/IPv6 and blocks loopback, mapped, private, link-local, multicast, and special routing networks", () => {
    for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
      expect(isPublicMcpAddress(address), address).toBe(true);
    }
    for (const address of [
      "invalid", "0.0.0.0", "127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1",
      "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
      "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "ff02::1",
      "64:ff9b::7f00:1", "2001::1", "2001:db8::1", "2002:7f00:1::", "3fff::1",
    ]) {
      expect(isPublicMcpAddress(address), address).toBe(false);
    }
  });

  it("requires HTTPS without embedded credentials or fragments and rejects any private DNS answer", async () => {
    for (const url of ["http://example.test", "file:///etc/passwd", "https://user:secret@example.test", "https://example.test/#fragment"]) {
      await expect(publicMcpUrl(url)).rejects.toThrow();
    }
    expect(network.lookup).not.toHaveBeenCalled();
    network.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await expect(publicMcpUrl("https://example.test")).rejects.toThrow(/public HTTPS/);
    network.lookup.mockResolvedValue([]);
    await expect(publicMcpUrl("https://example.test")).rejects.toThrow(/public HTTPS/);
    network.lookup.mockResolvedValue([{ address: "2606:4700:4700::1111", family: 6 }]);
    expect((await publicMcpUrl("https://[2606:4700:4700::1111]/oauth")).hostname).toBe("[2606:4700:4700::1111]");
    expect(network.lookup).toHaveBeenLastCalledWith("2606:4700:4700::1111", { all: true });
  });

  it("rechecks DNS at connection time to reject a rebinding host", async () => {
    network.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    network.fetch.mockImplementation(() => new Promise((_resolve, reject) => {
      network.connector!("example.test", { all: true }, (error) => reject(error));
    }));
    await expect(mcpOAuthFetch("https://example.test/token")).rejects.toThrow(/public HTTPS/);
    expect(network.lookup).toHaveBeenCalledTimes(2);
    expect(network.close).toHaveBeenCalledTimes(1);
  });

  it("passes vetted DNS answers to the connector and refuses redirects", async () => {
    network.fetch.mockImplementation(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const result = await new Promise<unknown[]>((resolve) => network.connector!("example.test", { all: true }, (...args) => resolve(args)));
      expect(result).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
      return Response.json({ access_token: "token" }, { headers: { "X-Test": "preserved" } });
    });
    const response = await mcpOAuthFetch("https://example.test/token", { method: "POST", body: "grant_type=refresh_token" });
    expect(response.headers.get("X-Test")).toBe("preserved");
    expect(await response.json()).toEqual({ access_token: "token" });
    expect(network.close).toHaveBeenCalledTimes(1);
  });

  it("caps upstream bodies and closes the dispatcher on failure", async () => {
    network.fetch.mockResolvedValue(new Response("x".repeat(1_048_577)));
    await expect(mcpOAuthFetch("https://example.test/token")).rejects.toThrow(/too large/);
    expect(network.close).toHaveBeenCalledTimes(1);
  });

  it("preserves empty responses and the caller's cancellation", async () => {
    network.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    const controller = new AbortController();
    controller.abort();
    const response = await mcpOAuthFetch("https://example.test/token", { signal: controller.signal });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(network.fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });
});
