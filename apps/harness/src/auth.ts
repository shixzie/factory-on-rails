import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import {
  authorizeUrl,
  GitHubUserApi,
  randomToken,
  sha256,
  Store,
  TokenCipher,
  type UserRow,
  type UserTokenColumns,
  type UserTokens,
} from "@factory/core";
import { Data, Duration, Effect, Option, Schema } from "effect";
import { HarnessConfig } from "./config.js";

export const SESSION_COOKIE = "factory_session";

/** `*` in the allowlist admits any GitHub account; otherwise logins match case-insensitively. */
export const isAllowedLogin = (allowed: ReadonlyArray<string>, login: string): boolean =>
  allowed.includes("*") || allowed.includes(login.toLowerCase());
export const STATE_COOKIE = "factory_oauth_state";

/** No signed-in user: send them to the sign-in page. */
export class Unauthorized extends Data.TaggedError("Unauthorized") {}

/** The user's GitHub authorization expired and can't be refreshed: sign in again. */
export class ReauthRequired extends Data.TaggedError("ReauthRequired") {}

/** Sign-in refused, with a message for the sign-in page. */
export class LoginRejected extends Data.TaggedError("LoginRejected")<{ readonly status: 400 | 403; readonly message: string }> {}

const cookieOptions = (publicUrl: string, maxAgeSeconds: number) => ({
  httpOnly: true,
  secure: publicUrl.startsWith("https://"),
  sameSite: "lax" as const,
  path: "/",
  maxAge: Duration.seconds(maxAgeSeconds),
});

export const redirectUri = (publicUrl: string) => `${publicUrl}/auth/callback`;

/** The signed-in user, from the session cookie. */
export const currentUser = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return Option.none<UserRow>();
  return yield* (yield* Store).userForSession(sha256(token));
});

export const requireUser = Effect.flatMap(currentUser, Option.match({
  onNone: () => Effect.fail(new Unauthorized()),
  onSome: Effect.succeed,
}));

export const beginLogin = Effect.gen(function* () {
  const { publicUrl } = yield* HarnessConfig;
  const github = yield* GitHubUserApi;
  const state = randomToken(16);
  return yield* HttpServerResponse.redirect(authorizeUrl(github.clientId, redirectUri(publicUrl), state)).pipe(
    HttpServerResponse.setCookie(STATE_COOKIE, state, cookieOptions(publicUrl, 600)),
  );
});

const encryptTokens = (cipher: TokenCipher["Type"], t: UserTokens): UserTokenColumns => ({
  access_token_enc: cipher.encrypt(t.accessToken),
  access_token_expires_at: t.accessTokenExpiresAt,
  refresh_token_enc: t.refreshToken ? cipher.encrypt(t.refreshToken) : null,
  refresh_token_expires_at: t.refreshTokenExpiresAt,
});

export const completeLogin = Effect.gen(function* () {
  const config = yield* HarnessConfig;
  const github = yield* GitHubUserApi;
  const store = yield* Store;
  const cipher = yield* TokenCipher;
  const req = yield* HttpServerRequest.HttpServerRequest;

  const expectedState = req.cookies[STATE_COOKIE];
  const { code, state } = yield* HttpServerRequest.schemaSearchParams(
    Schema.Struct({ code: Schema.optional(Schema.String), state: Schema.optional(Schema.String) }),
  );
  if (!code || !state || !expectedState || state !== expectedState) {
    return yield* new LoginRejected({ status: 400, message: "Sign-in failed: the login state did not match. Try again." });
  }

  const tokens = yield* github.exchangeCode(code, redirectUri(config.publicUrl));
  const viewer = yield* github.viewer(tokens.accessToken);
  if (!isAllowedLogin(config.allowedLogins, viewer.login)) {
    return yield* new LoginRejected({ status: 403, message: `GitHub user ${viewer.login} is not allowed to use this factory.` });
  }

  const user = yield* store.upsertUser({
    github_id: viewer.id,
    github_login: viewer.login,
    name: viewer.name,
    avatar_url: viewer.avatar_url,
    ...encryptTokens(cipher, tokens),
  });
  const sessionToken = randomToken();
  yield* store.createSession(sha256(sessionToken), user.id, config.sessionTtlSeconds);
  return yield* HttpServerResponse.redirect("/").pipe(
    HttpServerResponse.setCookie(SESSION_COOKIE, sessionToken, cookieOptions(config.publicUrl, config.sessionTtlSeconds)),
    Effect.flatMap(HttpServerResponse.expireCookie(STATE_COOKIE, { path: "/" })),
  );
});

export const logout = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const token = req.cookies[SESSION_COOKIE];
  if (token) yield* (yield* Store).deleteSession(sha256(token));
  return yield* HttpServerResponse.redirect("/").pipe(HttpServerResponse.expireCookie(SESSION_COOKIE, { path: "/" }));
});

/** A usable user access token, refreshed when it is about to expire. */
export const userAccessToken = (user: UserRow) =>
  Effect.gen(function* () {
    const cipher = yield* TokenCipher;
    const soon = Date.now() + 60_000;
    if (!user.access_token_expires_at || user.access_token_expires_at.getTime() > soon) {
      return yield* cipher.decrypt(user.access_token_enc);
    }
    const refreshValid =
      user.refresh_token_enc && (!user.refresh_token_expires_at || user.refresh_token_expires_at.getTime() > soon);
    if (!refreshValid) return yield* new ReauthRequired();

    const refreshToken = yield* cipher.decrypt(user.refresh_token_enc!);
    const tokens = yield* (yield* GitHubUserApi).refresh(refreshToken);
    const enc = encryptTokens(cipher, tokens);
    yield* (yield* Store).updateUserTokens(user.id, enc);
    Object.assign(user, enc);
    return tokens.accessToken;
  });
