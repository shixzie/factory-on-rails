import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Config, Context, Effect, Layer, Redacted } from "effect";
import { createSign } from "node:crypto";
import { pemConfig } from "../config.js";
import { executeJson, GitHubError, githubRequest } from "./http.js";
import { InstallationTokenResponse, PullRequest } from "./schemas.js";

export interface GitHubAppCredentials {
  appId: string;
  privateKeyPem: string;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Signs the short-lived RS256 JWT a GitHub App uses to authenticate as itself.
 * Backdated 60s for clock drift; GitHub caps lifetime at 10 minutes.
 */
export function createAppJwt(creds: GitHubAppCredentials, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: creds.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(creds.privateKeyPem))}`;
}

export const GitHubAppConfig = Config.all({
  appId: Config.string("GITHUB_APP_ID"),
  privateKey: pemConfig("GITHUB_APP_PRIVATE_KEY"),
});

/** GitHub as the App: repo-scoped installation tokens, and PRs opened with them. */
export class GitHubAppApi extends Context.Tag("@factory/GitHubAppApi")<
  GitHubAppApi,
  {
    /**
     * Mints an installation access token narrowed to specific repos and
     * permissions. Agents only ever see tokens scoped to the one repo they
     * work on, valid for an hour.
     */
    readonly installationToken: (
      installationId: number,
      scope: { repositories?: string[]; permissions?: Record<string, "read" | "write"> },
    ) => Effect.Effect<Redacted.Redacted<string>, GitHubError>;
    readonly createPullRequest: (
      token: Redacted.Redacted<string>,
      repoFullName: string,
      pr: { title: string; body: string; head: string; base: string },
    ) => Effect.Effect<PullRequest, GitHubError>;
  }
>() {
  static readonly Live = Layer.effect(
    GitHubAppApi,
    Effect.gen(function* () {
      const config = yield* GitHubAppConfig;
      const client = yield* HttpClient.HttpClient;
      const creds = { appId: config.appId, privateKeyPem: Redacted.value(config.privateKey) };

      return {
        installationToken: (installationId, scope) =>
          Effect.try({
            try: () => createAppJwt(creds),
            catch: (cause) => new GitHubError({ status: 0, message: `Could not sign the GitHub App JWT (check GITHUB_APP_PRIVATE_KEY): ${String(cause)}` }),
          }).pipe(
            Effect.flatMap((jwt) =>
              githubRequest("POST", `/app/installations/${installationId}/access_tokens`).pipe(
                HttpClientRequest.bearerToken(jwt),
                HttpClientRequest.bodyUnsafeJson(scope),
                executeJson(client, InstallationTokenResponse),
              ),
            ),
            Effect.map((res) => Redacted.make(res.token)),
          ),
        createPullRequest: (token, repoFullName, pr) =>
          githubRequest("POST", `/repos/${repoFullName}/pulls`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(token)),
            HttpClientRequest.bodyUnsafeJson(pr),
            executeJson(client, PullRequest),
          ),
      };
    }),
  );
}
