import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import {
  Api, authorizeMcp, mcpOAuthProvider, randomToken, readMcpSecrets, sha256, Store, TokenCipher,
  type McpServerRow, type McpServerSecrets,
} from "@factory/core";
import { Effect, Option, Schema } from "effect";
import { requireUser } from "./auth.js";
import { HarnessConfig } from "./config.js";
import { fail } from "./errors.js";

const listSchema = Schema.Array(Api.ApiMcpServer);
// An unreadable credential must not prevent reaching Settings to replace it.
const readableSecrets = (row: McpServerRow) => readMcpSecrets(row).pipe(Effect.catchTags({
  DecryptError: () => Effect.succeed(null),
  McpAuthError: () => Effect.succeed(null),
}));
const editableSecrets = (row: McpServerRow) => Effect.map(readableSecrets(row), (secrets) => secrets ?? {});
const list = (userId: string) => Effect.gen(function* () {
  const rows = yield* (yield* Store).listMcpServers(userId);
  return yield* Effect.forEach(rows, (row) => Effect.gen(function* () {
    const saved = yield* readableSecrets(row);
    const secrets = saved ?? {};
    const config = row.config;
    const oauth = secrets.oauth;
    return {
      id: row.id, name: row.name, enabled: row.enabled, config,
      authenticated: saved !== null && (config.transport === "stdio" || config.auth === "none" ||
        (config.auth === "bearer" ? Boolean(secrets.bearerToken) : Boolean(oauth?.tokens?.access_token &&
          (oauth.expiresAt === undefined || oauth.expiresAt > Date.now() || oauth.tokens.refresh_token)))),
      secretNames: { headers: Object.keys(secrets.headers ?? {}), env: Object.keys(secrets.env ?? {}) },
      updatedAt: row.updated_at,
    } satisfies Api.ApiMcpServer;
  }));
});
const response = (userId: string) => Effect.flatMap(list(userId), HttpServerResponse.schemaJson(listSchema));

const owned = Effect.gen(function* () {
  const user = yield* requireUser;
  const { id } = yield* HttpRouter.schemaPathParams(Schema.Struct({ id: Schema.UUID }));
  const row = yield* (yield* Store).getMcpServer(user.id, id);
  if (Option.isNone(row)) return yield* fail(404, "not_found", "MCP server not found.");
  return row.value;
});

const conflict = () => fail(409, "conflict", "MCP settings changed. Reload Settings and try again.");

const sameConnection = (a: Api.McpServerConfig, b: Api.McpServerConfig): boolean =>
  a.transport === "http" && b.transport === "http" ? a.url === b.url && a.auth === b.auth
    : a.transport === "stdio" && b.transport === "stdio" && a.command === b.command &&
      a.args.length === b.args.length && a.args.every((arg, index) => arg === b.args[index]);

