import { HttpClient, HttpClientResponse } from "@effect/platform";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Either, Layer, Option, Redacted } from "effect";
import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { TokenCipher } from "../src/crypto.js";
import { createAppJwt, GitHubAppApi } from "../src/github/app.js";
import { appManifest, manifestFormUrl } from "../src/github/manifest.js";
import { authorizeUrl, GitHubUserApi, parseTokenResponse } from "../src/github/oauth.js";
import { InstanceSettings } from "../src/instance.js";
import { Store, type StoreService } from "../src/store.js";

describe("GitHub App JWT", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

  it("is a verifiable RS256 token with backdated iat and <10m expiry", () => {
    const jwt = createAppJwt({ appId: "123", privateKeyPem: pem }, 1_000_000);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "123" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    expect(verifier.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });
});

describe("OAuth helpers", () => {
  it("builds the authorize URL", () => {
    const url = new URL(authorizeUrl("Iv1.abc", "https://h.example/auth/callback", "st8"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.abc");
    expect(url.searchParams.get("redirect_uri")).toBe("https://h.example/auth/callback");
    expect(url.searchParams.get("state")).toBe("st8");
  });

  it("parses expiring tokens", () => {
    const t = Either.getOrThrow(
      parseTokenResponse(
        { access_token: "ghu_1", expires_in: 28800, refresh_token: "ghr_1", refresh_token_expires_in: 15897600 },
        0,
      ),
    );
    expect(t.accessToken).toBe("ghu_1");
    expect(t.accessTokenExpiresAt?.getTime()).toBe(28_800_000);
    expect(t.refreshToken).toBe("ghr_1");
  });

  it("parses non-expiring tokens", () => {
    const t = Either.getOrThrow(parseTokenResponse({ access_token: "ghu_1" }));
    expect(t.accessTokenExpiresAt).toBeNull();
    expect(t.refreshToken).toBeNull();
  });

  it("surfaces GitHub errors", () => {
    const result = parseTokenResponse({ error: "bad_verification_code", error_description: "The code is wrong" });
    expect(Either.isLeft(result) && result.left.message).toMatch(/The code is wrong/);
  });
});

/** A Store holding only instance settings, in memory, and a cipher: what InstanceSettings.Live needs. */
const memorySettings = (rows = new Map<string, unknown>()) =>
  Layer.mergeAll(
    Layer.succeed(TokenCipher, TokenCipher.fromKey(randomBytes(32))),
    Layer.succeed(Store, {
      getSetting: (key: string) => Effect.sync(() => Option.fromNullable(rows.get(key))),
      putSetting: (key: string, value: unknown, options?: { onlyIfAbsent?: boolean }) =>
        Effect.sync(() => {
          if (options?.onlyIfAbsent && rows.has(key)) return false;
          rows.set(key, JSON.parse(JSON.stringify(value)));
          return true;
        }),
    } as unknown as StoreService),
  );

describe("GitHub pull request reconciliation", () => {
  it.effect("limits lookup to the repository owner, source branch, target branch and open state", () => {
    const client = HttpClient.make((req, url) => Effect.sync(() => {
      expect(req.method).toBe("GET");
      expect(url.pathname).toBe("/repos/acme/demo/pulls");
      expect(url.searchParams.get("state")).toBe("open");
      expect(url.searchParams.get("head")).toBe("acme:factory/run-1");
      expect(url.searchParams.get("base")).toBe("release/next");
      expect(req.headers.authorization).toBe("Bearer repo-token");
      return HttpClientResponse.fromWeb(req, Response.json([{ number: 9, html_url: "https://github.com/acme/demo/pull/9" }]));
    }));
    const layer = GitHubAppApi.Live.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provide(InstanceSettings.Live),
      Layer.provide(memorySettings()),
      Layer.provide(Layer.setConfigProvider(ConfigProvider.fromJson({}))),
    );
    return Effect.gen(function* () {
      const github = yield* GitHubAppApi;
      const found = yield* github.findOpenPullRequest(Redacted.make("repo-token"), "acme/demo", { head: "factory/run-1", base: "release/next" });
      expect(found).toEqual(Option.some({ number: 9, html_url: "https://github.com/acme/demo/pull/9" }));
    }).pipe(Effect.provide(layer));
  });
});

describe("GitHub App manifest", () => {
  it("points GitHub back at the factory and asks for what runs need", () => {
    const manifest = appManifest("https://f.example", "Factory on Rails 0a1b2c");
    expect(manifest).toMatchObject({
      name: "Factory on Rails 0a1b2c",
      url: "https://f.example",
      redirect_url: "https://f.example/auth/setup/github-app",
      callback_urls: ["https://f.example/auth/callback"],
      public: false,
      hook_attributes: { active: false },
    });
    expect(Object.keys(manifest.default_permissions).sort()).toEqual(
      ["administration", "contents", "metadata", "pull_requests", "workflows"],
    );
  });

  it("registers under an account or an organization", () => {
    expect(manifestFormUrl("st8")).toBe("https://github.com/settings/apps/new?state=st8");
    expect(manifestFormUrl("st8", "acme")).toBe("https://github.com/organizations/acme/settings/apps/new?state=st8");
  });
});

describe("InstanceSettings", () => {
  const app = {
    appId: "42",
    slug: "factory-x",
    clientId: "Iv23.x",
    clientSecret: "secret",
    privateKey: "pem",
    owner: "shixzie",
    htmlUrl: "https://github.com/apps/factory-x",
  };
  const settings = (env: Record<string, string>, rows = new Map<string, unknown>()) =>
    InstanceSettings.Live.pipe(Layer.provide(memorySettings(rows)), Layer.provide(Layer.setConfigProvider(ConfigProvider.fromJson(env))));

  it.effect("uses what the setup page stored, encrypted, and keeps the first App", () => {
    const rows = new Map<string, unknown>();
    return Effect.gen(function* () {
      const s = yield* InstanceSettings;
      expect(Option.isNone(yield* s.githubOAuth)).toBe(true);
      expect(yield* s.saveGitHubApp(app)).toBe(true);
      expect(yield* s.saveGitHubApp({ ...app, slug: "second" })).toBe(false);
      expect(JSON.stringify([...rows.values()])).not.toContain('"secret"');
      const oauth = Option.getOrThrow(yield* s.githubOAuth);
      expect([oauth.source, oauth.clientId, oauth.slug, oauth.owner, Redacted.value(oauth.clientSecret)]).toEqual(
        ["setup", "Iv23.x", "factory-x", "shixzie", "secret"],
      );
      const auth = Option.getOrThrow(yield* s.githubAppAuth);
      expect([auth.appId, Redacted.value(auth.privateKey)]).toEqual(["42", "pem"]);

      expect(yield* s.sandboxesReady).toEqual({ ready: false, fromEnv: false });
      yield* s.saveSandboxes({ projectId: "p", environmentId: "e", environmentName: "agents", token: "tok" });
      expect(yield* s.sandboxesReady).toEqual({ ready: true, fromEnv: false });
      const target = Option.getOrThrow(yield* s.sandboxTarget);
      expect([target.source, target.environmentId, Redacted.value(target.token)]).toEqual(["setup", "e", "tok"]);
    }).pipe(Effect.provide(settings({}, rows)));
  });

  it.effect("prefers environment variables over stored settings", () => {
    const rows = new Map<string, unknown>();
    return Effect.gen(function* () {
      const s = yield* InstanceSettings;
      yield* s.saveGitHubApp(app);
      const oauth = Option.getOrThrow(yield* s.githubOAuth);
      expect([oauth.source, oauth.clientId, oauth.slug]).toEqual(["env", "Iv1.env", "env-app"]);
      expect(Option.map(yield* s.githubAppAuth, (a) => a.appId)).toEqual(Option.some("7"));
      expect(Option.map(yield* s.sandboxTarget, (t) => [t.source, t.environmentId])).toEqual(Option.some(["env", "env-agents"]));
      expect(yield* s.sandboxesReady).toEqual({ ready: true, fromEnv: true });
    }).pipe(
      Effect.provide(
        settings(
          {
            GITHUB_APP_CLIENT_ID: "Iv1.env",
            GITHUB_APP_CLIENT_SECRET: "s",
            GITHUB_APP_SLUG: "env-app",
            GITHUB_APP_ID: "7",
            GITHUB_APP_PRIVATE_KEY: "pem",
            RAILWAY_SANDBOX_TOKEN: "t",
            SANDBOX_ENVIRONMENT_ID: "env-agents",
          },
          rows,
        ),
      ),
    );
  });

  it.effect("fails at startup when a group of variables is only half set", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Layer.build(settings({ RAILWAY_SANDBOX_TOKEN: "t" })).pipe(Effect.scoped));
      expect(String(error)).toContain("SANDBOX_ENVIRONMENT_ID");
    }),
  );

  it.effect("learns from the runner that its variables provide sandboxes", () =>
    Effect.gen(function* () {
      const s = yield* InstanceSettings;
      yield* s.reportRunner(true);
      expect(yield* s.sandboxesReady).toEqual({ ready: true, fromEnv: true });
    }).pipe(Effect.provide(settings({}))),
  );
});

