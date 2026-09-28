import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Context, Effect, Either, Layer, Option, Redacted, Schema } from "effect";
import { InstanceSettings, type CreatedGitHubApp } from "../instance.js";
import { executeJson, GitHubError, githubRequest } from "./http.js";
import { GitHubInstallation, GitHubRepo, GitHubUser, ManifestConversion, OAuthTokenResponse } from "./schemas.js";

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

/** Signing in before the App exists: the setup page creates it. */
export const appNotSetUp = () =>
  new GitHubError({ status: 503, message: "The GitHub App is not set up yet. Finish setup at /setup." });

/** GitHub as the signed-in user: OAuth token exchange plus calls made with their user access token. */
export class GitHubUserApi extends Context.Tag("@factory/GitHubUserApi")<
  GitHubUserApi,
  {
    /** The App users sign in with; none until it is configured or created on the setup page. */
    readonly app: Effect.Effect<Option.Option<{ readonly clientId: string; readonly slug: string; readonly owner: string | null }>>;
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
    /** Trades the code GitHub returns after a manifest registration for the new App's credentials. */
    readonly convertManifest: (code: string) => Effect.Effect<CreatedGitHubApp, GitHubError>;
  }
>() {
  static readonly Live = Layer.effect(
    GitHubUserApi,
    Effect.gen(function* () {
      const settings = yield* InstanceSettings;
      const client = yield* HttpClient.HttpClient;
      // Read per call: the setup page can create the App while the harness is running.
      const oauth = Effect.flatMap(settings.githubOAuth, Option.match({
        onNone: () => Effect.fail(appNotSetUp()),
        onSome: Effect.succeed,
      }));
      const authed = (method: "GET" | "POST", path: string, token: string) =>
        githubRequest(method, path).pipe(HttpClientRequest.bearerToken(token));

      const postToken = (params: Record<string, string>) =>
        Effect.flatMap(oauth, (config) =>
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
          ),
        );

      return {
        app: Effect.map(settings.githubOAuth, Option.map(({ clientId, slug, owner }) => ({ clientId, slug, owner }))),
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
        convertManifest: (code) =>
          githubRequest("POST", `/app-manifests/${encodeURIComponent(code)}/conversions`).pipe(
            executeJson(client, ManifestConversion),
            Effect.map((app) => ({
              appId: String(app.id),
              slug: app.slug,
              clientId: app.client_id,
              clientSecret: app.client_secret,
              privateKey: app.pem,
              owner: app.owner?.login ?? "",
              htmlUrl: app.html_url,
            })),
          ),
      };
    }),
  );
}
