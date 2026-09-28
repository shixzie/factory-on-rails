import { HttpApp } from "@effect/platform";
import { SqlClient } from "@effect/sql";
import {
  decrypt,
  GitHubError,
  GitHubUserApi,
  sha256,
  Store,
  TokenCipher,
  type GitHubRepo,
} from "@factory/core";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime } from "effect";
import { randomBytes } from "node:crypto";
import { TestDbLive, testDatabaseUrl } from "../../../packages/core/test/db.js";
import { app, originCheck } from "../src/app.js";
import { HarnessConfig } from "../src/config.js";

const ORIGIN = "https://factory.example";
const key = randomBytes(32);

/** A scriptable GitHub: tests set the viewer login and the repos the app can see. */
const github = { login: "shixzie", repos: [] as GitHubRepo[] };
const GitHubTest = Layer.succeed(GitHubUserApi, {
  clientId: "Iv1.test",
  appSlug: "factory-on-rails",
  exchangeCode: (code) =>
    code === "good"
      ? Effect.succeed({ accessToken: "ghu_x", accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null })
      : Effect.fail(new GitHubError({ status: 400, message: "bad code" })),
  refresh: () => Effect.fail(new GitHubError({ status: 400, message: "no refresh" })),
  viewer: () => Effect.succeed({ id: 99, login: github.login, name: null, avatar_url: "" }),
  installations: () => Effect.succeed([{ id: 1, account: { login: "shixzie" } }]),
  installationRepos: () => Effect.succeed(github.repos),
  createRepo: () => Effect.fail(new GitHubError({ status: 422, message: "name already exists" })),
});

const TestLayer = Layer.mergeAll(
  Store.Live,
  GitHubTest,
  Layer.succeed(TokenCipher, TokenCipher.fromKey(key)),
  Layer.succeed(HarnessConfig, { publicUrl: ORIGIN, allowedLogins: ["shixzie"], sessionTtlSeconds: 3600 }),
).pipe(Layer.provideMerge(TestDbLive));

