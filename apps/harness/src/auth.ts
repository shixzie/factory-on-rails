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
export const STATE_COOKIE = "factory_oauth_state";

/**
 * Over HTTPS the cookies carry the `__Host-` prefix: the browser then only
 * accepts them host-only, Secure and on `/`, so a page on a sibling subdomain
 * (a sandbox preview on *.preview.<domain>, say) can't plant its own session
 * or login state on the factory.
 */
export const cookieName = (publicUrl: string, name: string) => (publicUrl.startsWith("https://") ? `__Host-${name}` : name);

/** `*` in the allowlist admits any GitHub account; otherwise logins match case-insensitively. */
export const isAllowedLogin = (allowed: ReadonlyArray<string>, login: string): boolean =>
  allowed.includes("*") || allowed.includes(login.toLowerCase());

/** Logins named in the allowlist itself: `*` lets anyone sign in, but names nobody. */
export const namedLogins = (allowed: ReadonlyArray<string>): ReadonlyArray<string> => allowed.filter((l) => l !== "*");

/** No signed-in user: send them to the sign-in page. */
export class Unauthorized extends Data.TaggedError("Unauthorized") {}

/** The user's GitHub authorization expired and can't be refreshed: sign in again. */
export class ReauthRequired extends Data.TaggedError("ReauthRequired") {}

/** Sign-in refused, with a message for the sign-in page. */
export class LoginRejected extends Data.TaggedError("LoginRejected")<{ readonly status: 400 | 403; readonly message: string }> {}

export const baseCookieOptions = (publicUrl: string) => ({
  httpOnly: true,
  secure: publicUrl.startsWith("https://"),
  sameSite: "lax" as const,
  path: "/",
});

export const cookieOptions = (publicUrl: string, maxAgeSeconds: number) => ({
  ...baseCookieOptions(publicUrl),
  maxAge: Duration.seconds(maxAgeSeconds),
});

export const redirectUri = (publicUrl: string) => `${publicUrl}/auth/callback`;

/** The signed-in user, from the session cookie. */
export const currentUser = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const { publicUrl } = yield* HarnessConfig;
  const token = req.cookies[cookieName(publicUrl, SESSION_COOKIE)];
  if (!token) return Option.none<UserRow>();
  return yield* (yield* Store).userForSession(sha256(token));
});

export const requireUser = Effect.flatMap(currentUser, Option.match({
  onNone: () => Effect.fail(new Unauthorized()),
  onSome: Effect.succeed,
}));

export const beginLogin = Effect.gen(function* () {
  const { publicUrl } = yield* HarnessConfig;
  const app = yield* (yield* GitHubUserApi).app;
  // Nothing to sign in with until the setup page has created the GitHub App.
  if (Option.isNone(app)) return HttpServerResponse.redirect("/setup", { status: 302 });
  const state = randomToken(16);
  return yield* HttpServerResponse.redirect(authorizeUrl(app.value.clientId, redirectUri(publicUrl), state)).pipe(
    HttpServerResponse.setCookie(cookieName(publicUrl, STATE_COOKIE), state, cookieOptions(publicUrl, 600)),
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

  const expectedState = req.cookies[cookieName(config.publicUrl, STATE_COOKIE)];
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
    HttpServerResponse.setCookie(
      cookieName(config.publicUrl, SESSION_COOKIE),
      sessionToken,
      cookieOptions(config.publicUrl, config.sessionTtlSeconds),
    ),
    Effect.flatMap(HttpServerResponse.expireCookie(cookieName(config.publicUrl, STATE_COOKIE), baseCookieOptions(config.publicUrl))),
  );
});

export const logout = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const { publicUrl } = yield* HarnessConfig;
  const name = cookieName(publicUrl, SESSION_COOKIE);
  const token = req.cookies[name];
  if (token) yield* (yield* Store).deleteSession(sha256(token));
  return yield* HttpServerResponse.redirect("/").pipe(HttpServerResponse.expireCookie(name, baseCookieOptions(publicUrl)));
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
