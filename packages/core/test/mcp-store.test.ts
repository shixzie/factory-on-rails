import { describe, expect, layer } from "@effect/vitest";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, Option } from "effect";
import { Store } from "../src/store.js";
import { TestDbLive, testDatabaseUrl } from "./db.js";

const StoreTest = Store.Live.pipe(Layer.provideMerge(TestDbLive));
const user = (githubId: number) => Effect.flatMap(Store, (store) => store.upsertUser({
  github_id: githubId, github_login: `mcp-${githubId}`, name: null, avatar_url: null,
  access_token_enc: "encrypted", access_token_expires_at: null, refresh_token_enc: null, refresh_token_expires_at: null,
}));
const config = { transport: "http", url: "https://example.test/mcp", auth: "oauth" } as const;
const input = { name: "docs", enabled: true, config, secrets_enc: "ciphertext" };

describe.skipIf(!testDatabaseUrl)("MCP settings (Postgres)", () => {
  layer(StoreTest, { timeout: 30_000 })((it) => {
    it.effect("persists account settings and enforces ownership for every read and write", () => Effect.gen(function* () {
      const store = yield* Store;
      const owner = yield* user(1401);
      const other = yield* user(1402);
      const server = yield* store.createMcpServer({ ...input, user_id: owner.id });
      expect(server.config).toEqual(config);
      expect((yield* store.listMcpServers(owner.id)).map((s) => s.id)).toEqual([server.id]);
      expect(yield* store.listMcpServers(other.id)).toEqual([]);
      expect(Option.isNone(yield* store.getMcpServer(other.id, server.id))).toBe(true);
      expect(Option.isNone(yield* store.updateMcpServer(other.id, server.id, { ...input, name: "changed" }))).toBe(true);
      expect(Option.isNone(yield* store.saveMcpServerSecrets(other.id, server.id, server.revision, "stolen"))).toBe(true);
      expect(yield* store.deleteMcpServer(other.id, server.id)).toBe(false);
      expect(Option.getOrThrow(yield* store.getMcpServer(owner.id, server.id))).toEqual(server);
      expect(yield* store.deleteMcpServer(owner.id, server.id)).toBe(true);
      expect(Option.isNone(yield* store.getMcpServer(owner.id, server.id))).toBe(true);
    }));

    it.effect("deduplicates server names case insensitively within each account", () => Effect.gen(function* () {
      const store = yield* Store;
      const owner = yield* user(1411);
      const other = yield* user(1412);
      yield* store.createMcpServer({ ...input, user_id: owner.id });
      expect((yield* Effect.either(store.createMcpServer({ ...input, name: "DOCS", user_id: owner.id })))._tag).toBe("Left");
      expect((yield* store.createMcpServer({ ...input, user_id: other.id })).name).toBe("docs");
      expect((yield* Effect.either(store.createMcpServer({ ...input, name: "Factory", user_id: owner.id })))._tag).toBe("Left");
    }));

    it.effect("only lets one concurrent refresh save and rejects edits based on old credentials", () => Effect.gen(function* () {
      const store = yield* Store;
      const owner = yield* user(1421);
      const server = yield* store.createMcpServer({ ...input, user_id: owner.id });
      const results = yield* Effect.all([
        store.saveMcpServerSecrets(owner.id, server.id, server.revision, "refresh-a"),
        store.saveMcpServerSecrets(owner.id, server.id, server.revision, "refresh-b"),
      ], { concurrency: "unbounded" });
      const winners = results.flatMap(Option.toArray);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.revision).toBe(server.revision + 1);
      expect(Option.isNone(yield* store.updateMcpServer(owner.id, server.id, input, server.revision))).toBe(true);
      const edited = Option.getOrThrow(yield* store.updateMcpServer(owner.id, server.id,
        { ...input, enabled: false, secrets_enc: winners[0]!.secrets_enc }, winners[0]!.revision));
      expect(edited.enabled).toBe(false);
      expect(edited.secrets_enc).toBe(winners[0]!.secrets_enc);
    }));

    it.effect("binds OAuth state to the owner and atomically consumes it once", () => Effect.gen(function* () {
      const store = yield* Store;
      const owner = yield* user(1431);
      const other = yield* user(1432);
      const server = yield* store.createMcpServer({ ...input, user_id: owner.id });
      const state = { state_hash: "oauth-live", user_id: owner.id, server_id: server.id, revision: server.revision };
      yield* store.createMcpOAuthState(state, 600);
      expect(Option.isNone(yield* store.takeMcpOAuthState(other.id, state.state_hash))).toBe(true);
      const results = yield* Effect.all([
        store.takeMcpOAuthState(owner.id, state.state_hash),
        store.takeMcpOAuthState(owner.id, state.state_hash),
      ], { concurrency: "unbounded" });
      expect(results.flatMap(Option.toArray)).toEqual([state]);
      expect(Option.isNone(yield* store.takeMcpOAuthState(owner.id, state.state_hash))).toBe(true);
    }));

    it.effect("expires old attempts, replaces pending attempts, and removes state with its server", () => Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const owner = yield* user(1441);
      const server = yield* store.createMcpServer({ ...input, user_id: owner.id });
      const state = { user_id: owner.id, server_id: server.id, revision: server.revision };
      yield* store.createMcpOAuthState({ ...state, state_hash: "oauth-expired" }, -1);
      expect(Option.isNone(yield* store.takeMcpOAuthState(owner.id, "oauth-expired"))).toBe(true);
      yield* store.createMcpOAuthState({ ...state, state_hash: "oauth-old" }, 600);
      yield* store.createMcpOAuthState({ ...state, state_hash: "oauth-new" }, 600);
      expect(Option.isNone(yield* store.takeMcpOAuthState(owner.id, "oauth-old"))).toBe(true);
      expect(yield* sql`select 1 from mcp_oauth_states where state_hash = 'oauth-expired'`).toEqual([]);
      yield* store.deleteMcpServer(owner.id, server.id);
      expect(Option.isNone(yield* store.takeMcpOAuthState(owner.id, "oauth-new"))).toBe(true);
      expect(yield* sql`select 1 from mcp_oauth_states where server_id = ${server.id}`).toEqual([]);
    }));
  });
});
