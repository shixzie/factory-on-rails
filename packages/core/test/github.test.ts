import { HttpClient, HttpClientResponse } from "@effect/platform";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Either, Layer } from "effect";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createAppJwt } from "../src/github/app.js";
import { authorizeUrl, GitHubUserApi, parseTokenResponse } from "../src/github/oauth.js";

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
    GitHubUserApi.Live.pipe(Layer.provide(respond(routes)), Layer.provide(config));

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
});
