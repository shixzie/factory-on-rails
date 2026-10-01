/**
 * Typed client for the harness API, shared by server components (which call
 * the harness over the private network with the visitor's cookie) and client
 * components (which call `/api/*` on this origin, forwarded to the harness).
 * Responses are decoded with the same schemas the harness encodes them with.
 */
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import * as Api from "@factory/core/api";
import { Data, Effect, Either, Layer, Schema } from "effect";

export { Api };

/** A failed API call, with the harness's error code (see `Api.ApiError`). */
export class ApiRequestError extends Data.TaggedError("ApiRequestError")<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
}> {}

const decodeError = Schema.decodeUnknownOption(Api.ApiError);

const call = <A, I>(request: HttpClientRequest.HttpClientRequest, schema: Schema.Schema<A, I>) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(request);
    if (response.status >= 400) {
      const body = yield* Effect.orElseSucceed(response.json, () => null);
      const error = decodeError(body);
      return yield* new ApiRequestError({
        status: response.status,
        code: error._tag === "Some" ? error.value.code : "internal",
        message: error._tag === "Some" ? error.value.error : `The server answered ${response.status}.`,
      });
    }
    return yield* HttpClientResponse.schemaBodyJson(schema)(response);
  }).pipe(
    Effect.catchTags({
      RequestError: (e) => Effect.fail(new ApiRequestError({ status: 0, code: "network", message: e.message })),
      ResponseError: (e) => Effect.fail(new ApiRequestError({ status: e.response.status, code: "internal", message: e.message })),
      ParseError: () =>
        Effect.fail(new ApiRequestError({ status: 0, code: "internal", message: "Unexpected response from the server." })),
    }),
  );

const json = (method: "POST" | "PUT" | "PATCH", url: string, body: unknown) =>
  HttpClientRequest.make(method)(url).pipe(HttpClientRequest.bodyUnsafeJson(body));

export const api = {
  me: call(HttpClientRequest.get("/api/me"), Api.Me),
  repos: call(HttpClientRequest.get("/api/repos"), Schema.Array(Api.ApiRepo)),
  createRepo: (body: Api.CreateRepoBody) => call(json("POST", "/api/repos", body), Api.ApiRepo),
  runs: call(HttpClientRequest.get("/api/runs"), Schema.Array(Api.ApiRun)),
  run: (id: string) => call(HttpClientRequest.get(`/api/runs/${encodeURIComponent(id)}`), Api.RunDetail),
  runEvents: (id: string, after: string) =>
    call(
      HttpClientRequest.get(`/api/runs/${encodeURIComponent(id)}/events`, { urlParams: { after } }),
      Api.RunEventsPage,
    ),
  createRun: (body: Api.CreateRunBody) => call(json("POST", "/api/runs", body), Api.ApiRun),
  runDiff: (id: string) => call(HttpClientRequest.get(`/api/runs/${encodeURIComponent(id)}/diff`), Api.ApiRunDiff),
  sendMessage: (id: string, text: string) =>
    call(json("POST", `/api/runs/${encodeURIComponent(id)}/messages`, { text }), Api.ApiRun),
  openPreview: (id: string, body: Api.OpenPreviewBody) =>
    call(json("POST", `/api/runs/${encodeURIComponent(id)}/previews`, body), Api.PreviewLink),
  linkPullRequest: (id: string, url: string) =>
    call(json("POST", `/api/runs/${encodeURIComponent(id)}/pull-requests`, { url }), Api.ApiRun),
  renameRun: (id: string, title: string) =>
    call(json("PATCH", `/api/runs/${encodeURIComponent(id)}`, { title }), Api.ApiRun),
  settleRun: (id: string) => call(HttpClientRequest.post(`/api/runs/${encodeURIComponent(id)}/settle`), Api.ApiRun),
  cancelRun: (id: string) => call(HttpClientRequest.post(`/api/runs/${encodeURIComponent(id)}/cancel`), Api.ApiRun),
  keys: call(HttpClientRequest.get("/api/settings/keys"), Schema.Array(Api.ApiKeySlot)),
  saveKey: (provider: string, key: string) =>
    call(json("PUT", `/api/settings/keys/${encodeURIComponent(provider)}`, { key }), Schema.Array(Api.ApiKeySlot)),
  deleteKey: (provider: string) =>
    call(HttpClientRequest.del(`/api/settings/keys/${encodeURIComponent(provider)}`), Schema.Array(Api.ApiKeySlot)),
  snapshot: call(HttpClientRequest.get("/api/settings/snapshot"), Api.SnapshotSettings),
  saveSnapshot: (snapshot: string | null) => call(json("PUT", "/api/settings/snapshot", { snapshot }), Api.SnapshotSettings),
  setup: call(HttpClientRequest.get("/api/setup"), Api.SetupStatus),
  createGitHubApp: (body: Api.CreateGitHubAppBody) => call(json("POST", "/api/setup/github-app", body), Api.GitHubAppForm),
  setupSandboxes: (token: string) => call(json("POST", "/api/setup/sandboxes", { token }), Api.SetupStatus),
};

/** An HttpClient that sends every request to `baseUrl`, with extra headers and no caching. */
export const clientLayer = (baseUrl: string, headers: Record<string, string> = {}) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.mapRequest((req) =>
          req.pipe(HttpClientRequest.prependUrl(baseUrl), HttpClientRequest.setHeaders(headers)),
        ),
      ),
    ),
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: "no-store", credentials: "same-origin" })),
  );

/** Runs an API call from the browser against this origin. */
export const runInBrowser = <A>(
  effect: Effect.Effect<A, ApiRequestError, HttpClient.HttpClient>,
  options?: { readonly timeoutMs: number },
): Promise<Either.Either<A, ApiRequestError>> =>
  Effect.runPromise(
    (options
      ? effect.pipe(
          Effect.timeoutFail({
            duration: options.timeoutMs,
            onTimeout: () => new ApiRequestError({ status: 0, code: "network", message: "The factory is taking too long to respond." }),
          }),
        )
      : effect
    ).pipe(Effect.either, Effect.provide(clientLayer(window.location.origin))),
  );
