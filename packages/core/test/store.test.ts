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

    it.effect("releases stale runs for recovery without losing their sandbox or turn", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const { id } = yield* user;
        yield* sql`delete from runs`;
        const run = yield* enqueue(id, "stale");
        const started = Option.getOrThrow(yield* store.claimNextRun("w"));
        const execution = { sessions: { agent: { name: "agent-1", startedAt: Date.now() } } };
        yield* store.updateRun(run.id, { sandbox_id: "sbx_9", execution });
        yield* sql`update runs set heartbeat_at = now() - interval '10 minutes' where id = ${run.id}`;
        expect(yield* store.reapStaleRuns(60)).toEqual([{ id: run.id, sandbox_id: "sbx_9" }]);
        expect(Option.getOrThrow(yield* store.getRun(run.id))).toMatchObject({
          status: "queued", recovering: true, execution, claimed_by: null, heartbeat_at: null, error: null, finished_at: null,
        });
        const recovered = Option.getOrThrow(yield* store.claimNextRun("replacement"));
        expect(recovered).toMatchObject({
          id: run.id, status: "running", sandbox_id: "sbx_9", turns: started.turns, started_at: started.started_at, execution,
        });
        expect(yield* store.reapStaleRuns(60)).toEqual([]);
      }),
    );

    it.effect("hands a released turn to one replacement and fences writes from its former owner", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const { id } = yield* user;
        yield* sql`delete from runs`;
        const run = yield* enqueue(id, "redeploy");
        expect(run).toMatchObject({ execution: null, recovering: false });
        const started = Option.getOrThrow(yield* store.claimNextRun("old"));
        const execution = {
          checkout: "clone" as const,
          prompt: { text: "original task", commitMessage: "Implement task", deliveredMessageId: "0" },
          sessions: {
            setup: { name: "setup-1", result: { exitCode: 0, stdout: "ready", timedOut: false } },
            agent: { name: "agent-1" },
          },
        };
        yield* store.updateRun(run.id, { execution, branch: "factory/keep", sandbox_id: "sbx" }, "old");
        yield* store.releaseRun(run.id, "old");
        const claims = yield* Effect.all(["new-a", "new-b"].map((worker) => store.claimNextRun(worker)), { concurrency: "unbounded" });
        const claimed = claims.flatMap(Option.toArray);
        expect(claimed).toHaveLength(1);
        const replacement = claimed[0]!;
        expect(replacement).toMatchObject({
          id: run.id, turns: started.turns, started_at: started.started_at, execution, recovering: true,
        });

        expect(yield* store.heartbeat(run.id, "old")).toEqual(Option.none());
        const staleWrite = yield* Effect.flip(store.updateRun(run.id, { execution: null, branch: "factory/stale", sandbox_id: null }, "old"));
        expect(staleWrite._tag).toBe("SqlError");
        yield* store.finishRun(run.id, "failed", "stale failure", "old");
        yield* store.releaseRun(run.id, "old");
        expect(Option.getOrThrow(yield* store.getRun(run.id))).toEqual(replacement);

        expect(yield* store.heartbeat(run.id, replacement.claimed_by!)).toEqual(Option.some("running"));
        yield* store.finishRun(run.id, "succeeded", undefined, replacement.claimed_by!);
        expect(Option.getOrThrow(yield* store.getRun(run.id))).toMatchObject({
          status: "succeeded", execution: null, recovering: false, claimed_by: null, heartbeat_at: null,
        });
        yield* store.releaseRun(run.id, replacement.claimed_by!);
        expect(Option.getOrThrow(yield* store.getRun(run.id)).status).toBe("succeeded");
      }),
    );

    it.effect("preserves cancellation through shutdown, a crash, and cancellation while awaiting recovery", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const { id } = yield* user;
        yield* sql`delete from runs`;
        for (const mode of ["shutdown", "crash", "between"] as const) {
          const run = yield* enqueue(id, mode);
          yield* store.claimNextRun("old");
          if (mode !== "between") yield* store.requestCancel(run.id, id);
          if (mode === "crash") {
            yield* sql`update runs set heartbeat_at = now() - interval '10 minutes' where id = ${run.id}`;
            yield* store.reapStaleRuns(60);
          } else {
            yield* store.releaseRun(run.id, "old");
          }
          if (mode === "between") expect(yield* store.requestCancel(run.id, id)).toBe(true);
          expect(Option.getOrThrow(yield* store.getRun(run.id))).toMatchObject({
            status: "cancelling", recovering: true, claimed_by: null,
          });
          const replacement = Option.getOrThrow(yield* store.claimNextRun("new"));
          expect(replacement).toMatchObject({ id: run.id, status: "cancelling", turns: 1 });
          expect(Option.isNone(yield* store.claimNextRun("other"))).toBe(true);
          yield* store.finishRun(run.id, "cancelled", undefined, "new");
          expect(Option.getOrThrow(yield* store.getRun(run.id))).toMatchObject({ status: "cancelled", recovering: false });
        }
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

    it.effect("deduplicates replayed agent events without dropping ordinary events or later turns", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const { id } = yield* user;
        const run = yield* enqueue(id, "replay");
        const replayed = { kind: "message" as const, message: "working", data: { _replayKey: "1:agent:0" } };
        yield* store.appendEvents(run.id, [replayed, { kind: "info", message: "connected" }]);
        yield* store.appendEvents(run.id, [replayed, { kind: "info", message: "connected" }]);
        yield* store.appendEvents(run.id, [{ ...replayed, data: { _replayKey: "2:agent:0" } }]);
        const events = yield* store.listEvents(run.id);
        expect(events.map((event) => event.message)).toEqual(["working", "connected", "connected", "working"]);
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

    it.effect("continues a finished run as its next turn, with the user's message", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const { id } = yield* user;
        yield* sql`delete from runs`;
        const run = yield* enqueue(id, "first");
        yield* store.claimNextRun("w");
        // Not finished yet: messages go to the live agent instead.
        expect(Option.isNone(yield* store.continueRun(run.id, "too soon"))).toBe(true);
        yield* store.finishRun(run.id, "failed", "boom");

        const queued = Option.getOrThrow(yield* store.continueRun(run.id, "try again"));
        expect(queued.status).toBe("queued");
        expect(queued).toMatchObject({ execution: null, recovering: false, claimed_by: null, heartbeat_at: null });
        expect((yield* store.listUserMessages(run.id, 0)).map((e) => e.message)).toEqual(["try again"]);
        const claimed = Option.getOrThrow(yield* store.claimNextRun("w"));
        expect(claimed).toMatchObject({ id: run.id, turns: 2, error: null, finished_at: null });
      }),
    );

    it.effect("queues a run again when it finishes with a message the agent never got", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const { id } = yield* user;
        yield* sql`delete from runs`;
        const run = yield* enqueue(id, "late message");
        yield* store.claimNextRun("w");
        yield* store.addUserMessage(run.id, "one more thing");
        yield* store.finishRun(run.id, "succeeded");
        expect(Option.getOrThrow(yield* store.getRun(run.id))).toMatchObject({
          status: "queued", execution: null, recovering: false, claimed_by: null, heartbeat_at: null,
        });

        yield* store.claimNextRun("w");
        const [message] = yield* store.listUserMessages(run.id, 0);
        yield* store.updateRun(run.id, { delivered_message_id: message!.id });
        yield* store.finishRun(run.id, "succeeded");
        expect(Option.getOrThrow(yield* store.getRun(run.id)).status).toBe("succeeded");
      }),
    );

    it.effect("hands out idle sandboxes to stop once, and holds their runs until stopped", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const { id } = yield* user;
        yield* sql`delete from runs`;
        const idle = yield* enqueue(id, "idle");
        const recent = yield* enqueue(id, "recent");
        const live = yield* enqueue(id, "live");
        yield* sql`update runs set status = 'succeeded' where id in (${idle.id}, ${recent.id})`;
        yield* sql`update runs set status = 'running' where id = ${live.id}`;
        yield* sql`update runs set sandbox_state = 'running', sandbox_id = 'sbx_' || left(id::text, 4)`;
        yield* sql`update runs set last_activity_at = now() - interval '10 minutes' where id in (${idle.id}, ${live.id})`;

        const claimed = yield* Effect.all([1, 2].map(() => store.claimIdleSandboxes(300, 900, 10)), { concurrency: "unbounded" });
        expect(claimed.flat().map((r) => r.id)).toEqual([idle.id]);
        const row = Option.getOrThrow(yield* store.getRun(idle.id));
        expect(row.sandbox_state).toBe("stopping");
        expect(row.sandbox_state_at).toBeInstanceOf(Date);

        // A message while it stops queues the run, but no runner takes it until the sandbox is saved.
        yield* store.continueRun(idle.id, "more");
        expect(Option.isNone(yield* store.claimNextRun("w"))).toBe(true);
        yield* store.updateRun(idle.id, { sandbox_state: "stopped", sandbox_checkpoint_id: "cp", sandbox_checkpoint_name: "run-x" });
        expect(Option.map(yield* store.claimNextRun("w"), (r) => r.id)).toEqual(Option.some(idle.id));

        // A runner that died mid-stop gives the sandbox back after a while.
        yield* sql`update runs set sandbox_state = 'stopping', sandbox_state_at = now() - interval '1 hour' where id = ${recent.id}`;
        expect((yield* store.claimIdleSandboxes(300, 900, 10)).map((r) => r.id)).toEqual([recent.id]);
      }),
    );

    it.effect("finds and deletes runs with no activity for the retention period", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const { id } = yield* user;
        yield* sql`delete from runs`;
        const old = yield* enqueue(id, "old");
        const fresh = yield* enqueue(id, "fresh");
        const oldButLive = yield* enqueue(id, "old but running");
        yield* sql`update runs set status = 'succeeded' where id in (${old.id}, ${fresh.id})`;
        yield* sql`update runs set status = 'running' where id = ${oldButLive.id}`;
        yield* sql`update runs set last_activity_at = now() - interval '8 days' where id in (${old.id}, ${oldButLive.id})`;

        expect((yield* store.expiredRuns(7, 10)).map((r) => r.id)).toEqual([old.id]);
        // The user came back in between: kept.
        yield* store.continueRun(old.id, "still here");
        expect(yield* store.deleteExpiredRun(old.id, 7)).toBe(false);
        yield* sql`update runs set status = 'succeeded', last_activity_at = now() - interval '8 days' where id = ${old.id}`;
        expect(yield* store.deleteExpiredRun(old.id, 7)).toBe(true);
        expect(Option.isNone(yield* store.getRun(old.id))).toBe(true);
        expect(yield* store.listEvents(old.id)).toEqual([]);
      }),
    );

    it.effect("records a sandbox's preview ports, and preview traffic as activity on a running sandbox", () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const { id } = yield* user;
        yield* sql`delete from runs`;
        const previewed = yield* enqueue(id, "previewed");
        const stopped = yield* enqueue(id, "stopped");
        yield* sql`update runs set status = 'succeeded', sandbox_id = 'sbx', last_activity_at = now() - interval '10 minutes'`;
        yield* sql`update runs set sandbox_state = 'running' where id = ${previewed.id}`;
        yield* sql`update runs set sandbox_state = 'stopped' where id = ${stopped.id}`;

        yield* store.setPreviewPorts(previewed.id, [{ port: 5173, process: "vite" }]);
        expect(Option.getOrThrow(yield* store.getRun(previewed.id)).preview_ports).toEqual([{ port: 5173, process: "vite" }]);

        yield* store.touchPreview(previewed.id);
        yield* store.touchPreview(stopped.id);
        // Someone is using it, so it is not idle.
        expect(yield* store.claimIdleSandboxes(300, 900, 10)).toEqual([]);
        expect((yield* store.previewedSandboxes(60)).map((r) => r.id)).toEqual([previewed.id]);
        expect(Option.getOrThrow(yield* store.getRun(stopped.id)).preview_seen_at).toBeNull();

        yield* store.clearPreviewPorts;
        expect(Option.getOrThrow(yield* store.getRun(previewed.id)).preview_ports).toBeNull();
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
