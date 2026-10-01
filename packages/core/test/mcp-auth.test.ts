import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, layer } from "@effect/vitest";
import { beforeEach, vi } from "vitest";
import { Effect, Layer, Option } from "effect";
import { authorizeMcp, mcpOAuthProvider, readMcpSecrets, resolveMcpServers } from "../src/mcp-auth.js";
import { TokenCipher } from "../src/crypto.js";
import type { McpServerSecrets } from "../src/mcp.js";
import { Store } from "../src/store.js";
import { TestDbLive, testDatabaseUrl } from "./db.js";

const network = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>(), checkUrl: vi.fn<(url: string) => Promise<URL>>() }));
vi.mock("../src/mcp-fetch.js", () => ({ mcpOAuthFetch: network.fetch, publicMcpUrl: network.checkUrl }));

const serverUrl = "https://mcp.example.test/mcp";
const issuer = "https://auth.example.test";
const redirectUri = "https://factory.example.test/api/settings/mcp/oauth/callback";
const metadata = {
  issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`, response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
};
const discoveryState = {
  authorizationServerUrl: issuer, authorizationServerMetadata: metadata,
  resourceMetadata: { resource: serverUrl, authorization_servers: [issuer], scopes_supported: ["tools:read"] },
};
const tokens = (access = "saved-access", refresh = "saved-refresh") => ({
  access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, issuer,
});
const savedOAuth = (expiresAt: number): McpServerSecrets => ({ oauth: {
  tokens: tokens(), expiresAt, redirectUri, discoveryState, clientInformation: { client_id: "client", issuer },
} });

beforeEach(() => {
  network.fetch.mockReset();
  network.checkUrl.mockReset().mockImplementation(async (url) => new URL(url));
  network.fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("oauth-protected-resource")) return Response.json(discoveryState.resourceMetadata);
    if (url.pathname.includes("oauth-authorization-server")) return Response.json(metadata);
    if (url.pathname === "/register") return Response.json({ ...JSON.parse(String(init?.body)), client_id: "client" }, { status: 201 });
    if (url.pathname === "/token") return Response.json(tokens("new-access", "rotated-refresh"));
    throw new Error(`Unexpected OAuth fixture URL ${url}`);
  });
});

describe("MCP OAuth provider and SDK", () => {
  it.effect("discovers, registers, saves PKCE state, and exchanges a code after restoring encrypted provider state", () => Effect.gen(function* () {
    const secrets: McpServerSecrets = {};
    const started = mcpOAuthProvider(secrets, redirectUri, "one-time-state");
    expect(yield* authorizeMcp(started.provider, serverUrl)).toBe("REDIRECT");
    const url = new URL(started.authorizationUrl()!);
    expect(url.origin).toBe(issuer);
    expect(url.searchParams.get("state")).toBe("one-time-state");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("scope")).toBe("tools:read");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(secrets.oauth!.codeVerifier!).digest("base64url"));
    expect(secrets.oauth?.clientInformation?.issuer).toBe(issuer);

    const cipher = TokenCipher.fromKey(randomBytes(32));
    const encrypted = cipher.encrypt(JSON.stringify(secrets));
    expect(encrypted).not.toContain(secrets.oauth!.codeVerifier!);
    const restored = JSON.parse(yield* cipher.decrypt(encrypted)) as McpServerSecrets;
    network.fetch.mockClear();
    const callback = mcpOAuthProvider(restored, redirectUri);
    expect(yield* authorizeMcp(callback.provider, serverUrl, "auth-code")).toBe("AUTHORIZED");
    expect(network.fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(String(network.fetch.mock.calls[0]![1]?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe(restored.oauth?.codeVerifier);
    expect(body.get("resource")).toBe(serverUrl);
    expect(restored.oauth?.tokens).toMatchObject(tokens("new-access", "rotated-refresh"));
    expect(restored.oauth?.expiresAt).toBeGreaterThan(Date.now() + 3_590_000);
    expect(restored.oauth?.redirectUri).toBe(redirectUri);
  }));

  it("preserves omitted refresh tokens only for their issuer, and clears expired state", async () => {
    const secrets = savedOAuth(0);
    const { provider } = mcpOAuthProvider(secrets, redirectUri);
    await provider.saveTokens({ access_token: "new-access", token_type: "Bearer", expires_in: 10, issuer });
    expect(secrets.oauth?.tokens?.refresh_token).toBe("saved-refresh");
    expect(secrets.oauth?.expiresAt).toBeGreaterThan(Date.now());
    await provider.saveTokens({ access_token: "another-issuer-access", token_type: "Bearer", issuer: "https://another.example.test" });
    expect(secrets.oauth?.tokens?.refresh_token).toBeUndefined();
    expect(secrets.oauth?.expiresAt).toBeUndefined();
    await provider.invalidateCredentials?.("all");
    expect(secrets.oauth).toEqual({ redirectUri });
  });

  it.effect("never posts a refresh token to a different discovered issuer", () => Effect.gen(function* () {
    const secrets = savedOAuth(0);
    secrets.oauth!.tokens!.issuer = "https://other-issuer.example.test";
    const { provider } = mcpOAuthProvider(secrets, redirectUri);
    const error = yield* Effect.flip(authorizeMcp(provider, serverUrl));
    expect(error._tag).toBe("McpAuthError");
    expect(network.fetch).not.toHaveBeenCalled();
  }));

  it.effect("hides upstream error bodies and fails refresh without opening a browser flow", () => Effect.gen(function* () {
    network.fetch.mockResolvedValue(Response.json({ error: "invalid_grant", error_description: "secret-token-value" }, { status: 400 }));
    const secrets = savedOAuth(0);
    const { provider, authorizationUrl } = mcpOAuthProvider(secrets, redirectUri);
    const error = yield* Effect.flip(authorizeMcp(provider, serverUrl));
    expect(error.message).not.toContain("secret-token-value");
    expect(authorizationUrl()).toBeUndefined();
    expect(secrets.oauth?.tokens).toBeUndefined();
  }));
});

const StoreTest = Layer.mergeAll(Store.Live.pipe(Layer.provideMerge(TestDbLive)),
  Layer.succeed(TokenCipher, TokenCipher.fromKey(randomBytes(32))));

describe.skipIf(!testDatabaseUrl)("MCP resolution (Postgres)", () => {
  layer(StoreTest, { timeout: 30_000 })((it) => {
    const user = (githubId: number) => Effect.flatMap(Store, (store) => store.upsertUser({
      github_id: githubId, github_login: `mcp-auth-${githubId}`, name: null, avatar_url: null,
      access_token_enc: "enc", access_token_expires_at: null, refresh_token_enc: null, refresh_token_expires_at: null,
    }));

    it.effect("resolves only this owner's enabled servers with their own private environment and headers", () => Effect.gen(function* () {
      const store = yield* Store;
      const cipher = yield* TokenCipher;
      const owner = yield* user(1501);
      const other = yield* user(1502);
      const config = { transport: "http", url: serverUrl, auth: "bearer" } as const;
      yield* store.createMcpServer({ user_id: owner.id, name: "remote", enabled: true, config,
        secrets_enc: cipher.encrypt(JSON.stringify({ bearerToken: "owner-token", headers: { "X-Key": "header-secret" } })) });
      yield* store.createMcpServer({ user_id: owner.id, name: "local", enabled: true,
        config: { transport: "stdio", command: "npx", args: ["mcp"] },
        secrets_enc: cipher.encrypt(JSON.stringify({ env: { LOCAL_TOKEN: "env-secret" } })) });
      yield* store.createMcpServer({ user_id: owner.id, name: "disabled", enabled: false, config, secrets_enc: null });
      yield* store.createMcpServer({ user_id: other.id, name: "other", enabled: true, config,
        secrets_enc: cipher.encrypt(JSON.stringify({ bearerToken: "other-token" })) });
      expect(yield* resolveMcpServers(owner.id)).toEqual({ warnings: [], servers: [
        { name: "local", transport: "stdio", command: "npx", args: ["mcp"], env: { LOCAL_TOKEN: "env-secret" } },
        { name: "remote", transport: "http", url: serverUrl, headers: { Authorization: "Bearer owner-token", "X-Key": "header-secret" } },
      ] });
      expect(network.fetch).not.toHaveBeenCalled();
    }));

    it.effect("serializes concurrent refreshes and durably saves the rotated refresh token", () => Effect.gen(function* () {
      const store = yield* Store;
      const cipher = yield* TokenCipher;
      const owner = yield* user(1511);
      const server = yield* store.createMcpServer({ user_id: owner.id, name: "oauth", enabled: true,
        config: { transport: "http", url: serverUrl, auth: "oauth" }, secrets_enc: cipher.encrypt(JSON.stringify(savedOAuth(0))) });
      const results = yield* Effect.all([resolveMcpServers(owner.id), resolveMcpServers(owner.id)], { concurrency: "unbounded" });
      expect(results[0]).toEqual(results[1]);
      expect(results[0]!.servers[0]).toMatchObject({ headers: { Authorization: "Bearer new-access" } });
      expect(network.fetch).toHaveBeenCalledTimes(1);
      const body = new URLSearchParams(String(network.fetch.mock.calls[0]![1]?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("saved-refresh");
      const saved = Option.getOrThrow(yield* store.getMcpServer(owner.id, server.id));
      expect(saved.revision).toBe(server.revision + 1);
      expect(saved.secrets_enc).not.toContain("rotated-refresh");
      expect((yield* readMcpSecrets(saved)).oauth?.tokens?.refresh_token).toBe("rotated-refresh");
      expect((yield* resolveMcpServers(owner.id)).servers).toEqual(results[0]!.servers);
      expect(network.fetch).toHaveBeenCalledTimes(1);
    }));

    it.effect("skips missing, expired without refresh, invalid, and unsupported credentials with safe reconnect warnings", () => Effect.gen(function* () {
      const store = yield* Store;
      const cipher = yield* TokenCipher;
      const owner = yield* user(1521);
      const expired = savedOAuth(0);
      delete expired.oauth!.tokens!.refresh_token;
      const unsupported = savedOAuth(Date.now() + 100_000);
      unsupported.oauth!.tokens!.token_type = "unsupported";
      for (const [name, secrets] of [["missing", {}], ["expired", expired], ["unsupported", unsupported]] as const) {
        yield* store.createMcpServer({ user_id: owner.id, name, enabled: true,
          config: { transport: "http", url: serverUrl, auth: "oauth" }, secrets_enc: cipher.encrypt(JSON.stringify(secrets)) });
      }
      yield* store.createMcpServer({ user_id: owner.id, name: "invalid", enabled: true,
        config: { transport: "http", url: serverUrl, auth: "oauth" }, secrets_enc: "invalid-ciphertext" });
      const result = yield* resolveMcpServers(owner.id);
      expect(result.servers).toEqual([]);
      expect(result.warnings).toHaveLength(4);
      expect(result.warnings.every((message) => message.includes("Settings"))).toBe(true);
      expect(result.warnings.join()).not.toMatch(/saved-access|saved-refresh|invalid-ciphertext/);
      expect(network.fetch).not.toHaveBeenCalled();
    }));
  });
});
