import {
  createSession,
  decrypt,
  deleteSession,
  encrypt,
  exchangeCode,
  randomToken,
  refreshUserToken,
  sha256,
  updateUserTokens,
  upsertUser,
  UserGitHub,
  userForSession,
  authorizeUrl,
  type Sql,
  type UserRow,
  type UserTokens,
} from "@factory/core";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { HarnessConfig } from "./config.js";

export const SESSION_COOKIE = "factory_session";
export const STATE_COOKIE = "factory_oauth_state";

export type Env = { Variables: { user: UserRow | null } };

export class ReauthRequired extends Error {
  constructor() {
    super("GitHub authorization expired; sign in again");
  }
}

function cookieOptions(config: HarnessConfig, maxAge: number) {
  return {
    httpOnly: true,
    secure: config.publicUrl.startsWith("https://"),
    sameSite: "Lax" as const,
    path: "/",
    maxAge,
  };
}

export const redirectUri = (config: HarnessConfig) => `${config.publicUrl}/auth/callback`;

/** Loads the signed-in user (or null) from the session cookie. */
export function sessionMiddleware(sql: Sql): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    c.set("user", token ? ((await userForSession(sql, sha256(token))) ?? null) : null);
    await next();
  };
}

/**
 * Rejects state-changing requests whose Origin is not ours. Together with
 * SameSite=Lax cookies this is the CSRF defence for the HTML forms.
 */
export function originCheck(config: HarnessConfig): MiddlewareHandler {
  const expected = new URL(config.publicUrl).origin;
  return async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin !== expected) return c.text("Cross-origin request rejected", 403);
    }
    await next();
  };
}

export function beginLogin(c: Context, config: HarnessConfig): Response {
  const state = randomToken(16);
  setCookie(c, STATE_COOKIE, state, cookieOptions(config, 600));
  return c.redirect(authorizeUrl(config.github, redirectUri(config), state));
}

function encryptTokens(t: UserTokens, key: Buffer) {
  return {
    access_token_enc: encrypt(t.accessToken, key),
    access_token_expires_at: t.accessTokenExpiresAt,
    refresh_token_enc: t.refreshToken ? encrypt(t.refreshToken, key) : null,
    refresh_token_expires_at: t.refreshTokenExpiresAt,
  };
}

export async function completeLogin(
  c: Context,
  sql: Sql,
  config: HarnessConfig,
): Promise<{ ok: true } | { ok: false; status: 400 | 403; message: string }> {
  const expectedState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  const { code, state } = c.req.query();
  if (!code || !state || !expectedState || state !== expectedState) {
    return { ok: false, status: 400, message: "Sign-in failed: the login state did not match. Try again." };
  }

  const tokens = await exchangeCode(config.github, code, redirectUri(config));
  const viewer = await new UserGitHub(tokens.accessToken).viewer();
  if (!config.allowedLogins.includes(viewer.login.toLowerCase())) {
    return { ok: false, status: 403, message: `GitHub user ${viewer.login} is not allowed to use this factory.` };
  }

  const user = await upsertUser(sql, {
    github_id: viewer.id,
    github_login: viewer.login,
    name: viewer.name,
    avatar_url: viewer.avatar_url,
    ...encryptTokens(tokens, config.encryptionKey),
  });
  const sessionToken = randomToken();
  await createSession(sql, sha256(sessionToken), user.id, config.sessionTtlSeconds);
  setCookie(c, SESSION_COOKIE, sessionToken, cookieOptions(config, config.sessionTtlSeconds));
  return { ok: true };
}

export async function logout(c: Context, sql: Sql): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await deleteSession(sql, sha256(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Returns a usable user access token, refreshing it if it is about to expire. */
export async function userAccessToken(sql: Sql, config: HarnessConfig, user: UserRow): Promise<string> {
  const soon = Date.now() + 60_000;
  if (!user.access_token_expires_at || user.access_token_expires_at.getTime() > soon) {
    return decrypt(user.access_token_enc, config.encryptionKey);
  }
  const refreshValid =
    user.refresh_token_enc && (!user.refresh_token_expires_at || user.refresh_token_expires_at.getTime() > soon);
  if (!refreshValid) throw new ReauthRequired();

  const tokens = await refreshUserToken(config.github, decrypt(user.refresh_token_enc!, config.encryptionKey));
  const enc = encryptTokens(tokens, config.encryptionKey);
  await updateUserTokens(sql, user.id, enc);
  Object.assign(user, enc);
  return tokens.accessToken;
}
