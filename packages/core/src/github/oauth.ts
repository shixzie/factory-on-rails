import { GitHubError } from "./http.js";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface UserTokens {
  accessToken: string;
  /** Null when the GitHub App has user-token expiration turned off. */
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

/** URL that starts the GitHub App user authorization (web application flow). */
export function authorizeUrl(client: Pick<OAuthClient, "clientId">, redirectUri: string, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export function parseTokenResponse(body: TokenResponse, now = Date.now()): UserTokens {
  if (body.error || !body.access_token) {
    throw new GitHubError(`GitHub token exchange failed: ${body.error_description ?? body.error ?? "no access_token"}`, 400, body);
  }
  const at = (seconds?: number) => (seconds ? new Date(now + seconds * 1000) : null);
  return {
    accessToken: body.access_token,
    accessTokenExpiresAt: at(body.expires_in),
    refreshToken: body.refresh_token ?? null,
    refreshTokenExpiresAt: at(body.refresh_token_expires_in),
  };
}

async function postToken(params: Record<string, string>): Promise<UserTokens> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "factory-on-rails" },
    body: JSON.stringify(params),
  });
  return parseTokenResponse((await res.json()) as TokenResponse);
}

export function exchangeCode(client: OAuthClient, code: string, redirectUri: string): Promise<UserTokens> {
  return postToken({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    redirect_uri: redirectUri,
  });
}

export function refreshUserToken(client: OAuthClient, refreshToken: string): Promise<UserTokens> {
  return postToken({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}
