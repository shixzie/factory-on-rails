import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { SqlClient } from "@effect/sql";
import { Data, Effect, Option } from "effect";
import { TokenCipher } from "./crypto.js";
import type { McpServerRow, McpServerSecrets } from "./mcp.js";
import { mcpOAuthFetch, publicMcpUrl } from "./mcp-fetch.js";
import { Store } from "./store.js";

export class McpAuthError extends Data.TaggedError("McpAuthError")<{ readonly message: string }> {}

export type ResolvedMcpServer =
  | { readonly name: string; readonly transport: "http"; readonly url: string; readonly headers: Record<string, string> }
  | { readonly name: string; readonly transport: "stdio"; readonly command: string; readonly args: readonly string[]; readonly env: Record<string, string> };

export const readMcpSecrets = (row: McpServerRow) => Effect.gen(function* () {
  if (!row.secrets_enc) return {} as McpServerSecrets;
  const text = yield* (yield* TokenCipher).decrypt(row.secrets_enc);
  return yield* Effect.try({ try: () => JSON.parse(text) as McpServerSecrets,
    catch: () => new McpAuthError({ message: `Could not read credentials for MCP server ${row.name}. Save them again in Settings.` }) });
});

/** SDK provider state stays in memory until a complete flow can be saved atomically. */
export function mcpOAuthProvider(secrets: McpServerSecrets, redirectUri: string, state?: string) {
  const oauth = secrets.oauth ??= {};
  oauth.redirectUri = redirectUri;
  let authorizationUrl: string | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: redirectUri,
    clientMetadata: {
      client_name: "Factory on Rails", redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
    },
    state: () => { if (!state) throw new Error("Reconnect in Settings."); return state; },
    clientInformation: () => oauth.clientInformation as OAuthClientInformationMixed | undefined,
    saveClientInformation: (value) => { oauth.clientInformation = { ...value }; },
    tokens: () => oauth.tokens as OAuthTokens | undefined,
    saveTokens: (value) => {
      // Some issuers omit an unchanged refresh token. Keep it only for that same issuer.
      const previous = oauth.tokens;
      const keepRefresh = !value.refresh_token && previous?.refresh_token && previous.issuer === value.issuer;
      oauth.tokens = { ...value, ...(keepRefresh ? { refresh_token: previous.refresh_token } : {}) };
      oauth.expiresAt = value.expires_in === undefined ? undefined : Date.now() + value.expires_in * 1000;
    },
    redirectToAuthorization: async (url) => {
      if (!state) throw new Error("Reconnect in Settings.");
      await publicMcpUrl(url.href);
      authorizationUrl = url.href;
    },
    saveCodeVerifier: (value) => { oauth.codeVerifier = value; },
    codeVerifier: () => { if (!oauth.codeVerifier) throw new Error("Missing OAuth verifier."); return oauth.codeVerifier; },
    saveDiscoveryState: (value) => { oauth.discoveryState = { ...value }; },
    discoveryState: () => oauth.discoveryState as OAuthDiscoveryState | undefined,
    invalidateCredentials: (scope) => {
      if (scope === "all" || scope === "client") delete oauth.clientInformation;
      if (scope === "all" || scope === "tokens") { delete oauth.tokens; delete oauth.expiresAt; }
      if (scope === "all" || scope === "verifier") delete oauth.codeVerifier;
      if (scope === "all" || scope === "discovery") delete oauth.discoveryState;
    },
  };
  return { provider, authorizationUrl: () => authorizationUrl };
}

export const authorizeMcp = (provider: OAuthClientProvider, serverUrl: string, authorizationCode?: string) =>
  Effect.tryPromise({
    try: (signal) => auth(provider, { serverUrl, authorizationCode,
      fetchFn: (input, init) => mcpOAuthFetch(input, { ...init, signal }),
    }),
    // Provider bodies can contain tokens. Never put raw upstream errors in logs or API responses.
    catch: () => new McpAuthError({ message: "MCP sign-in failed. Check the server URL and its OAuth support, then reconnect in Settings." }),
  }).pipe(Effect.timeoutFail({ duration: "60 seconds", onTimeout: () => new McpAuthError({ message: "MCP sign-in timed out. Try again in Settings." }) }));

/** Refresh under a DB row lock so concurrent threads cannot rotate the same token twice. */
export const resolveMcpServers = (userId: string) => Effect.gen(function* () {
  const store = yield* Store;
  const cipher = yield* TokenCipher;
  const sql = yield* SqlClient.SqlClient;
  const servers: ResolvedMcpServer[] = [];
  const warnings: string[] = [];
  for (const candidate of yield* store.listMcpServers(userId)) {
    if (!candidate.enabled) continue;
    const result = yield* sql.withTransaction(Effect.gen(function* () {
      const rows = yield* sql<McpServerRow>`select * from user_mcp_servers where user_id = ${userId} and id = ${candidate.id} for update`;
      const row = rows[0];
      if (!row?.enabled) return undefined;
      const secrets = yield* readMcpSecrets(row);
      const config = row.config;
      if (config.transport === "stdio") return { name: row.name, ...config, env: secrets.env ?? {} } satisfies ResolvedMcpServer;
      const headers = { ...secrets.headers };
      if (config.auth === "bearer") {
        if (!secrets.bearerToken) return yield* new McpAuthError({ message: "Missing token." });
        headers.Authorization = `Bearer ${secrets.bearerToken}`;
      } else if (config.auth === "oauth") {
        const oauth = secrets.oauth;
        if (!oauth?.tokens?.access_token) return yield* new McpAuthError({ message: "Missing sign-in." });
        if (oauth.expiresAt !== undefined && oauth.expiresAt <= Date.now() + 60_000) {
          if (!oauth.tokens.refresh_token || !oauth.redirectUri) return yield* new McpAuthError({ message: "Sign-in expired." });
          const { provider } = mcpOAuthProvider(secrets, oauth.redirectUri);
          if ((yield* authorizeMcp(provider, config.url)) !== "AUTHORIZED") return yield* new McpAuthError({ message: "Reconnect required." });
          const saved = yield* store.saveMcpServerSecrets(userId, row.id, row.revision, cipher.encrypt(JSON.stringify(secrets)));
          if (Option.isNone(saved)) return yield* new McpAuthError({ message: "Settings changed." });
        }
        const tokens = secrets.oauth?.tokens;
        if (typeof tokens?.access_token !== "string" || String(tokens.token_type).toLowerCase() !== "bearer") {
          return yield* new McpAuthError({ message: "Unsupported OAuth token." });
        }
        headers.Authorization = `Bearer ${tokens.access_token}`;
      }
      return { name: row.name, transport: "http" as const, url: config.url, headers } satisfies ResolvedMcpServer;
    })).pipe(Effect.catchTags({
      McpAuthError: () => Effect.succeed(null),
      DecryptError: () => Effect.succeed(null),
    }));
    if (result === null) warnings.push(`MCP server ${candidate.name} needs authentication. Reconnect or save its credentials in Settings.`);
    else if (result) servers.push(result);
  }
  return { servers, warnings };
});
