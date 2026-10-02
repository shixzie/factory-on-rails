import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Array as Arr, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { createSign } from "node:crypto";
import { InstanceSettings } from "../instance.js";
import { appNotSetUp } from "./oauth.js";
import { executeJson, GitHubError, githubRequest } from "./http.js";
import { readCiChecks, type CiCheck } from "./ci.js";
import { InstallationTokenResponse, PullRequest, PullRequestState } from "./schemas.js";

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
    /** Finds an open PR for this repository's branch and base after a create was interrupted. */
    readonly findOpenPullRequest: (
      token: Redacted.Redacted<string>,
      repoFullName: string,
      refs: { head: string; base: string },
    ) => Effect.Effect<Option.Option<PullRequest>, GitHubError>;
    readonly ciChecks: (token: Redacted.Redacted<string>, repo: string, sha: string) => Effect.Effect<ReadonlyArray<CiCheck>, GitHubError>;
    /** Reads merge state separately from CI, which may still be pending after a merge. */
    readonly pullRequest: (token: Redacted.Redacted<string>, repo: string, number: number) => Effect.Effect<PullRequestState, GitHubError>;
    /** Rewrites an open pull request's title and description. */
    readonly updatePullRequest: (
      token: Redacted.Redacted<string>,
      repoFullName: string,
      number: number,
      pr: { title: string; body: string },
    ) => Effect.Effect<PullRequest, GitHubError>;
  }
>() {
  static readonly Live = Layer.effect(
    GitHubAppApi,
    Effect.gen(function* () {
      const settings = yield* InstanceSettings;
      const client = yield* HttpClient.HttpClient;
      // Read per call: the setup page can create the App while the runner is running.
      const jwt = Effect.flatMap(settings.githubAppAuth, Option.match({
        onNone: () => Effect.fail(appNotSetUp()),
        onSome: (auth) =>
          Effect.try({
            try: () => createAppJwt({ appId: auth.appId, privateKeyPem: Redacted.value(auth.privateKey) }),
            catch: (cause) => new GitHubError({ status: 0, message: `Could not sign the GitHub App JWT (check GITHUB_APP_PRIVATE_KEY): ${String(cause)}` }),
          }),
      }));

      return {
        installationToken: (installationId, scope) =>
          jwt.pipe(
            Effect.flatMap((jwt) =>
              githubRequest("POST", `/app/installations/${installationId}/access_tokens`).pipe(
                HttpClientRequest.bearerToken(jwt),
                HttpClientRequest.bodyUnsafeJson(scope),
                executeJson(client, InstallationTokenResponse),
              ),
            ),
            Effect.map((res) => Redacted.make(res.token)),
          ),
        ciChecks: (token, repo, sha) => readCiChecks(client, token, repo, sha),
        pullRequest: (token, repo, number) =>
          githubRequest("GET", `/repos/${repo}/pulls/${number}`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(token)),
            executeJson(client, PullRequestState),
          ),
        createPullRequest: (token, repoFullName, pr) =>
          githubRequest("POST", `/repos/${repoFullName}/pulls`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(token)),
            HttpClientRequest.bodyUnsafeJson(pr),
            executeJson(client, PullRequest),
          ),
        updatePullRequest: (token, repoFullName, number, pr) =>
          githubRequest("PATCH", `/repos/${repoFullName}/pulls/${number}`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(token)),
            HttpClientRequest.bodyUnsafeJson(pr),
            executeJson(client, PullRequest),
          ),
        findOpenPullRequest: (token, repoFullName, refs) =>
          githubRequest("GET", `/repos/${repoFullName}/pulls`).pipe(
            HttpClientRequest.bearerToken(Redacted.value(token)),
            HttpClientRequest.setUrlParams({
              state: "open",
              head: `${repoFullName.split("/")[0]}:${refs.head}`,
              base: refs.base,
              per_page: "1",
            }),
            executeJson(client, Schema.Array(PullRequest)),
            Effect.map(Arr.head),
          ),
      };
    }),
  );
}