/** Preserve omitted secrets only while their destination stays the same. */
const inputFor = (body: Api.SaveMcpServerBody, old?: McpServerRow) => Effect.gen(function* () {
  const previous = old && sameConnection(old.config, body.config) ? yield* editableSecrets(old) : {};
  const secrets: McpServerSecrets = { ...previous, ...body.secrets };
  if (body.config.transport === "stdio") {
    delete secrets.bearerToken; delete secrets.headers; delete secrets.oauth;
  } else {
    delete secrets.env;
    if (body.config.auth !== "bearer") delete secrets.bearerToken;
    if (body.config.auth !== "oauth") delete secrets.oauth;
    if (body.config.auth !== "none" && Object.keys(secrets.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) {
      return yield* fail(400, "bad_request", "Use the selected authentication method instead of an Authorization header.");
    }
    if (body.config.auth === "oauth" && new URL(body.config.url).protocol !== "https:") {
      return yield* fail(400, "bad_request", "OAuth requires a public HTTPS server URL.");
    }
    if (body.config.auth === "bearer" && body.enabled && !secrets.bearerToken?.trim()) {
      return yield* fail(400, "bad_request", "Enter a bearer token for this server.");
    }
  }
  return {
    name: body.name, enabled: body.enabled, config: body.config,
    secrets_enc: (yield* TokenCipher).encrypt(JSON.stringify(secrets)),
  };
});

const duplicateName = (error: { readonly cause?: unknown }) =>
  (error.cause as { code?: string } | undefined)?.code === "23505"
    ? fail(409, "conflict", "An MCP server with that name already exists.") : Effect.fail(error);

const callback = Effect.gen(function* () {
  const user = yield* requireUser;
  const { state, code, error } = yield* HttpServerRequest.schemaSearchParams(Schema.Struct({
    state: Schema.optional(Schema.String), code: Schema.optional(Schema.String), error: Schema.optional(Schema.String),
  }));
  if (!state) return yield* fail(400, "bad_request", "Missing OAuth state.");
  const store = yield* Store;
  const attempt = yield* store.takeMcpOAuthState(user.id, sha256(state));
  if (Option.isNone(attempt) || error || !code) return yield* fail(400, "bad_request", "MCP sign-in expired or was cancelled.");
  const found = yield* store.getMcpServer(user.id, attempt.value.server_id);
  if (Option.isNone(found)) return yield* fail(404, "not_found", "MCP server not found.");
  const row = found.value;
  if (row.revision !== attempt.value.revision || row.config.transport !== "http" || row.config.auth !== "oauth") return yield* conflict();
  const secrets = yield* readMcpSecrets(row);
  const redirectUri = `${(yield* HarnessConfig).publicUrl}/auth/mcp/callback`;
  if (secrets.oauth?.redirectUri !== redirectUri) return yield* conflict();
  const { provider } = mcpOAuthProvider(secrets, redirectUri);
  if ((yield* authorizeMcp(provider, row.config.url, code)) !== "AUTHORIZED") return yield* fail(400, "bad_request", "MCP sign-in did not complete.");
  delete secrets.oauth?.codeVerifier;
  const saved = yield* store.saveMcpServerSecrets(user.id, row.id, row.revision, (yield* TokenCipher).encrypt(JSON.stringify(secrets)));
  if (Option.isNone(saved)) return yield* conflict();
  return HttpServerResponse.redirect("/settings?mcp=connected", { status: 302 });
}).pipe(Effect.catchAll(() => Effect.succeed(HttpServerResponse.redirect("/settings?mcp=error", { status: 302 }))));

export const mcpRoutes = HttpRouter.empty.pipe(
  HttpRouter.get("/api/settings/mcp", Effect.flatMap(requireUser, (user) => response(user.id))),
  HttpRouter.post("/api/settings/mcp", Effect.gen(function* () {
    const user = yield* requireUser;
    const body = yield* HttpServerRequest.schemaBodyJson(Api.SaveMcpServerBody);
    const store = yield* Store;
    if ((yield* store.listMcpServers(user.id)).length >= 50) return yield* fail(400, "bad_request", "At most 50 MCP servers are allowed.");
    const input = yield* inputFor(body);
    yield* store.createMcpServer({ user_id: user.id, ...input }).pipe(Effect.catchTag("SqlError", duplicateName));
    return yield* response(user.id);
  })),
  HttpRouter.put("/api/settings/mcp/:id", Effect.gen(function* () {
    const row = yield* owned;
    const input = yield* inputFor(yield* HttpServerRequest.schemaBodyJson(Api.SaveMcpServerBody), row);
    const updated = yield* (yield* Store).updateMcpServer(row.user_id, row.id, input, row.revision).pipe(Effect.catchTag("SqlError", duplicateName));
    if (Option.isNone(updated)) return yield* conflict();
    return yield* response(row.user_id);
  })),
  HttpRouter.del("/api/settings/mcp/:id", Effect.gen(function* () {
    const row = yield* owned;
    yield* (yield* Store).deleteMcpServer(row.user_id, row.id);
    return yield* response(row.user_id);
  })),
  HttpRouter.del("/api/settings/mcp/:id/auth", Effect.gen(function* () {
    const row = yield* owned;
    const secrets = yield* editableSecrets(row);
    delete secrets.oauth;
    delete secrets.bearerToken;
    const saved = yield* (yield* Store).saveMcpServerSecrets(row.user_id, row.id, row.revision, (yield* TokenCipher).encrypt(JSON.stringify(secrets)));
    if (Option.isNone(saved)) return yield* conflict();
    return yield* response(row.user_id);
  })),
  HttpRouter.post("/api/settings/mcp/:id/oauth", Effect.gen(function* () {
    const row = yield* owned;
    if (row.config.transport !== "http" || row.config.auth !== "oauth") return yield* fail(400, "bad_request", "Select OAuth authentication for this server first.");
    const secrets = yield* editableSecrets(row);
    const redirectUri = `${(yield* HarnessConfig).publicUrl}/auth/mcp/callback`;
    const state = randomToken();
    // Reconnect means a new browser consent flow, even if old tokens still work.
    delete secrets.oauth?.tokens;
    delete secrets.oauth?.expiresAt;
    const session = mcpOAuthProvider(secrets, redirectUri, state);
    yield* authorizeMcp(session.provider, row.config.url);
    const url = session.authorizationUrl();
    if (!url) return yield* fail(400, "bad_request", "The MCP server did not provide an authorization URL.");
    const store = yield* Store;
    const saved = yield* store.saveMcpServerSecrets(row.user_id, row.id, row.revision, (yield* TokenCipher).encrypt(JSON.stringify(secrets)));
    if (Option.isNone(saved)) return yield* conflict();
    yield* store.createMcpOAuthState({ state_hash: sha256(state), user_id: row.user_id, server_id: row.id, revision: saved.value.revision }, 600);
    return yield* HttpServerResponse.schemaJson(Api.McpOAuthLink)({ url });
  }).pipe(Effect.catchTag("McpAuthError", (error) => fail(400, "mcp_auth", error.message)))),
  HttpRouter.get("/auth/mcp/callback", callback),
);
