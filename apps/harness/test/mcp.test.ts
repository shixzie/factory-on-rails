import { HttpApp, HttpServerResponse } from "@effect/platform";
import { Api, sha256, Store, TokenCipher, type McpServerSecrets } from "@factory/core";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TestDbLive, testDatabaseUrl } from "../../../packages/core/test/db.js";
import { originCheck } from "../src/app.js";
import { HarnessConfig } from "../src/config.js";
import { mcpRoutes } from "../src/mcp.js";

// Exercise the real durable OAuth lifecycle without an external consent provider.
vi.mock("../../../packages/core/dist/mcp-fetch.js", () => ({
  publicMcpUrl: async (raw: string) => new URL(raw),
  mcpOAuthFetch: () => { throw new Error("Unexpected network request"); },
}));
vi.mock("@factory/core", async (original) => {
  const core = await original<typeof import("@factory/core")>();
  return { ...core, authorizeMcp: (provider: Parameters<typeof core.authorizeMcp>[0], _url: string, code?: string) => Effect.promise(async () => {
    if (code) {
      expect(await provider.codeVerifier()).toBe("pkce-secret");
      await provider.saveTokens({ access_token: "oauth-access-secret", refresh_token: "oauth-refresh-secret", token_type: "Bearer", expires_in: 3600 });
      return "AUTHORIZED" as const;
    }
    await provider.saveClientInformation!({ client_id: "client-id", client_secret: "client-secret" });
    await provider.saveCodeVerifier("pkce-secret");
    await provider.redirectToAuthorization(new URL(`https://login.example.com/authorize?state=${await provider.state!()}`));
    return "REDIRECT" as const;
  }) };
});

const origin = "https://factory.example";
const cipher = TokenCipher.fromKey(randomBytes(32));
const TestLayer = Layer.mergeAll(Store.Live, Layer.succeed(TokenCipher, cipher), Layer.succeed(HarnessConfig, {
  publicUrl: origin, allowedLogins: ["*"], sessionTtlSeconds: 3600, preview: Option.none(), railwayProjectId: Option.none(), snapshots: [],
})).pipe(Layer.provideMerge(TestDbLive));

