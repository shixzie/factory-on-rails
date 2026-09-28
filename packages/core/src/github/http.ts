import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Data, Effect, Schema } from "effect";

export const GITHUB_API = "https://api.github.com";

export class GitHubError extends Data.TaggedError("GitHubError")<{
  readonly message: string;
  /** HTTP status, or 0 when the request never got a response. */
  readonly status: number;
  readonly body?: unknown;
}> {}

const METHODS = { GET: HttpClientRequest.get, POST: HttpClientRequest.post, PATCH: HttpClientRequest.patch };

export const githubRequest = (method: keyof typeof METHODS, path: string) =>
  METHODS[method](
    path.startsWith("http") ? path : `${GITHUB_API}${path}`,
  ).pipe(
    HttpClientRequest.setHeaders({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "factory-on-rails",
    }),
  );

/** Executes a request and decodes a 2xx body with `schema`; everything else becomes a GitHubError. */
export const executeJson =
  <A, I>(client: HttpClient.HttpClient, schema: Schema.Schema<A, I>) =>
  (request: HttpClientRequest.HttpClientRequest): Effect.Effect<A, GitHubError> =>
    Effect.gen(function* () {
      const res = yield* client.execute(request);
      if (res.status >= 200 && res.status < 300) {
        return yield* HttpClientResponse.schemaBodyJson(schema)(res);
      }
      const body = yield* Effect.orElseSucceed(res.json, () => null);
      const detail = (body as { message?: string } | null)?.message ?? "";
      return yield* new GitHubError({
        status: res.status,
        body,
        message: `GitHub ${request.method} ${request.url} failed: ${res.status} ${detail}`.trim(),
      });
    }).pipe(
      Effect.mapError((err) =>
        err instanceof GitHubError
          ? err
          : new GitHubError({ status: 0, message: `GitHub ${request.method} ${request.url}: ${err.message}` }),
      ),
    );
