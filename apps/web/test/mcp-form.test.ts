import { describe, expect, it } from "vitest";
import type { ApiMcpServer } from "@factory/core/api";
import { mcpFormBody, mcpFormKeepsSecrets, mcpFormValues } from "../src/lib/mcp-form.js";

const server: ApiMcpServer = {
  id: "mcp-1", name: "tools", enabled: true,
  config: { transport: "http", url: "https://mcp.example.com/mcp", auth: "bearer" },
  authenticated: true, secretNames: { headers: ["X-API-Key"], env: [] }, updatedAt: new Date(),
};

describe("MCP settings forms", () => {
  it("keeps credentials out of form state and preserves them when editing other fields", () => {
    const values = mcpFormValues(server);
    expect(values).toMatchObject({ bearerToken: "", headers: "", env: "" });
    expect(mcpFormBody({ ...values, name: "renamed" })).toEqual({
      name: "renamed", enabled: true, config: server.config,
    });
  });

  it("sends explicit empty maps to clear saved secrets and a token only when replaced", () => {
    expect(mcpFormBody({ ...mcpFormValues(server), headers: "{}", bearerToken: " new-token " }).secrets).toEqual({
      headers: {}, bearerToken: "new-token",
    });
  });

  it("preserves command argument boundaries and environment values for sandbox servers", () => {
    expect(mcpFormBody({
      ...mcpFormValues(), name: " local ", transport: "stdio", command: "node",
      args: '["/path with spaces/server.mjs", "", "--key=value"]',
      env: '{"TOKEN":"value=with=equals", "MULTILINE":"first\\nsecond"}',
      bearerToken: "unused", headers: '{"Unused":"unused"}',
    })).toEqual({
      name: "local", enabled: true,
      config: { transport: "stdio", command: "node", args: ["/path with spaces/server.mjs", "", "--key=value"] },
      secrets: { env: { TOKEN: "value=with=equals", MULTILINE: "first\nsecond" } },
    });
  });

  it.each(["[]", "null", '{"KEY":42}', "not json"])("rejects invalid secret map %s before sending", (headers) => {
    expect(() => mcpFormBody({ ...mcpFormValues(), headers })).toThrow("Headers must be a JSON object");
  });

  it.each(['{"arg":"value"}', '[42]', "not json"])("rejects invalid arguments %s before sending", (args) => {
    expect(() => mcpFormBody({ ...mcpFormValues(), transport: "stdio", args })).toThrow("Arguments must be a JSON array");
  });

  it("does not submit a previously typed bearer token after switching authentication methods", () => {
    expect(mcpFormBody({ ...mcpFormValues(server), auth: "oauth", bearerToken: "unused" })).not.toHaveProperty("secrets");
  });

  it("requires replacement credentials when changing a connection but not its name or enabled state", () => {
    const values = mcpFormValues(server);
    expect(mcpFormKeepsSecrets({ ...values, name: "renamed", enabled: false }, server)).toBe(true);
    expect(mcpFormKeepsSecrets({ ...values, url: "https://another.example/mcp" }, server)).toBe(false);
    expect(mcpFormKeepsSecrets({ ...values, auth: "oauth" }, server)).toBe(false);
    expect(mcpFormKeepsSecrets({ ...values, transport: "stdio" }, server)).toBe(false);
  });

  it("compares command arguments by value when determining whether secrets will be kept", () => {
    const local: ApiMcpServer = { ...server, config: { transport: "stdio", command: "npx", args: ["-y", "server"] } };
    const values = mcpFormValues(local);
    expect(mcpFormKeepsSecrets({ ...values, args: '[ "-y", "server" ]' }, local)).toBe(true);
    expect(mcpFormKeepsSecrets({ ...values, args: '["-y", "other-server"]' }, local)).toBe(false);
    expect(mcpFormKeepsSecrets({ ...values, command: "other-command" }, local)).toBe(false);
    expect(mcpFormKeepsSecrets({ ...values, args: "not json" }, local)).toBe(false);
  });
});