describe.skipIf(!testDatabaseUrl)("harness app", () => {
  const runtime = ManagedRuntime.make(TestLayer);
  let handler: (req: Request) => Promise<Response>;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Layer.Success<typeof TestLayer>>) => runtime.runPromise(effect);
  const request = (path: string, init?: RequestInit) => handler(new Request(`${ORIGIN}${path}`, init));
  const post = (path: string, cookie: string, body: Record<string, string> = {}) =>
    request(path, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });

  const signIn = (login: string, githubId: number) =>
    run(
      Effect.gen(function* () {
        const store = yield* Store;
        const user = yield* store.upsertUser({
          github_id: githubId,
          github_login: login,
          name: null,
          avatar_url: null,
          access_token_enc: TokenCipher.fromKey(key).encrypt("ghu_t"),
          access_token_expires_at: null,
          refresh_token_enc: null,
          refresh_token_expires_at: null,
        });
        const token = randomBytes(16).toString("hex");
        yield* store.createSession(sha256(token), user.id, 60);
        return { user, cookie: `factory_session=${token}` };
      }),
    );

  beforeAll(async () => {
    handler = HttpApp.toWebHandlerRuntime(await runtime.runtime())(app.pipe(originCheck));
  }, 30_000);
  afterAll(() => runtime.dispose());

  it("serves a health check", async () => {
    expect((await request("/healthz")).status).toBe(200);
  });

  it("shows the sign-in page to anonymous visitors", async () => {
    const html = await (await request("/")).text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Sign in with GitHub");
  });

  it("starts GitHub login with an HttpOnly state cookie", async () => {
    const res = await request("/auth/login");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    const state = location.searchParams.get("state");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(res.headers.get("set-cookie")).toContain(`factory_oauth_state=${state}`);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  });

  it("rejects a callback whose state does not match", async () => {
    const res = await request("/auth/callback?code=good&state=evil", { headers: { cookie: "factory_oauth_state=fine" } });
    expect(res.status).toBe(400);
  });

  it("refuses GitHub users outside the allowlist", async () => {
    github.login = "mallory";
    const res = await request("/auth/callback?code=good&state=s", { headers: { cookie: "factory_oauth_state=s" } });
    github.login = "shixzie";
    expect(res.status).toBe(403);
    const rows = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`select 1 from users where github_login = 'mallory'`));
    expect(rows).toHaveLength(0);
  });

  it("signs in allowed users and stores their token encrypted", async () => {
    const res = await request("/auth/callback?code=good&state=s", { headers: { cookie: "factory_oauth_state=s" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("factory_session=");
    const [user] = await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ access_token_enc: string }>`select access_token_enc from users where github_login = 'shixzie'`,
      ),
    );
    expect(user!.access_token_enc).not.toContain("ghu_x");
    expect(decrypt(user!.access_token_enc, key)).toBe("ghu_x");
  });

  it("rejects cross-origin form posts", async () => {
    const res = await request("/runs", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("shows a run only to its owner, escaped", async () => {
    const owner = await signIn("owner", 1);
    const other = await signIn("other", 2);
    const created = await run(
      Effect.flatMap(Store, (store) =>
        store.enqueueRun({
          user_id: owner.user.id,
          repo_full_name: "o/r",
          installation_id: 1,
          base_branch: "main",
          task: "Do <b>things</b>",
        }),
      ),
    );

    const mine = await request(`/runs/${created.id}`, { headers: { cookie: owner.cookie } });
    expect(mine.status).toBe(200);
    expect(await mine.text()).toContain("Do &lt;b&gt;things&lt;/b&gt;");
    expect((await request(`/runs/${created.id}`, { headers: { cookie: other.cookie } })).status).toBe(404);
    expect((await request(`/runs/not-a-uuid`, { headers: { cookie: owner.cookie } })).status).toBe(400);

    expect((await post(`/runs/${created.id}/cancel`, owner.cookie)).status).toBe(302);
    const status = await run(Effect.flatMap(Store, (s) => s.getRun(created.id)));
    expect(status._tag === "Some" && status.value.status).toBe("cancelled");
  });

  describe("bring your own key", () => {
    it("sends users without a key to Settings instead of starting a run", async () => {
      const { cookie } = await signIn("byok", 3);
      const res = await post("/runs", cookie, { repo: "1:o/r", task: "do it" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/settings");
    });

    it("rejects malformed keys and unknown providers", async () => {
      const { cookie } = await signIn("byok", 3);
      expect((await post("/settings/keys/anthropic", cookie, { key: "not-a-key" })).status).toBe(400);
      expect((await post("/settings/keys/toString", cookie, { key: "sk-ant-" + "x".repeat(30) })).status).toBe(404);
      const rows = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`select 1 from user_api_keys`));
      expect(rows).toHaveLength(0);
    });

    it("saves the key encrypted and only ever shows its last four characters", async () => {
      const { cookie } = await signIn("byok", 3);
      const apiKey = "sk-ant-api03-" + "k".repeat(40) + "WXYZ";
      const res = await post("/settings/keys/anthropic", cookie, { key: apiKey });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("…WXYZ");
      expect(html).not.toContain(apiKey);

      const [row] = await run(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ key_enc: string }>`select key_enc from user_api_keys`),
      );
      expect(row!.key_enc).not.toContain(apiKey);
      expect(decrypt(row!.key_enc, key)).toBe(apiKey);
      expect(await (await request("/settings", { headers: { cookie } })).text()).not.toContain(apiKey);
    });

    it("only queues runs for repos the app can reach, then removes the key", async () => {
      const { cookie } = await signIn("byok", 3);
      github.repos = [
        { id: 1, full_name: "shixzie/demo", name: "demo", private: true, default_branch: "trunk", html_url: "h" },
      ];
      expect((await post("/runs", cookie, { repo: "1:someone/else", task: "x" })).status).toBe(403);
      const ok = await post("/runs", cookie, { repo: "1:shixzie/demo", task: "Add a README" });
      expect(ok.status).toBe(302);
      expect(ok.headers.get("location")).toMatch(/^\/runs\/[0-9a-f-]{36}$/);
      const [queued] = await run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ base_branch: string; status: string }>`select base_branch, status from runs where repo_full_name = 'shixzie/demo'`,
        ),
      );
      expect(queued).toEqual({ base_branch: "trunk", status: "queued" });

      await post("/settings/keys/anthropic/delete", cookie);
      const rows = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`select 1 from user_api_keys`));
      expect(rows).toHaveLength(0);
    });
  });

  it("shows GitHub's reason when repo creation is refused", async () => {
    const { cookie } = await signIn("owner", 1);
    const res = await post("/repos", cookie, { name: "taken", private: "1" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("name already exists");
  });
});
