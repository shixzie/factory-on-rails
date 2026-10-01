import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ApiMcpServer, SaveMcpServerBody } from "../src/api.js";

const remote = {
  name: "docs", enabled: true,
  config: { transport: "http", url: "https://mcp.example.test/mcp", auth: "oauth" },
};
const accepts = Schema.is(SaveMcpServerBody);

describe("MCP settings input", () => {
  it("accepts remote and stdio connections with optional private values", () => {
    expect(accepts(remote)).toBe(true);
    expect(accepts({ ...remote, secrets: { bearerToken: "token", headers: { "X-Api-Key": "secret" } } })).toBe(true);
    expect(accepts({
      name: "local_tools", enabled: false,
      config: { transport: "stdio", command: "npx", args: ["-y", "example-mcp"] },
      secrets: { env: { SERVICE_TOKEN: "secret" } },
    })).toBe(true);
  });

  it("reserves the factory namespace and rejects names that break agent configuration", () => {
    for (const name of ["factory", "Factory", "FACTORY", "__proto__", "Constructor", "prototype", "bad.name", "bad name", "", "a".repeat(65)]) {
      expect(accepts({ ...remote, name })).toBe(false);
    }
  });

  it("rejects non-HTTP endpoints and credentials embedded in URLs", () => {
    for (const url of ["file:///etc/passwd", "ftp://example.test", "not-a-url", "https://user:password@example.test/mcp", "https://example.test/#token"]) {
      expect(accepts({ ...remote, config: { ...remote.config, url } })).toBe(false);
    }
  });

  it("rejects header injection, invalid environment names, and oversized secret maps", () => {
    for (const secrets of [
      { bearerToken: "token\r\nOther: value" },
      { headers: { "Bad\r\nName": "secret" } },
      { headers: { "X-Api-Key": "secret\nvalue" } },
      { env: { "bad=name": "secret" } },
      { env: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`KEY_${i}`, "secret"])) },
    ]) {
      expect(accepts({ ...remote, secrets })).toBe(false);
    }
  });

  it("omits secret values from encoded settings responses", () => {
    const encoded = Schema.encodeSync(ApiMcpServer)({
      ...remote, config: { transport: "http", url: remote.config.url, auth: "oauth" },
      id: "server", authenticated: true, secretNames: { headers: ["X-Api-Key"], env: [] },
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      ...{ secrets_enc: "encrypted", secrets: { bearerToken: "private" } },
    });
    expect(JSON.stringify(encoded)).not.toMatch(/encrypted|private|secrets_enc/);
    expect(encoded.secretNames.headers).toEqual(["X-Api-Key"]);
  });
});
