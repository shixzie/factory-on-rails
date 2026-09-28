import { describe, expect, layer } from "@effect/vitest";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, Option } from "effect";
import { migrate } from "../src/db.js";
import { Store } from "../src/store.js";
import { NodeContext } from "@effect/platform-node";
import { TestDbLive, testDatabaseUrl } from "./db.js";

const StoreTest = Store.Live.pipe(Layer.provideMerge(TestDbLive));

describe.skipIf(!testDatabaseUrl)("Store (Postgres)", () => {
  layer(StoreTest, { timeout: 30_000 })((it) => {
    const user = Effect.flatMap(Store, (store) =>
      store.upsertUser({
        github_id: 1,
        github_login: "octo",
        name: null,
        avatar_url: null,
        access_token_enc: "enc",
        access_token_expires_at: null,
        refresh_token_enc: null,
        refresh_token_expires_at: null,
      }),
    );
    const enqueue = (userId: string, task: string) =>
      Effect.flatMap(Store, (store) =>
        store.enqueueRun({ user_id: userId, repo_full_name: "o/r", installation_id: 7, base_branch: "main", task }),
      );

    it.effect("migrations are idempotent", () =>
      Effect.gen(function* () {
        expect(yield* migrate.pipe(Effect.provide(NodeContext.layer))).toEqual([]);
      }),
    );

    it.effect("upserts users by GitHub id", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const first = yield* user;
        const again = yield* store.upsertUser({
          github_id: 1,
          github_login: "octo-renamed",
          name: "Octo",
          avatar_url: null,
          access_token_enc: "enc2",
          access_token_expires_at: null,
          refresh_token_enc: null,
          refresh_token_expires_at: null,
        });
        expect(again.id).toBe(first.id);
        expect(again.github_login).toBe("octo-renamed");
      }),
    );

    it.effect("resolves live sessions only", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const { id } = yield* user;
        yield* store.createSession("live", id, 60);
        yield* store.createSession("expired", id, -1);
        expect(Option.map(yield* store.userForSession("live"), (u) => u.id)).toEqual(Option.some(id));
        expect(Option.isNone(yield* store.userForSession("expired"))).toBe(true);
        yield* store.deleteSession("live");
        expect(Option.isNone(yield* store.userForSession("live"))).toBe(true);
      }),
    );

    it.effect("hands each queued run to exactly one claimer, oldest first", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const { id } = yield* user;
        yield* sql`delete from runs`;
        const a = yield* enqueue(id, "a");
        const b = yield* enqueue(id, "b");
        const claims = yield* Effect.all(
          [1, 2, 3].map((i) => store.claimNextRun(`w${i}`)),
          { concurrency: "unbounded" },
        );
        const claimed = claims.flatMap(Option.toArray);
        expect(claimed.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
        expect(claimed.every((r) => r.status === "running")).toBe(true);
        expect(Option.isNone(yield* store.claimNextRun("w4"))).toBe(true);
      }),
    );

    it.effect("cancels queued runs directly and asks running ones to stop", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const { id } = yield* user;
        yield* sql`delete from runs`;
        const queued = yield* enqueue(id, "q");
        expect(yield* store.requestCancel(queued.id, id)).toBe(true);
        expect(Option.map(yield* store.getRun(queued.id), (r) => r.status)).toEqual(Option.some("cancelled"));

        const running = yield* enqueue(id, "r");
        yield* store.claimNextRun("w");
        expect(yield* store.requestCancel(running.id, id)).toBe(true);
        expect(yield* store.heartbeat(running.id)).toEqual(Option.some("cancelling"));
        yield* store.finishRun(running.id, "cancelled");
        const done = Option.getOrThrow(yield* store.getRun(running.id));
        expect(done.status).toBe("cancelled");
        expect(done.finished_at).toBeInstanceOf(Date);
        expect(yield* store.requestCancel(running.id, id)).toBe(false);
      }),
    );

    it.effect("reaps runs that stopped heartbeating", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const { id } = yield* user;
        yield* sql`delete from runs`;
        const run = yield* enqueue(id, "stale");
        yield* store.claimNextRun("w");
        yield* store.updateRun(run.id, { sandbox_id: "sbx_9" });
        yield* sql`update runs set heartbeat_at = now() - interval '10 minutes' where id = ${run.id}`;
        expect(yield* store.reapStaleRuns(60)).toEqual([{ id: run.id, sandbox_id: "sbx_9" }]);
        expect(Option.map(yield* store.getRun(run.id), (r) => r.status)).toEqual(Option.some("failed"));
      }),
    );

    it.effect("appends and pages events", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const { id } = yield* user;
        const run = yield* enqueue(id, "events");
        yield* store.appendEvents(run.id, [
          { kind: "info", message: "one" },
          { kind: "stdout", message: "two" },
        ]);
        const all = yield* store.listEvents(run.id);
        expect(all.map((e) => e.message)).toEqual(["one", "two"]);
        const after = yield* store.listEvents(run.id, Number(all[0]!.id));
        expect(after.map((e) => e.message)).toEqual(["two"]);
      }),
    );

    it.effect("stores structured event data and lists user messages", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const { id } = yield* user;
        const run = yield* enqueue(id, "structured");
        yield* store.appendEvents(run.id, [
          { kind: "user_message", message: "use pnpm" },
          { kind: "tool_call", message: "Bash", data: { id: "toolu_1", name: "Bash", input: { command: "ls" } } },
          { kind: "user_message", message: "and add tests" },
        ]);
        const all = yield* store.listEvents(run.id);
        expect(all.map((e) => e.data)).toEqual([null, { id: "toolu_1", name: "Bash", input: { command: "ls" } }, null]);
        const messages = yield* store.listUserMessages(run.id, Number(all[0]!.id));
        expect(messages.map((e) => e.message)).toEqual(["and add tests"]);
      }),
    );

    it.effect("keeps one diff per run and clears awaiting_input when a run finishes", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const { id } = yield* user;
        yield* sql`delete from runs`;
        const run = yield* enqueue(id, "diff");
        expect(Option.isNone(yield* store.getDiff(run.id))).toBe(true);
        yield* store.saveDiff(run.id, "diff --git a/x b/x\n", false);
        yield* store.saveDiff(run.id, "diff --git a/y b/y\n", true);
        const diff = Option.getOrThrow(yield* store.getDiff(run.id));
        expect(diff).toMatchObject({ patch: "diff --git a/y b/y\n", truncated: true });
        expect(Option.getOrThrow(yield* store.diffUpdatedAt(run.id))).toEqual(diff.updated_at);

        yield* store.claimNextRun("w");
        yield* store.updateRun(run.id, { awaiting_input: true });
        expect(Option.getOrThrow(yield* store.getRun(run.id)).awaiting_input).toBe(true);
        yield* store.finishRun(run.id, "succeeded");
        expect(Option.getOrThrow(yield* store.getRun(run.id)).awaiting_input).toBe(false);
      }),
    );

    it.effect("stores API keys per user and provider without exposing them in listings", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const { id } = yield* user;
        yield* store.upsertApiKey({ user_id: id, provider: "anthropic", key_enc: "enc-1", hint: "1111" });
        yield* store.upsertApiKey({ user_id: id, provider: "anthropic", key_enc: "enc-2", hint: "2222" });
        const listed = yield* store.listApiKeys(id);
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ provider: "anthropic", hint: "2222" });
        expect(listed[0]).not.toHaveProperty("key_enc");
        expect(yield* store.encryptedApiKeys(id)).toEqual([{ provider: "anthropic", key_enc: "enc-2" }]);
        yield* store.deleteApiKey(id, "anthropic");
        expect(yield* store.listApiKeys(id)).toEqual([]);
      }),
    );
  });
});
