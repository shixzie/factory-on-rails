import { HttpApp } from "@effect/platform";
import { SqlClient } from "@effect/sql";
import {
  decrypt,
  GitHubError,
  GitHubUserApi,
  PREVIEW_COOKIE,
  sha256,
  Store,
  TokenCipher,
  type GitHubRepo,
} from "@factory/core";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { randomBytes } from "node:crypto";
import { TestDbLive, testDatabaseUrl } from "../../../packages/core/test/db.js";
import { app, originCheck } from "../src/app.js";
import { HarnessConfig } from "../src/config.js";

const ORIGIN = "https://factory.example";
const key = randomBytes(32);
const PREVIEW_KEY = "p".repeat(40);

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
  Layer.succeed(HarnessConfig, {
    publicUrl: ORIGIN,
    allowedLogins: ["shixzie"],
    sessionTtlSeconds: 3600,
    preview: Option.some({ domain: "preview.example", signingKey: Redacted.make(PREVIEW_KEY) }),
  }),
).pipe(Layer.provideMerge(TestDbLive));

describe.skipIf(!testDatabaseUrl)("harness app", () => {
  const runtime = ManagedRuntime.make(TestLayer);
  let handler: (req: Request) => Promise<Response>;
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Layer.Success<typeof TestLayer>>) => runtime.runPromise(effect);
  const request = (path: string, init?: RequestInit) => handler(new Request(`${ORIGIN}${path}`, init));
  const send = (method: string, path: string, cookie: string, body?: unknown) =>
    request(path, {
      method,
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const post = (path: string, cookie: string, body?: unknown) => send("POST", path, cookie, body);
  const json = (res: Response | Promise<Response>): Promise<any> => Promise.resolve(res).then((r) => r.json());

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
        return { user, cookie: `__Host-factory_session=${token}` };
      }),
    );

  beforeAll(async () => {
    handler = HttpApp.toWebHandlerRuntime(await runtime.runtime())(app.pipe(originCheck));
  }, 30_000);
  afterAll(() => runtime.dispose());

  it("serves a health check", async () => {
    expect((await request("/healthz")).status).toBe(200);
  });

  it("answers anonymous API calls with 401 JSON", async () => {
    const res = await request("/api/me");
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ code: "unauthorized", error: "Sign in to continue." });
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
    const res = await request("/auth/callback?code=good&state=evil", { headers: { cookie: "__Host-factory_oauth_state=fine" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/login\?error=Sign-in%20failed/);
  });

  it("refuses GitHub users outside the allowlist", async () => {
    github.login = "mallory";
    const res = await request("/auth/callback?code=good&state=s", { headers: { cookie: "__Host-factory_oauth_state=s" } });
    github.login = "shixzie";
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location")!)).toContain("mallory is not allowed");
    const rows = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`select 1 from users where github_login = 'mallory'`));
    expect(rows).toHaveLength(0);
  });

  it("signs in allowed users and stores their token encrypted", async () => {
    const res = await request("/auth/callback?code=good&state=s", { headers: { cookie: "__Host-factory_oauth_state=s" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("__Host-factory_session=");
    const [user] = await run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ access_token_enc: string }>`select access_token_enc from users where github_login = 'shixzie'`,
      ),
    );
    expect(user!.access_token_enc).not.toContain("ghu_x");
    expect(decrypt(user!.access_token_enc, key)).toBe("ghu_x");
  });

  it("returns the signed-in user", async () => {
    const { cookie } = await signIn("me", 7);
    const res = await request("/api/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      user: { login: "me", name: null, avatarUrl: null },
      hasApiKey: false,
      installUrl: "https://github.com/apps/factory-on-rails/installations/new",
    });
  });

  it("rejects cross-origin writes", async () => {
    const res = await request("/api/runs", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("shows a run only to its owner", async () => {
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

    const mine = await request(`/api/runs/${created.id}`, { headers: { cookie: owner.cookie } });
    expect(mine.status).toBe(200);
    const detail = await json(mine);
    expect(detail.run).toMatchObject({ id: created.id, repo: "o/r", task: "Do <b>things</b>", status: "queued" });
    expect(detail.events).toEqual([]);
    expect((await request(`/api/runs/${created.id}`, { headers: { cookie: other.cookie } })).status).toBe(404);
    expect((await request(`/api/runs/${created.id}/events`, { headers: { cookie: other.cookie } })).status).toBe(404);
    expect((await request(`/api/runs/not-a-uuid`, { headers: { cookie: owner.cookie } })).status).toBe(400);
    const listed = await json(request("/api/runs", { headers: { cookie: owner.cookie } }));
    expect(listed.map((r: { id: string }) => r.id)).toContain(created.id);
    expect(await json(request("/api/runs", { headers: { cookie: other.cookie } }))).toEqual([]);

    const cancelled = await post(`/api/runs/${created.id}/cancel`, owner.cookie);
    expect(cancelled.status).toBe(200);
    expect((await json(cancelled)).status).toBe("cancelled");
    const status = await run(Effect.flatMap(Store, (s) => s.getRun(created.id)));
    expect(status._tag === "Some" && status.value.status).toBe("cancelled");
  });

  it("hands a run's owner a one-time link to a port's preview, and nobody else", async () => {
    const owner = await signIn("previewer", 11);
    const other = await signIn("snoop", 12);
    const created = await run(
      Effect.flatMap(Store, (store) =>
        store.enqueueRun({ user_id: owner.user.id, repo_full_name: "o/r", installation_id: 1, base_branch: "main", task: "t" }),
      ),
    );
    await run(Effect.flatMap(Store, (store) => store.setPreviewPorts(created.id, [{ port: 5173, process: "vite" }])));

    const detail = await json(request(`/api/runs/${created.id}`, { headers: { cookie: owner.cookie } }));
    expect(detail.previewsEnabled).toBe(true);
    expect(detail.run.previewPorts).toEqual([{ port: 5173, process: "vite" }]);

    const res = await post(`/api/runs/${created.id}/previews`, owner.cookie, { port: 5173, path: "/docs" });
    expect(res.status).toBe(200);
    const link = await json(res);
    const host = `p5173-${created.id.replace(/-/g, "")}.preview.example`;
    expect(link.origin).toBe(`https://${host}`);
    const url = new URL(link.url);
    expect(url.host).toBe(host);
    expect(url.pathname).toBe("/__factory/open");
    expect(url.searchParams.get("path")).toBe("/docs");
    const { verifyPreviewGrant } = await import("@factory/core");
    const grant = verifyPreviewGrant(PREVIEW_KEY, url.searchParams.get("token")!, "open");
    expect(grant).toMatchObject({ run: created.id, port: 5173, user: owner.user.id });
    expect(link.url).not.toContain(PREVIEW_COOKIE);

    expect((await post(`/api/runs/${created.id}/previews`, other.cookie, { port: 5173 })).status).toBe(404);
    expect((await post(`/api/runs/${created.id}/previews`, owner.cookie, { port: 70000 })).status).toBe(400);
    const crossSite = await request(`/api/runs/${created.id}/previews`, {
      method: "POST",
      headers: { cookie: owner.cookie, origin: `https://${host}`, "content-type": "application/json" },
      body: JSON.stringify({ port: 5173 }),
    });
    expect(crossSite.status).toBe(403);
  });

  it("takes messages for a live run, shows its activity and its diff", async () => {
    const owner = await signIn("owner", 1);
    const created = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const r = yield* store.enqueueRun({ user_id: owner.user.id, repo_full_name: "o/r", installation_id: 1, base_branch: "main", task: "t" });
        yield* store.appendEvents(r.id, [
          { kind: "tool_call", message: "mcp__factory__ask_user", data: { id: "toolu_1", name: "mcp__factory__ask_user", input: { question: "Which?" } } },
        ]);
        yield* store.updateRun(r.id, { awaiting_input: true });
        return r;
      }),
    );
    expect((await request(`/api/runs/${created.id}/diff`, { headers: { cookie: owner.cookie } })).status).toBe(404);
    expect((await post(`/api/runs/${created.id}/messages`, owner.cookie, { text: "  " })).status).toBe(400);

    const sent = await post(`/api/runs/${created.id}/messages`, owner.cookie, { text: "The second one" });
    expect(sent.status).toBe(201);
    expect((await json(sent)).awaitingInput).toBe(false);

    await run(Effect.flatMap(Store, (store) => store.saveDiff(created.id, "diff --git a/x b/x\n", false)));
    const detail = await json(request(`/api/runs/${created.id}`, { headers: { cookie: owner.cookie } }));
    expect(detail.events.map((e: { kind: string; data: unknown }) => [e.kind, e.data])).toEqual([
      ["tool_call", { id: "toolu_1", name: "mcp__factory__ask_user", input: { question: "Which?" } }],
      ["user_message", null],
    ]);
    expect(detail.hasMore).toBe(false);
    expect(detail.diff).toMatchObject({ patch: "diff --git a/x b/x\n", truncated: false });
    const page = await json(request(`/api/runs/${created.id}/events?after=${detail.events[0].id}`, { headers: { cookie: owner.cookie } }));
    expect(page.events.map((e: { message: string }) => e.message)).toEqual(["The second one"]);
    expect(page.diffUpdatedAt).toBe(detail.diff.updatedAt);

    await post(`/api/runs/${created.id}/cancel`, owner.cookie);
    expect(detail.run).toMatchObject({ sandboxState: "none" });
  });

  it("continues a finished run when the user writes to it", async () => {
    const owner = await signIn("continuer", 4);
    const created = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const r = yield* store.enqueueRun({ user_id: owner.user.id, repo_full_name: "o/r", installation_id: 1, base_branch: "main", task: "t" });
        yield* store.updateRun(r.id, { sandbox_id: "sbx_1", sandbox_state: "stopped" });
        yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`update runs set status = 'succeeded' where id = ${r.id}`);
        return r;
      }),
    );
    const noKey = await post(`/api/runs/${created.id}/messages`, owner.cookie, { text: "Now add tests" });
    expect(noKey.status).toBe(400);
    expect((await json(noKey)).code).toBe("api_key_required");

    await send("PUT", "/api/settings/keys/anthropic", owner.cookie, { key: "sk-ant-" + "c".repeat(30) });
    const sent = await post(`/api/runs/${created.id}/messages`, owner.cookie, { text: "Now add tests" });
    expect(sent.status).toBe(201);
    expect(await json(sent)).toMatchObject({ status: "queued", sandboxState: "stopped", lastActivityAt: expect.any(String) });
    const detail = await json(request(`/api/runs/${created.id}`, { headers: { cookie: owner.cookie } }));
    expect(detail.events.map((e: { kind: string; message: string }) => `${e.kind}:${e.message}`)).toEqual(["user_message:Now add tests"]);
    await send("DELETE", "/api/settings/keys/anthropic", owner.cookie);
  });

  it("asks the user to wait while a run is stopping", async () => {
    const owner = await signIn("waiter", 5);
    const created = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        const r = yield* store.enqueueRun({ user_id: owner.user.id, repo_full_name: "o/r", installation_id: 1, base_branch: "main", task: "t" });
        yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`update runs set status = 'cancelling' where id = ${r.id}`);
        return r;
      }),
    );
    const res = await post(`/api/runs/${created.id}/messages`, owner.cookie, { text: "wait" });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/stopping/);
  });

  describe("bring your own key", () => {
    it("refuses to start a run for users without a key", async () => {
      const { cookie } = await signIn("byok", 3);
      const res = await post("/api/runs", cookie, { installationId: 1, repo: "o/r", task: "do it" });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe("api_key_required");
    });

    it("rejects malformed keys and unknown providers", async () => {
      const { cookie } = await signIn("byok", 3);
      expect((await send("PUT", "/api/settings/keys/anthropic", cookie, { key: "not-a-key" })).status).toBe(400);
      expect((await send("PUT", "/api/settings/keys/toString", cookie, { key: "sk-ant-" + "x".repeat(30) })).status).toBe(404);
      const rows = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`select 1 from user_api_keys`));
      expect(rows).toHaveLength(0);
    });

    it("saves the key encrypted and only ever shows its last four characters", async () => {
      const { cookie } = await signIn("byok", 3);
      const apiKey = "sk-ant-api03-" + "k".repeat(40) + "WXYZ";
      const res = await send("PUT", "/api/settings/keys/anthropic", cookie, { key: apiKey });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(JSON.parse(body)[0]).toMatchObject({ provider: "anthropic", saved: { hint: "WXYZ" } });
      expect(body).not.toContain(apiKey);

      const [row] = await run(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ key_enc: string }>`select key_enc from user_api_keys`),
      );
      expect(row!.key_enc).not.toContain(apiKey);
      expect(decrypt(row!.key_enc, key)).toBe(apiKey);
      expect(await (await request("/api/settings/keys", { headers: { cookie } })).text()).not.toContain(apiKey);
      expect((await json(request("/api/me", { headers: { cookie } }))).hasApiKey).toBe(true);
    });

    it("only queues runs for repos the app can reach, then removes the key", async () => {
      const { cookie } = await signIn("byok", 3);
      github.repos = [
        { id: 1, full_name: "shixzie/demo", name: "demo", private: true, default_branch: "trunk", html_url: "h" },
      ];
      const repos = await json(request("/api/repos", { headers: { cookie } }));
      expect(repos).toEqual([
        { installationId: 1, fullName: "shixzie/demo", defaultBranch: "trunk", private: true, htmlUrl: "h" },
      ]);
      expect((await post("/api/runs", cookie, { installationId: 1, repo: "someone/else", task: "x" })).status).toBe(403);
      expect((await post("/api/runs", cookie, { installationId: 2, repo: "shixzie/demo", task: "x" })).status).toBe(403);
      const ok = await post("/api/runs", cookie, { installationId: 1, repo: "shixzie/demo", task: "Add a README" });
      expect(ok.status).toBe(201);
      expect((await json(ok)).id).toMatch(/^[0-9a-f-]{36}$/);
      const [queued] = await run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ base_branch: string; status: string }>`select base_branch, status from runs where repo_full_name = 'shixzie/demo'`,
        ),
      );
      expect(queued).toEqual({ base_branch: "trunk", status: "queued" });

      expect((await send("DELETE", "/api/settings/keys/anthropic", cookie)).status).toBe(200);
      const rows = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`select 1 from user_api_keys`));
      expect(rows).toHaveLength(0);
    });
  });

  it("shows GitHub's reason when repo creation is refused", async () => {
    const { cookie } = await signIn("owner", 1);
    expect((await post("/api/repos", cookie, { name: "bad name", private: true })).status).toBe(400);
    const res = await post("/api/repos", cookie, { name: "taken", private: true });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ code: "github", error: "name already exists" });
  });
});