describe("GitHubUserApi", () => {
  const requests: Request[] = [];
  const respond = (routes: Record<string, Response>) =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((req) =>
        Effect.sync(() => {
          const url = new URL(req.url);
          requests.push(new Request(req.url, { method: req.method, headers: req.headers }));
          const res = routes[`${req.method} ${url.pathname}`] ?? new Response("{}", { status: 404 });
          return HttpClientResponse.fromWeb(req, res.clone());
        }),
      ),
    );
  const config = Layer.setConfigProvider(
    ConfigProvider.fromJson({ GITHUB_APP_CLIENT_ID: "Iv1.x", GITHUB_APP_CLIENT_SECRET: "s", GITHUB_APP_SLUG: "factory" }),
  );
  const api = (routes: Record<string, Response>) =>
    GitHubUserApi.Live.pipe(
      Layer.provide(respond(routes)),
      Layer.provide(InstanceSettings.Live),
      Layer.provide(memorySettings()),
      Layer.provide(config),
    );

  it.effect("sends the user's token and decodes the viewer", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubUserApi;
      const viewer = yield* gh.viewer("ghu_token");
      expect(viewer).toEqual({ id: 7, login: "shixzie", name: null, avatar_url: "a" });
      expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer ghu_token");
      expect(requests.at(-1)?.headers.get("x-github-api-version")).toBe("2022-11-28");
    }).pipe(
      Effect.provide(api({ "GET /user": Response.json({ id: 7, login: "shixzie", name: null, avatar_url: "a", extra: 1 }) })),
    ),
  );

  it.effect("turns non-2xx answers into GitHubError with GitHub's message", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubUserApi;
      const error = yield* Effect.flip(gh.createRepo("t", { name: "taken", private: true }));
      expect(error._tag).toBe("GitHubError");
      expect(error.status).toBe(422);
      expect(error.message).toContain("name already exists");
    }).pipe(
      Effect.provide(
        api({ "POST /user/repos": Response.json({ message: "name already exists on this account" }, { status: 422 }) }),
      ),
    ),
  );

  it.effect("exchanges the OAuth code and fails on GitHub's 200-with-error answers", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubUserApi;
      const error = yield* Effect.flip(gh.exchangeCode("bad", "https://h/auth/callback"));
      expect(error.message).toContain("The code passed is incorrect");
    }).pipe(
      Effect.provide(
        api({
          "POST /login/oauth/access_token": Response.json({
            error: "bad_verification_code",
            error_description: "The code passed is incorrect or expired.",
          }),
        }),
      ),
    ),
  );

  it.effect("converts a manifest code into the new App's credentials", () =>
    Effect.gen(function* () {
      const gh = yield* GitHubUserApi;
      const app = yield* gh.convertManifest("abc");
      expect(app).toEqual({
        appId: "99",
        slug: "factory-on-rails-0a1b2c",
        clientId: "Iv23.new",
        clientSecret: "cs",
        privateKey: "-----BEGIN RSA PRIVATE KEY-----",
        owner: "shixzie",
        htmlUrl: "https://github.com/apps/factory-on-rails-0a1b2c",
      });
    }).pipe(
      Effect.provide(
        api({
          "POST /app-manifests/abc/conversions": Response.json(
            {
              id: 99,
              slug: "factory-on-rails-0a1b2c",
              name: "Factory on Rails 0a1b2c",
              html_url: "https://github.com/apps/factory-on-rails-0a1b2c",
              owner: { login: "shixzie", id: 1 },
              client_id: "Iv23.new",
              client_secret: "cs",
              webhook_secret: null,
              pem: "-----BEGIN RSA PRIVATE KEY-----",
            },
            { status: 201 },
          ),
        }),
      ),
    ),
  );
});
