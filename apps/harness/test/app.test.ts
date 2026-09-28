import { randomBytes } from "node:crypto";
import { createDb, decrypt, encrypt, enqueueRun, migrate, sha256, createSession, type Sql } from "@factory/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { HarnessConfig } from "../src/config.js";

const url = process.env.TEST_DATABASE_URL;
const ORIGIN = "https://factory.example";

const config: HarnessConfig = {
  port: 0,
  publicUrl: ORIGIN,
  databaseUrl: url ?? "",
  github: { appId: "1", appSlug: "factory-on-rails", clientId: "Iv1.test", clientSecret: "s", privateKeyPem: "unused" },
  encryptionKey: randomBytes(32),
  allowedLogins: ["shixzie"],
  sessionTtlSeconds: 3600,
};

describe.skipIf(!url)("harness app", () => {
  let sql: Sql;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    sql = createDb(url!, { max: 2 });
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    await migrate(sql, () => {});
    app = createApp(sql, config);
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => sql?.end());

  it("serves a health check", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });

  it("shows the sign-in page to anonymous visitors", async () => {
    const res = await app.request("/");
    expect(await res.text()).toContain("Sign in with GitHub");
  });

  it("starts GitHub login with a state cookie", async () => {
    const res = await app.request("/auth/login");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    const state = location.searchParams.get("state");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(res.headers.get("set-cookie")).toContain(`factory_oauth_state=${state}`);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  });

  it("rejects a callback whose state does not match", async () => {
    const res = await app.request("/auth/callback?code=c&state=evil", { headers: { cookie: "factory_oauth_state=good" } });
    expect(res.status).toBe(400);
  });

  function stubGitHub(login: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const u = String(input);
        if (u.endsWith("/login/oauth/access_token")) {
          return Response.json({ access_token: "ghu_x", expires_in: 28800, refresh_token: "ghr_x", refresh_token_expires_in: 1e7 });
        }
        if (u.endsWith("/user")) return Response.json({ id: 99, login, name: null, avatar_url: "" });
        throw new Error(`unexpected fetch ${u}`);
      }),
    );
  }

  it("refuses GitHub users outside the allowlist", async () => {
    stubGitHub("mallory");
    const res = await app.request("/auth/callback?code=c&state=s", { headers: { cookie: "factory_oauth_state=s" } });
    expect(res.status).toBe(403);
    expect(await sql`select 1 from users where github_login = 'mallory'`).toHaveLength(0);
  });

  it("signs in allowed users and stores their token encrypted", async () => {
    stubGitHub("shixzie");
    const res = await app.request("/auth/callback?code=c&state=s", { headers: { cookie: "factory_oauth_state=s" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("factory_session=");
    const [user] = await sql`select access_token_enc from users where github_login = 'shixzie'`;
    expect(user!.access_token_enc).not.toContain("ghu_x");
  });

  it("rejects cross-origin form posts", async () => {
    const res = await app.request("/runs", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("shows a run only to its owner", async () => {
    const [owner] = await sql<{ id: string }[]>`
      insert into users (github_id, github_login, access_token_enc)
      values (1, 'owner', ${encrypt("t", config.encryptionKey)}) returning id`;
    const [other] = await sql<{ id: string }[]>`
      insert into users (github_id, github_login, access_token_enc)
      values (2, 'other', ${encrypt("t", config.encryptionKey)}) returning id`;
    await createSession(sql, sha256("owner-token"), owner!.id, 60);
    await createSession(sql, sha256("other-token"), other!.id, 60);
    const run = await enqueueRun(sql, {
      user_id: owner!.id,
      repo_full_name: "o/r",
      installation_id: 1,
      base_branch: "main",
      task: "Do <b>things</b>",
    });

    const mine = await app.request(`/runs/${run.id}`, { headers: { cookie: "factory_session=owner-token" } });
    expect(mine.status).toBe(200);
    const html = await mine.text();
    expect(html).toContain("Do &lt;b&gt;things&lt;/b&gt;");

    const theirs = await app.request(`/runs/${run.id}`, { headers: { cookie: "factory_session=other-token" } });
    expect(theirs.status).toBe(404);

    const cancel = await app.request(`/runs/${run.id}/cancel`, {
      method: "POST",
      headers: { cookie: "factory_session=owner-token", origin: ORIGIN },
    });
    expect(cancel.status).toBe(302);
    const [row] = await sql`select status from runs where id = ${run.id}`;
    expect(row!.status).toBe("cancelled");
  });

  describe("bring your own key", () => {
    const cookie = "factory_session=byok-token";
    const post = (path: string, body?: Record<string, string>) =>
      app.request(path, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body ?? {}).toString(),
      });

    beforeAll(async () => {
      const [u] = await sql<{ id: string }[]>`
        insert into users (github_id, github_login, access_token_enc)
        values (3, 'byok', ${encrypt("t", config.encryptionKey)}) returning id`;
      await createSession(sql, sha256("byok-token"), u!.id, 60);
    });

    it("sends users without a key to Settings instead of starting a run", async () => {
      const res = await post("/runs", { repo: "1:o/r", task: "do it" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/settings");
    });

    it("rejects malformed keys", async () => {
      const res = await post("/settings/keys/anthropic", { key: "not-a-key" });
      expect(res.status).toBe(400);
      expect(await sql`select 1 from user_api_keys`).toHaveLength(0);
    });

    it("rejects unknown providers", async () => {
      expect((await post("/settings/keys/toString", { key: "sk-ant-" + "x".repeat(30) })).status).toBe(404);
    });

    it("saves the key encrypted and only ever shows its last four characters", async () => {
      const key = "sk-ant-api03-" + "k".repeat(40) + "WXYZ";
      const res = await post("/settings/keys/anthropic", { key });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("…WXYZ");
      expect(html).not.toContain(key);

      const [row] = await sql<{ key_enc: string }[]>`select key_enc from user_api_keys`;
      expect(row!.key_enc).not.toContain(key);
      expect(decrypt(row!.key_enc, config.encryptionKey)).toBe(key);

      const page = await (await app.request("/settings", { headers: { cookie } })).text();
      expect(page).toContain("…WXYZ");
      expect(page).not.toContain(key);
    });

    it("removes the key", async () => {
      await post("/settings/keys/anthropic/delete");
      expect(await sql`select 1 from user_api_keys`).toHaveLength(0);
    });
  });
});
