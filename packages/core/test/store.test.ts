import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Sql } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import * as store from "../src/store.js";

// Integration tests: run against a disposable database, e.g.
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/factory_test pnpm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("store (Postgres)", () => {
  let sql: Sql;
  let userId: string;

  beforeAll(async () => {
    sql = createDb(url!, { max: 4 });
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    await migrate(sql, () => {});
    const user = await store.upsertUser(sql, {
      github_id: 1,
      github_login: "octo",
      name: null,
      avatar_url: null,
      access_token_enc: "enc",
      access_token_expires_at: null,
      refresh_token_enc: null,
      refresh_token_expires_at: null,
    });
    userId = user.id;
  });

  afterAll(async () => {
    await sql?.end();
  });

  const enqueue = (task: string) =>
    store.enqueueRun(sql, { user_id: userId, repo_full_name: "o/r", installation_id: 7, base_branch: "main", task });

  it("migrations are idempotent", async () => {
    expect(await migrate(sql, () => {})).toEqual([]);
  });

  it("upserts users by GitHub id", async () => {
    const again = await store.upsertUser(sql, {
      github_id: 1,
      github_login: "octo-renamed",
      name: "Octo",
      avatar_url: null,
      access_token_enc: "enc2",
      access_token_expires_at: null,
      refresh_token_enc: null,
      refresh_token_expires_at: null,
    });
    expect(again.id).toBe(userId);
    expect(again.github_login).toBe("octo-renamed");
  });

  it("resolves live sessions only", async () => {
    await store.createSession(sql, "live", userId, 60);
    await store.createSession(sql, "expired", userId, -1);
    expect((await store.userForSession(sql, "live"))?.id).toBe(userId);
    expect(await store.userForSession(sql, "expired")).toBeUndefined();
    await store.deleteSession(sql, "live");
    expect(await store.userForSession(sql, "live")).toBeUndefined();
  });

  it("hands each queued run to exactly one claimer, oldest first", async () => {
    await sql`delete from runs`;
    const a = await enqueue("a");
    const b = await enqueue("b");
    const claims = await Promise.all([1, 2, 3].map((i) => store.claimNextRun(sql, `w${i}`)));
    const ids = claims.filter(Boolean).map((r) => r!.id);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
    expect(claims.filter(Boolean).every((r) => r!.status === "running")).toBe(true);
    expect(await store.claimNextRun(sql, "w4")).toBeUndefined();
  });

  it("cancels queued runs directly and asks running ones to stop", async () => {
    const queued = await enqueue("q");
    expect(await store.requestCancel(sql, queued.id, userId)).toBe(true);
    expect((await store.getRun(sql, queued.id))?.status).toBe("cancelled");

    await sql`delete from runs where status = 'queued'`;
    const running = await enqueue("r");
    await store.claimNextRun(sql, "w");
    expect(await store.requestCancel(sql, running.id, userId)).toBe(true);
    expect(await store.heartbeat(sql, running.id)).toBe("cancelling");
    await store.finishRun(sql, running.id, "cancelled");
    const done = await store.getRun(sql, running.id);
    expect(done?.status).toBe("cancelled");
    expect(done?.finished_at).toBeInstanceOf(Date);
    expect(await store.requestCancel(sql, running.id, userId)).toBe(false);
  });

  it("reaps runs that stopped heartbeating", async () => {
    await sql`delete from runs`;
    const run = await enqueue("stale");
    await store.claimNextRun(sql, "w");
    await store.updateRun(sql, run.id, { sandbox_id: "sbx_9" });
    await sql`update runs set heartbeat_at = now() - interval '10 minutes' where id = ${run.id}`;
    expect(await store.reapStaleRuns(sql, 60)).toEqual([{ id: run.id, sandbox_id: "sbx_9" }]);
    expect((await store.getRun(sql, run.id))?.status).toBe("failed");
  });

  it("appends and pages events", async () => {
    const run = await enqueue("events");
    await store.appendEvents(sql, run.id, [
      { kind: "info", message: "one" },
      { kind: "stdout", message: "two" },
    ]);
    const all = await store.listEvents(sql, run.id);
    expect(all.map((e) => e.message)).toEqual(["one", "two"]);
    const after = await store.listEvents(sql, run.id, Number(all[0]!.id));
    expect(after.map((e) => e.message)).toEqual(["two"]);
  });
});
