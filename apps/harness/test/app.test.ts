import { HttpApp } from "@effect/platform";
import { SqlClient } from "@effect/sql";
import {
  decrypt,
  GitHubError,
  GitHubUserApi,
  InstanceSettings,
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
import { RailwayApi, RailwayError } from "../src/railway.js";
import { PullRequestStatuses } from "../src/pull-requests.js";
import { TitleError, TitleModel, type TitleProvider } from "../src/titles.js";

const ORIGIN = "https://factory.example";
const key = randomBytes(32);
const PREVIEW_KEY = "p".repeat(40);

/**
 * A scriptable GitHub: tests set the viewer login and the repos the app can see.
 * `envApp` stands for a GitHub App configured with environment variables; with
 * it off, the App is whatever the setup page stored (read through InstanceSettings).
 */
const github = {
  login: "shixzie", repos: [] as GitHubRepo[], envApp: true, manifestOwner: "shixzie",
  prs: new Map<string, { state: "open" | "closed"; merged: boolean; draft?: boolean }>(),
  prCalls: [] as Array<{ token: string; repo: string; number: number }>,
};
const GitHubTest = Layer.effect(
  GitHubUserApi,
  Effect.map(InstanceSettings, (settings) => ({
    app: Effect.suspend(() =>
      github.envApp
        ? Effect.succeed(Option.some({ clientId: "Iv1.test", slug: "factory-on-rails", owner: null }))
        : Effect.map(settings.githubOAuth, Option.map(({ clientId, slug, owner }) => ({ clientId, slug, owner }))),
    ),
    exchangeCode: (code: string) =>
      code === "good"
        ? Effect.succeed({ accessToken: "ghu_x", accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null })
        : Effect.fail(new GitHubError({ status: 400, message: "bad code" })),
    refresh: () => Effect.fail(new GitHubError({ status: 400, message: "no refresh" })),
    viewer: () => Effect.succeed({ id: 99, login: github.login, name: null, avatar_url: "" }),
    installations: () => Effect.succeed([{ id: 1, account: { login: "shixzie" } }]),
    installationRepos: () => Effect.succeed(github.repos),
    pullRequest: (token: string, repo: string, number: number) => Effect.suspend(() => {
      github.prCalls.push({ token, repo, number });
      const pr = github.prs.get(`${repo}/${number}`);
      return pr
        ? Effect.succeed({ ...pr, number, html_url: `https://github.com/${repo}/pull/${number}`, head: { sha: "abc" } })
        : Effect.fail(new GitHubError({ status: 404, message: "Not found" }));
    }),
    createRepo: () => Effect.fail(new GitHubError({ status: 422, message: "name already exists" })),
    convertManifest: (code: string) =>
      code === "manifest-code"
        ? Effect.succeed({
            appId: "4242",
            slug: "factory-on-rails-abc123",
            clientId: "Iv23.fresh",
            clientSecret: "fresh-client-secret",
            privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfresh\n-----END RSA PRIVATE KEY-----",
            owner: github.manifestOwner,
            htmlUrl: "https://github.com/apps/factory-on-rails-abc123",
          })
        : Effect.fail(new GitHubError({ status: 404, message: "code expired" })),
  })),
);

/** Railway's API: records what it was asked, and accepts only the token "good-railway-token". */
const railwayCalls: string[][] = [];
const RailwayTest = Layer.succeed(RailwayApi, {
  provisionSandboxes: (token, projectId) =>
    Effect.suspend(() => {
      railwayCalls.push([token, projectId]);
      return token === "good-railway-token"
        ? Effect.succeed({ projectId, environmentId: "env-agents", environmentName: "agents", token: "project-token-secret" })
        : Effect.fail(new RailwayError({ message: "Railway did not accept that token." }));
    }),
});

/** The title model: records what it was asked and answers with `titles.answer` (or fails when it is null). */
const titles = {
  calls: [] as Array<{ provider: TitleProvider; apiKey: string; task: string }>,
  answer: 'Title: "Add a README."' as string | null,
};
const TitleTest = Layer.succeed(TitleModel, {
  write: (provider, apiKey, task) =>
    Effect.suspend(() => {
      titles.calls.push({ provider, apiKey, task });
      return titles.answer === null ? Effect.fail(new TitleError({ message: "overloaded" })) : Effect.succeed(titles.answer);
    }),
});

const TestLayer = PullRequestStatuses.Live.pipe(Layer.provideMerge(Layer.mergeAll(
  GitHubTest,
  RailwayTest,
  TitleTest,
  Layer.succeed(HarnessConfig, {
    publicUrl: ORIGIN,
    allowedLogins: ["shixzie"],
    sessionTtlSeconds: 3600,
    preview: Option.some({ domain: "preview.example", signingKey: Redacted.make(PREVIEW_KEY) }),
    railwayProjectId: Option.some("project-1"),
    snapshots: [
      { name: "snap-agents", logins: ["snapper"] },
      { name: "node-base", logins: ["*"] },
    ],
  }),
)),
  Layer.provideMerge(InstanceSettings.Live),
  Layer.provideMerge(Layer.mergeAll(Store.Live, Layer.succeed(TokenCipher, TokenCipher.fromKey(key)))),
  Layer.provideMerge(TestDbLive),
);

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
    // A runner whose own variables say where sandboxes go, as on a deployment configured by hand.
    await run(Effect.flatMap(InstanceSettings, (s) => s.reportRunner(true)));
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
      agents: [
        { id: "claude", label: "Claude Code", ready: false },
        { id: "codex", label: "Codex", ready: false },
      ],
      snapshot: null,
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

  describe("run titles", () => {
    const repo = { id: 1, full_name: "shixzie/demo", name: "demo", private: true, default_branch: "main", html_url: "h" };
    const runTitle = (id: string) => run(Effect.flatMap(Store, (s) => s.getRun(id))).then((r) => Option.getOrThrow(r).title);
    /** Title generation runs in the background after the run is created. */
    const eventually = async <A>(check: () => Promise<A>, done: (a: A) => boolean) => {
      for (let i = 0; i < 50; i++) {
        const value = await check();
        if (done(value)) return value;
        await new Promise((r) => setTimeout(r, 20));
      }
      return check();
    };

    it("names a new run with the small model of the run's own provider", async () => {
      const { cookie } = await signIn("titler", 20);
      github.repos = [repo];
      const openaiKey = "sk-proj-" + "t".repeat(30);
      await send("PUT", "/api/settings/keys/anthropic", cookie, { key: "sk-ant-api03-" + "t".repeat(30) });
      await send("PUT", "/api/settings/keys/openai", cookie, { key: openaiKey });
      titles.calls.length = 0;
      titles.answer = '**Title:** "Wire up the login page."';

      const res = await post("/api/runs", cookie, { installationId: 1, repo: "shixzie/demo", task: "  the login page does nothing, wire it up  ", agent: "codex" });
      expect(res.status).toBe(201);
      const created = await json(res);
      expect(created).toMatchObject({ title: null, titleByUser: false });
      const title = await eventually(() => runTitle(created.id), (t) => t !== null);
      expect(title).toBe("Wire up the login page");
      expect(titles.calls).toEqual([{ provider: "openai", apiKey: openaiKey, task: "the login page does nothing, wire it up" }]);
      const detail = await json(request(`/api/runs/${created.id}`, { headers: { cookie } }));
      expect(detail.run).toMatchObject({ title: "Wire up the login page", titleByUser: false });
    });

    it("leaves runs untitled, and running, when no key can name them or the model fails", async () => {
      github.repos = [repo];
      const subscriber = await signIn("subscriber", 21);
      await send("PUT", "/api/settings/keys/claude_oauth", subscriber.cookie, { key: "sk-ant-oat01-" + "s".repeat(30) });
      titles.calls.length = 0;
      const first = await json(post("/api/runs", subscriber.cookie, { installationId: 1, repo: "shixzie/demo", task: "Fix the flaky test" }));
      expect(first.status).toBe("queued");

      const keyed = await signIn("keyed", 22);
      await send("PUT", "/api/settings/keys/anthropic", keyed.cookie, { key: "sk-ant-api03-" + "k".repeat(30) });
      titles.answer = null;
      const second = await json(post("/api/runs", keyed.cookie, { installationId: 1, repo: "shixzie/demo", task: "Fix the flaky test" }));
      expect(second.status).toBe("queued");

      await eventually(async () => titles.calls.length, (n) => n > 0);
      await new Promise((r) => setTimeout(r, 50));
      titles.answer = 'Title: "Add a README."';
      expect(titles.calls.map((c) => c.provider)).toEqual(["anthropic"]);
      expect(await runTitle(first.id)).toBeNull();
      expect(await runTitle(second.id)).toBeNull();
    });

    it("links multiple PRs without replacing the runner's PR, and restricts access to the owner", async () => {
      const owner = await signIn("pr-owner", 123);
      const other = await signIn("pr-other", 124);
      const created = await run(Effect.flatMap(Store, (store) =>
        store.enqueueRun({ user_id: owner.user.id, repo_full_name: "o/r", installation_id: 1, base_branch: "main", task: "x" }),
      ));
      const path = `/api/runs/${created.id}/pull-requests`;
      const first = "https://github.com/o/r/pull/1";
      const second = "https://github.com/o/r/pull/2";
      await run(Effect.flatMap(Store, (store) => store.updateRun(created.id, { pull_request_url: first })));
      expect((await post(path, other.cookie, { url: second })).status).toBe(404);
      for (const url of ["javascript:alert(1)", "https://github.com.evil/o/r/pull/2", "https://github.com/o/r/issues/2", "https://github.com/o/r/pull/0"]) {
        expect((await post(path, owner.cookie, { url })).status).toBe(400);
      }
      const linked = await post(path, owner.cookie, { url: "  https://github.com/O/R/pull/2/  " });
      expect(linked.status).toBe(200);
      expect(await json(linked)).toMatchObject({ pullRequestUrl: first, pullRequestUrls: [first, second] });
      expect(await json(await post(path, owner.cookie, { url: second }))).toMatchObject({ pullRequestUrls: [first, second] });
      const detail = await json(request(`/api/runs/${created.id}`, { headers: { cookie: owner.cookie } }));
      expect(detail.run.pullRequestUrls).toEqual([first, second]);
    });

    it("returns cached PR states consistently in the sidebar, conversation, and event updates", async () => {
      const owner = await signIn("pr-states-owner", 125);
      const created = await run(Effect.gen(function* () {
        const store = yield* Store;
        const created = yield* store.enqueueRun({
          user_id: owner.user.id, repo_full_name: "o/r", installation_id: 1, base_branch: "main", task: "PR states",
        });
        for (const number of [201, 202, 203, 204, 205]) {
          yield* store.linkPullRequest(created.id, `https://github.com/o/linked/pull/${number}`);
        }
        return created;
      }));
      github.prs.set("o/linked/201", { state: "open", merged: false });
      github.prs.set("o/linked/202", { state: "open", merged: false, draft: true });
      github.prs.set("o/linked/203", { state: "closed", merged: false });
      github.prs.set("o/linked/204", { state: "closed", merged: true });
      const before = github.prCalls.length;
      const expected = ["open", "draft", "closed", "merged", "unknown"].map((state, i) => ({
        url: `https://github.com/o/linked/pull/${201 + i}`, state,
      }));
      const listed = await json(request("/api/runs", { headers: { cookie: owner.cookie } }));
      expect(listed[0].pullRequests).toEqual(expected);
      const detail = await json(request(`/api/runs/${created.id}`, { headers: { cookie: owner.cookie } }));
      expect(detail.run.pullRequests).toEqual(expected);
      const events = await json(request(`/api/runs/${created.id}/events`, { headers: { cookie: owner.cookie } }));
      expect(events.run.pullRequests).toEqual(expected);
      expect((await json(post(`/api/runs/${created.id}/cancel`, owner.cookie))).pullRequests).toEqual(expected);
      expect(github.prCalls.slice(before)).toEqual([201, 202, 203, 204, 205].map((number) => ({
        token: "ghu_t", repo: "o/linked", number,
      })));
    });

    it("lets the owner rename a run, and keeps that name", async () => {
      const owner = await signIn("namer", 23);
      const other = await signIn("not-namer", 24);
      const created = await run(
        Effect.flatMap(Store, (store) =>
          store.enqueueRun({ user_id: owner.user.id, repo_full_name: "o/r", installation_id: 1, base_branch: "main", task: "x" }),
        ),
      );
      expect(await run(Effect.flatMap(Store, (s) => s.setGeneratedTitle(created.id, "Generated")))).toBe(true);

      expect((await send("PATCH", `/api/runs/${created.id}`, other.cookie, { title: "Mine now" })).status).toBe(404);
      expect((await send("PATCH", `/api/runs/${created.id}`, owner.cookie, { title: "  \n " })).status).toBe(400);
      expect((await send("PATCH", `/api/runs/${created.id}`, owner.cookie, { title: "x".repeat(81) })).status).toBe(400);
      const renamed = await send("PATCH", `/api/runs/${created.id}`, owner.cookie, { title: "  Login   page\nfix " });
      expect(renamed.status).toBe(200);
      expect(await json(renamed)).toMatchObject({ title: "Login page fix", titleByUser: true });

      expect(await run(Effect.flatMap(Store, (s) => s.setGeneratedTitle(created.id, "Generated again")))).toBe(false);
      expect(await runTitle(created.id)).toBe("Login page fix");
    });
  });

  describe("agents and snapshots", () => {
    it("saves model and effort, returns them in run details, and rejects invalid options", async () => {
      const { cookie } = await signIn("model-picker", 31);
      github.repos = [{ id: 1, full_name: "shixzie/demo", name: "demo", private: true, default_branch: "main", html_url: "h" }];
      await send("PUT", "/api/settings/keys/anthropic", cookie, { key: "sk-ant-api03-" + "a".repeat(30) });
      const body = { installationId: 1, repo: "shixzie/demo", task: "x" };
      const created = await post("/api/runs", cookie, { ...body, model: "opus", reasoningEffort: "high" });
      expect(created.status).toBe(201);
      const selected = await json(created);
      expect(selected).toMatchObject({ model: "opus", reasoningEffort: "high" });
      const detail = await json(request(`/api/runs/${selected.id}`, { headers: { cookie } }));
      expect(detail.run).toMatchObject({ model: "opus", reasoningEffort: "high" });
      const defaults = await json(post("/api/runs", cookie, body));
      expect(defaults).toMatchObject({ model: null, reasoningEffort: null });
      for (const options of [
        { reasoningEffort: "invalid" }, { reasoningEffort: "ultra" },
        { model: "" }, { model: "--help" }, { model: "a\nb" }, { model: "a".repeat(201) },
      ]) {
        expect((await post("/api/runs", cookie, { ...body, ...options })).status).toBe(400);
      }
    });

    it("needs the chosen agent's own key", async () => {
      const { cookie } = await signIn("codexer", 11);
      github.repos = [{ id: 1, full_name: "shixzie/demo", name: "demo", private: true, default_branch: "main", html_url: "h" }];
      await send("PUT", "/api/settings/keys/anthropic", cookie, { key: "sk-ant-api03-" + "a".repeat(30) });
      const refused = await post("/api/runs", cookie, { installationId: 1, repo: "shixzie/demo", task: "x", agent: "codex" });
      expect(refused.status).toBe(400);
      expect(await json(refused)).toMatchObject({ code: "api_key_required", error: expect.stringContaining("Codex") });
      expect((await post("/api/runs", cookie, { installationId: 1, repo: "shixzie/demo", task: "x", agent: "gemini" })).status).toBe(400);

      expect((await send("PUT", "/api/settings/keys/openai", cookie, { key: "sk-proj-" + "o".repeat(30) })).status).toBe(200);
      const me = await json(request("/api/me", { headers: { cookie } }));
      expect(me.agents.map((a: { ready: boolean }) => a.ready)).toEqual([true, true]);
      const ok = await post("/api/runs", cookie, { installationId: 1, repo: "shixzie/demo", task: "x", agent: "codex" });
      expect(ok.status).toBe(201);
      expect((await json(ok)).agent).toBe("codex");
    });

    it("offers each user only their snapshots, and lets one stand in for a key", async () => {
      const snapper = await signIn("snapper", 12);
      const other = await signIn("other-snapper", 13);
      expect(await json(request("/api/settings/snapshot", { headers: { cookie: snapper.cookie } }))).toEqual({
        available: ["snap-agents", "node-base"],
        selected: null,
      });
      expect(await json(request("/api/settings/snapshot", { headers: { cookie: other.cookie } }))).toEqual({
        available: ["node-base"],
        selected: null,
      });
      expect((await send("PUT", "/api/settings/snapshot", other.cookie, { snapshot: "snap-agents" })).status).toBe(400);
      expect((await send("PUT", "/api/settings/snapshot", other.cookie, { snapshot: "run-anything" })).status).toBe(400);

      const saved = await send("PUT", "/api/settings/snapshot", snapper.cookie, { snapshot: "snap-agents" });
      expect(await json(saved)).toEqual({ available: ["snap-agents", "node-base"], selected: "snap-agents" });
      const me = await json(request("/api/me", { headers: { cookie: snapper.cookie } }));
      expect(me).toMatchObject({ hasApiKey: true, snapshot: "snap-agents" });

      github.repos = [{ id: 1, full_name: "shixzie/demo", name: "demo", private: true, default_branch: "main", html_url: "h" }];
      const ok = await post("/api/runs", snapper.cookie, { installationId: 1, repo: "shixzie/demo", task: "x" });
      expect(ok.status).toBe(201);

      await send("PUT", "/api/settings/snapshot", snapper.cookie, { snapshot: null });
      expect((await json(request("/api/me", { headers: { cookie: snapper.cookie } }))).hasApiKey).toBe(false);
    });
  });

  it("shows GitHub's reason when repo creation is refused", async () => {
    const { cookie } = await signIn("owner", 1);
    expect((await post("/api/repos", cookie, { name: "bad name", private: true })).status).toBe(400);
    const res = await post("/api/repos", cookie, { name: "taken", private: true });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ code: "github", error: "name already exists" });
  });
  describe("first-run setup", () => {
    const setupStatus = (cookie = "") => json(request("/api/setup", { headers: cookie ? { cookie } : {} }));
    const startApp = (organization?: string) =>
      request("/api/setup/github-app", {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(organization ? { organization } : {}),
      });
    const callback = (code: string, state: string, cookieState = state) =>
      request(`/auth/setup/github-app?code=${code}&state=${state}`, { headers: { cookie: `__Host-factory_setup_state=${cookieState}` } });
    const errorOf = (res: Response) => new URL(res.headers.get("location")!, ORIGIN).searchParams.get("error");

    beforeAll(async () => {
      github.envApp = false;
      await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`delete from instance_settings`));
    });
    afterAll(() => {
      github.envApp = true;
    });

    it("reports a fresh deployment as not set up, and sends sign-in to /setup", async () => {
      expect(await setupStatus()).toEqual({
        githubApp: null,
        sandboxes: { ready: false, fromEnv: false },
        owners: ["shixzie"],
        viewer: null,
      });
      const login = await request("/auth/login");
      expect(login.status).toBe(302);
      expect(login.headers.get("location")).toBe("/setup");
    });

    it("refuses to start runs until sandboxes are set up", async () => {
      const { cookie } = await signIn("byok", 3);
      await send("PUT", "/api/settings/keys/anthropic", cookie, { key: "sk-ant-" + "s".repeat(30) });
      const res = await post("/api/runs", cookie, { installationId: 1, repo: "shixzie/demo", task: "x" });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe("setup_required");
      await send("DELETE", "/api/settings/keys/anthropic", cookie);
    });

    it("hands the browser a manifest form for GitHub, with a state cookie", async () => {
      const res = await startApp();
      expect(res.status).toBe(200);
      const form = await json(res);
      const action = new URL(form.action);
      expect(action.origin + action.pathname).toBe("https://github.com/settings/apps/new");
      const state = action.searchParams.get("state")!;
      expect(res.headers.get("set-cookie")).toContain(`__Host-factory_setup_state=${state}`);
      const manifest = JSON.parse(form.manifest);
      expect(manifest).toMatchObject({
        url: ORIGIN,
        redirect_url: `${ORIGIN}/auth/setup/github-app`,
        callback_urls: [`${ORIGIN}/auth/callback`],
        public: false,
        default_permissions: { contents: "write", pull_requests: "write", workflows: "write" },
        hook_attributes: { active: false },
      });
      expect(manifest.name).toMatch(/^Factory on Rails [0-9a-f]{6}$/);

      const org = await json(startApp("acme"));
      expect(org.error).toMatch(/Add acme to ALLOWED_GITHUB_LOGINS/);
    });

    it("rejects a callback whose state does not match", async () => {
      const res = await callback("manifest-code", "evil", "fine");
      expect(res.status).toBe(302);
      expect(errorOf(res)).toMatch(/state did not match/);
    });

    it("won't use an App created under an account the allowlist doesn't name", async () => {
      github.manifestOwner = "mallory";
      const res = await callback("manifest-code", "s1");
      github.manifestOwner = "shixzie";
      expect(errorOf(res)).toMatch(/created under mallory/);
      expect((await setupStatus()).githubApp).toBeNull();
    });

    it("stores the new App encrypted and signs in with it", async () => {
      const res = await callback("manifest-code", "s2");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/setup");

      const [row] = await run(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ value: Record<string, string> }>`select value from instance_settings where key = 'github_app'`),
      );
      expect(JSON.stringify(row!.value)).not.toContain("fresh-client-secret");
      expect(decrypt(row!.value.clientSecretEnc!, key)).toBe("fresh-client-secret");
      expect(await setupStatus()).toMatchObject({
        githubApp: {
          slug: "factory-on-rails-abc123",
          fromEnv: false,
          owner: "shixzie",
          installUrl: "https://github.com/apps/factory-on-rails-abc123/installations/new",
        },
        owners: [],
      });

      const login = await request("/auth/login");
      expect(new URL(login.headers.get("location")!).searchParams.get("client_id")).toBe("Iv23.fresh");
      const auth = await run(Effect.flatMap(InstanceSettings, (s) => s.githubAppAuth));
      expect(Option.map(auth, (a) => a.appId)).toEqual(Option.some("4242"));

      // The first App wins: a second registration is turned away before it is converted.
      expect((await startApp()).status).toBe(409);
      expect(errorOf(await callback("manifest-code", "s3"))).toMatch(/already set up/);
    });

    it("lets only an admin set up sandboxes, with a Railway token it doesn't keep", async () => {
      const other = await signIn("other", 2);
      expect((await setupStatus(other.cookie)).viewer).toEqual({ login: "other", admin: false });
      expect((await post("/api/setup/sandboxes", other.cookie, { token: "good-railway-token" })).status).toBe(403);

      const admin = await signIn("shixzie", 100);
      const refused = await post("/api/setup/sandboxes", admin.cookie, { token: "wrong" });
      expect(refused.status).toBe(400);
      expect(await json(refused)).toEqual({ code: "railway", error: "Railway did not accept that token." });

      const res = await post("/api/setup/sandboxes", admin.cookie, { token: "good-railway-token" });
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({ sandboxes: { ready: true, fromEnv: false }, viewer: { login: "shixzie", admin: true } });
      expect(railwayCalls.at(-1)).toEqual(["good-railway-token", "project-1"]);

      const [row] = await run(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ value: unknown }>`select value from instance_settings where key = 'sandboxes'`),
      );
      const stored = JSON.stringify(row!.value);
      expect(stored).not.toContain("good-railway-token");
      expect(stored).not.toContain("project-token-secret");
      const target = await run(Effect.flatMap(InstanceSettings, (s) => s.sandboxTarget));
      expect(Option.map(target, (t) => [t.source, t.environmentId])).toEqual(Option.some(["setup", "env-agents"]));
    });
  });
});
