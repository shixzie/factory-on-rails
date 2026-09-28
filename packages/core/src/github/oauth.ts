import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Config, Context, Effect, Either, Layer, Redacted, Schema } from "effect";
import { executeJson, GitHubError, githubRequest } from "./http.js";
import { GitHubInstallation, GitHubRepo, GitHubUser, OAuthTokenResponse } from "./schemas.js";

export interface UserTokens {
  readonly accessToken: string;
  /** None when the GitHub App has user-token expiration turned off. */
  readonly accessTokenExpiresAt: Date | null;
  readonly refreshToken: string | null;
  readonly refreshTokenExpiresAt: Date | null;
}

/** URL that starts the GitHub App user authorization (web application flow). */
export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export function parseTokenResponse(body: OAuthTokenResponse, now = Date.now()): Either.Either<UserTokens, GitHubError> {
  if (body.error || !body.access_token) {
    return Either.left(
      new GitHubError({
        status: 400,
        body,
        message: `GitHub token exchange failed: ${body.error_description ?? body.error ?? "no access_token"}`,
      }),
    );
  }
  const at = (seconds?: number) => (seconds ? new Date(now + seconds * 1000) : null);
  return Either.right({
    accessToken: body.access_token,
    accessTokenExpiresAt: at(body.expires_in),
    refreshToken: body.refresh_token ?? null,
    refreshTokenExpiresAt: at(body.refresh_token_expires_in),
  });
}

export const GitHubOAuthConfig = Config.all({
  clientId: Config.string("GITHUB_APP_CLIENT_ID"),
  clientSecret: Config.redacted("GITHUB_APP_CLIENT_SECRET"),
  appSlug: Config.string("GITHUB_APP_SLUG"),
});

/** GitHub as the signed-in user: OAuth token exchange plus calls made with their user access token. */
export class GitHubUserApi extends Context.Tag("@factory/GitHubUserApi")<
  GitHubUserApi,
  {
    readonly clientId: string;
    readonly appSlug: string;
    readonly exchangeCode: (code: string, redirectUri: string) => Effect.Effect<UserTokens, GitHubError>;
    readonly refresh: (refreshToken: string) => Effect.Effect<UserTokens, GitHubError>;
    readonly viewer: (token: string) => Effect.Effect<GitHubUser, GitHubError>;
    readonly installations: (token: string) => Effect.Effect<ReadonlyArray<GitHubInstallation>, GitHubError>;
    /** Repos the user can see *and* the app is installed on, for one installation. */
    readonly installationRepos: (token: string, installationId: number) => Effect.Effect<ReadonlyArray<GitHubRepo>, GitHubError>;
    /** Needs the app's "Repository creation" (or "Administration") write permission. */
    readonly createRepo: (
      token: string,
      input: { name: string; description?: string | undefined; private: boolean },
    ) => Effect.Effect<GitHubRepo, GitHubError>;
  }
>() {
  static readonly Live = Layer.effect(
    GitHubUserApi,
    Effect.gen(function* () {
      const config = yield* GitHubOAuthConfig;
      const client = yield* HttpClient.HttpClient;
      const authed = (method: "GET" | "POST", path: string, token: string) =>
        githubRequest(method, path).pipe(HttpClientRequest.bearerToken(token));

      const postToken = (params: Record<string, string>) =>
        HttpClientRequest.post("https://github.com/login/oauth/access_token").pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("User-Agent", "factory-on-rails"),
          HttpClientRequest.bodyUnsafeJson({
            client_id: config.clientId,
            client_secret: Redacted.value(config.clientSecret),
            ...params,
          }),
          executeJson(client, OAuthTokenResponse),
          Effect.flatMap((body) => parseTokenResponse(body)),
        );

      return {
        clientId: config.clientId,
        appSlug: config.appSlug,
        exchangeCode: (code, redirectUri) => postToken({ code, redirect_uri: redirectUri }),
        refresh: (refreshToken) => postToken({ grant_type: "refresh_token", refresh_token: refreshToken }),
        viewer: (token) => authed("GET", "/user", token).pipe(executeJson(client, GitHubUser)),
        installations: (token) =>
          authed("GET", "/user/installations?per_page=100", token).pipe(
            executeJson(client, Schema.Struct({ installations: Schema.Array(GitHubInstallation) })),
            Effect.map((r) => r.installations),
          ),
        installationRepos: (token, installationId) =>
          authed("GET", `/user/installations/${installationId}/repositories?per_page=100`, token).pipe(
            executeJson(client, Schema.Struct({ repositories: Schema.Array(GitHubRepo) })),
            Effect.map((r) => r.repositories),
          ),
        createRepo: (token, input) =>
          authed("POST", "/user/repos", token).pipe(
            HttpClientRequest.bodyUnsafeJson({ ...input, auto_init: true }),
            executeJson(client, GitHubRepo),
          ),
      };
    }),
  );
}