describe.skipIf(!testDatabaseUrl)("MCP settings routes", () => {
  const runtime = ManagedRuntime.make(TestLayer);
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Layer.Success<typeof TestLayer>>) => runtime.runPromise(effect);
  let handler: (request: Request) => Promise<Response>;
  const request = (method: string, path: string, cookie = "", body?: unknown, from = origin) => handler(new Request(`${origin}${path}`, {
    method, headers: { cookie, origin: from, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const signIn = (id: number) => run(Effect.gen(function* () {
    const store = yield* Store;
    const user = yield* store.upsertUser({ github_id: id, github_login: `mcp-${id}`, name: null, avatar_url: null,
      access_token_enc: cipher.encrypt("github-token"), access_token_expires_at: null, refresh_token_enc: null, refresh_token_expires_at: null });
    const token = randomBytes(16).toString("hex");
    yield* store.createSession(sha256(token), user.id, 3600);
    return { user, cookie: `__Host-factory_session=${token}` };
  }));
  const base: Api.SaveMcpServerBody = { name: "docs", enabled: true, config: { transport: "http", url: "https://mcp.example.com/mcp", auth: "bearer" }, secrets: { bearerToken: "bearer-secret", headers: { "X-Key": "header-secret" } } };
  const servers = async (response: Response): Promise<Api.ApiMcpServer[]> => {
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/bearer-secret|header-secret|oauth-access-secret|oauth-refresh-secret|client-secret|pkce-secret|secrets_enc/);
    return JSON.parse(text);
  };
  const getRow = (userId: string, id: string) => run(Effect.flatMap(Store, (store) => store.getMcpServer(userId, id)).pipe(Effect.map(Option.getOrThrow)));
  const getSecrets = async (userId: string, id: string): Promise<McpServerSecrets> => {
    const row = await getRow(userId, id);
    expect(row.secrets_enc).not.toMatch(/bearer-secret|header-secret|oauth-access-secret/);
    return JSON.parse(await Effect.runPromise(cipher.decrypt(row.secrets_enc!)));
  };

  beforeAll(async () => {
    const app = mcpRoutes.pipe(Effect.catchTags({
      ApiFailure: (e) => Effect.succeed(HttpServerResponse.unsafeJson({ code: e.code, error: e.message }, { status: e.status })),
      Unauthorized: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
      ParseError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
    }));
    handler = HttpApp.toWebHandlerRuntime(await runtime.runtime())(app.pipe(originCheck));
  }, 30_000);
  afterAll(() => runtime.dispose());

  it("requires sign-in, same-origin changes and owner access", async () => {
    expect((await request("GET", "/api/settings/mcp")).status).toBe(401);
    const owner = await signIn(1001);
    const other = await signIn(1002);
    expect((await request("POST", "/api/settings/mcp", owner.cookie, base, "https://attacker.example")).status).toBe(403);
    const [server] = await servers(await request("POST", "/api/settings/mcp", owner.cookie, base));
    expect(await servers(await request("GET", "/api/settings/mcp", other.cookie))).toEqual([]);
    for (const [method, suffix, body] of [["PUT", "", base], ["DELETE", "", undefined], ["POST", "/oauth", undefined], ["DELETE", "/auth", undefined]] as const) {
      expect((await request(method, `/api/settings/mcp/${server!.id}${suffix}`, other.cookie, body)).status).toBe(404);
    }
    expect((await request("POST", "/api/settings/mcp", owner.cookie, { ...base, name: "DOCS" })).status).toBe(409);
  });

  it("keeps encrypted secrets on metadata edits, replaces maps and removes servers", async () => {
    const { user, cookie } = await signIn(1003);
    const [server] = await servers(await request("POST", "/api/settings/mcp", cookie, base));
    expect(server).toMatchObject({ authenticated: true, secretNames: { headers: ["X-Key"], env: [] } });
    const { secrets: _, ...withoutSecrets } = base;
    await servers(await request("PUT", `/api/settings/mcp/${server!.id}`, cookie, { ...withoutSecrets, name: "renamed", enabled: false }));
    expect(await getSecrets(user.id, server!.id)).toMatchObject({ bearerToken: "bearer-secret", headers: { "X-Key": "header-secret" } });
    await servers(await request("PUT", `/api/settings/mcp/${server!.id}`, cookie, { ...withoutSecrets, secrets: { headers: {} } }));
    expect(await getSecrets(user.id, server!.id)).toMatchObject({ bearerToken: "bearer-secret", headers: {} });
    expect(await servers(await request("DELETE", `/api/settings/mcp/${server!.id}`, cookie))).toEqual([]);
  });

  it("does not reuse credentials after changing the destination or authentication mode", async () => {
    const { user, cookie } = await signIn(1004);
    const [server] = await servers(await request("POST", "/api/settings/mcp", cookie, base));
    const changed = { ...base, config: { transport: "http", url: "https://other.example.com/mcp", auth: "bearer" } };
    delete (changed as Partial<typeof changed>).secrets;
    expect((await request("PUT", `/api/settings/mcp/${server!.id}`, cookie, changed)).status).toBe(400);
    await servers(await request("PUT", `/api/settings/mcp/${server!.id}`, cookie, { ...changed, config: { ...changed.config, auth: "none" } }));
    expect(await getSecrets(user.id, server!.id)).toEqual({});
    for (const body of [
      { ...base, name: "factory" },
      { ...base, secrets: { bearerToken: "abc\r\nInjected: yes" } },
      { ...base, secrets: { bearerToken: "secret", headers: { authorization: "other" } } },
      { ...base, config: { transport: "http", url: "http://example.com/mcp", auth: "oauth" } },
    ]) expect((await request("POST", "/api/settings/mcp", cookie, body)).status).toBe(400);
  });

  it("keeps settings accessible so unreadable credentials can be replaced", async () => {
    const { user, cookie } = await signIn(1008);
    const [server] = await servers(await request("POST", "/api/settings/mcp", cookie, base));
    const row = await getRow(user.id, server!.id);
    await run(Effect.flatMap(Store, (store) => store.saveMcpServerSecrets(user.id, row.id, row.revision, "unreadable-ciphertext")));
    const [broken] = await servers(await request("GET", "/api/settings/mcp", cookie));
    expect(broken).toMatchObject({ authenticated: false, secretNames: { headers: [], env: [] } });
    const [fixed] = await servers(await request("PUT", `/api/settings/mcp/${row.id}`, cookie, base));
    expect(fixed!.authenticated).toBe(true);
    expect(await getSecrets(user.id, row.id)).toMatchObject({ bearerToken: "bearer-secret" });
  });

  it("round trips browser OAuth, binds state to the owner, rejects replay and disconnects", async () => {
    const { user, cookie } = await signIn(1005);
    const other = await signIn(1006);
    const [server] = await servers(await request("POST", "/api/settings/mcp", cookie, {
      ...base, config: { ...base.config, auth: "oauth" }, secrets: {},
    }));
    expect(server!.authenticated).toBe(false);
    const begin = await request("POST", `/api/settings/mcp/${server!.id}/oauth`, cookie);
    expect(begin.status).toBe(200);
    const state = new URL((await begin.json() as { url: string }).url).searchParams.get("state")!;
    const callback = `/auth/mcp/callback?code=authorization-code&state=${state}`;
    expect((await request("GET", callback, other.cookie)).headers.get("location")).toBe("/settings?mcp=error");
    expect((await request("GET", callback, cookie)).headers.get("location")).toBe("/settings?mcp=connected");
    expect((await getSecrets(user.id, server!.id)).oauth).toMatchObject({ tokens: { access_token: "oauth-access-secret" } });
    expect((await getSecrets(user.id, server!.id)).oauth?.codeVerifier).toBeUndefined();
    expect((await servers(await request("GET", "/api/settings/mcp", cookie)))[0]!.authenticated).toBe(true);
    expect((await request("GET", callback, cookie)).headers.get("location")).toBe("/settings?mcp=error");
    expect((await servers(await request("DELETE", `/api/settings/mcp/${server!.id}/auth`, cookie)))[0]!.authenticated).toBe(false);
    expect((await getSecrets(user.id, server!.id)).oauth).toBeUndefined();
  });

  it("rejects an OAuth callback after settings changed", async () => {
    const { cookie } = await signIn(1007);
    const body = { name: "oauth", enabled: true, config: { transport: "http", url: "https://mcp.example.com/mcp", auth: "oauth" } };
    const [server] = await servers(await request("POST", "/api/settings/mcp", cookie, body));
    const begin = await request("POST", `/api/settings/mcp/${server!.id}/oauth`, cookie);
    const state = new URL((await begin.json() as { url: string }).url).searchParams.get("state")!;
    await servers(await request("PUT", `/api/settings/mcp/${server!.id}`, cookie, { ...body, enabled: false }));
    expect((await request("GET", `/auth/mcp/callback?code=code&state=${state}`, cookie)).headers.get("location")).toBe("/settings?mcp=error");
  });
});
