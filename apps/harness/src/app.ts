import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import {
  Api,
  GitHubError,
  GitHubUserApi,
  isModelProvider,
  keyHint,
  MODEL_PROVIDERS,
  Store,
  TokenCipher,
  validateApiKey,
  type ModelProvider,
  type RunEventRow,
  type RunRow,
  type UserRow,
} from "@factory/core";
import { Data, Effect, Option, Schema } from "effect";
import { beginLogin, completeLogin, logout, requireUser, userAccessToken } from "./auth.js";
import { HarnessConfig } from "./config.js";

/**
 * The harness is the web app's API and auth backend. Pages live in apps/web,
 * which serves the public domain and forwards `/api/*` and `/auth/*` here, so
 * the session cookie, OAuth callback and Origin check all see one origin.
 */

/** A request the API refuses, answered as `Api.ApiError` JSON. */
export class ApiFailure extends Data.TaggedError("ApiFailure")<{
  readonly status: 400 | 401 | 403 | 404 | 500;
  readonly code: string;
  readonly message: string;
}> {}

const fail = (status: ApiFailure["status"], code: string, message: string) =>
  Effect.fail(new ApiFailure({ status, code, message }));

const json =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (body: A, status = 200) =>
    HttpServerResponse.schemaJson(schema)(body, { status });

const errorJson = (status: number, code: string, error: string) =>
  HttpServerResponse.unsafeJson({ code, error } satisfies Api.ApiError, { status });

const RunId = Schema.Struct({ id: Schema.UUID });
const ProviderParam = Schema.Struct({ provider: Schema.String });

export const toApiRun = (r: RunRow): Api.ApiRun => ({
  id: r.id,
  repo: r.repo_full_name,
  baseBranch: r.base_branch,
  task: r.task,
  status: r.status,
  branch: r.branch,
  pullRequestUrl: r.pull_request_url,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  awaitingInput: r.awaiting_input,
  sandboxState: r.sandbox_state,
  lastActivityAt: r.last_activity_at,
});

const toApiEvent = (e: RunEventRow): Api.ApiRunEvent => ({
  id: String(e.id),
  at: e.at,
  kind: e.kind,
  message: e.message,
  data: e.data,
});

/** Events per page; a run page asks for the next page while `hasMore` is true. */
const EVENTS_PAGE = 1000;
/** Longest message a user can send to a running agent. */
const MAX_MESSAGE_CHARS = 20_000;

const eventsPage = (runId: string, after = 0) =>
  Effect.map(Effect.flatMap(Store, (store) => store.listEvents(runId, after, EVENTS_PAGE)), (rows) => ({
    events: rows.map(toApiEvent),
    hasMore: rows.length === EVENTS_PAGE,
  }));

const accessibleRepos = (user: UserRow) =>
  Effect.gen(function* () {
    const github = yield* GitHubUserApi;
    const token = yield* userAccessToken(user);
    const installations = yield* github.installations(token);
    const perInstallation = yield* Effect.forEach(
      installations,
      (inst) =>
        Effect.map(github.installationRepos(token, inst.id), (repos) =>
          repos.map(
            (repo): Api.ApiRepo => ({
              installationId: inst.id,
              fullName: repo.full_name,
              defaultBranch: repo.default_branch,
              private: repo.private,
              htmlUrl: repo.html_url,
            }),
          ),
        ),
      { concurrency: 4 },
    );
    return perInstallation.flat().sort((a, b) => a.fullName.localeCompare(b.fullName));
  });

const installUrl = Effect.map(GitHubUserApi, (gh) => `https://github.com/apps/${gh.appSlug}/installations/new`);

const keySlots = (user: UserRow) =>
  Effect.gen(function* () {
    const saved = new Map((yield* (yield* Store).listApiKeys(user.id)).map((k) => [k.provider, k]));
    return (Object.keys(MODEL_PROVIDERS) as ModelProvider[]).map((provider): Api.ApiKeySlot => {
      const meta = MODEL_PROVIDERS[provider];
      const key = saved.get(provider);
      return {
        provider,
        label: meta.label,
        placeholder: meta.placeholder,
        consoleUrl: meta.consoleUrl,
        saved: key ? { hint: key.hint, updatedAt: key.updated_at } : null,
      };
    });
  });

/** A run owned by the signed-in user, or a 404. */
const ownedRun = Effect.gen(function* () {
  const user = yield* requireUser;
  const { id } = yield* HttpRouter.schemaPathParams(RunId);
  const run = yield* (yield* Store).getRun(id);
  return yield* Option.match(
    Option.filter(run, (r) => r.user_id === user.id),
    { onNone: () => fail(404, "not_found", "Run not found."), onSome: (run) => Effect.succeed({ user, run }) },
  );
});

const providerParam = Effect.flatMap(HttpRouter.schemaPathParams(ProviderParam), ({ provider }) =>
  isModelProvider(provider) ? Effect.succeed(provider) : fail(404, "not_found", "Unknown provider."),
);

export const router = HttpRouter.empty.pipe(
  HttpRouter.get(
    "/healthz",
    Effect.gen(function* () {
      yield* (yield* Store).listRuns("00000000-0000-0000-0000-000000000000", 1);
      return HttpServerResponse.text("ok");
    }),
  ),

  // ---- auth -------------------------------------------------------------------
  HttpRouter.get("/auth/login", beginLogin),
  HttpRouter.get("/auth/callback", completeLogin),
  HttpRouter.post("/auth/logout", logout),

  // ---- session ----------------------------------------------------------------
  HttpRouter.get(
    "/api/me",
    Effect.gen(function* () {
      const user = yield* requireUser;
      const keys = yield* (yield* Store).listApiKeys(user.id);
      return yield* json(Api.Me)({
        user: { login: user.github_login, name: user.name, avatarUrl: user.avatar_url },
        hasApiKey: keys.length > 0,
        installUrl: yield* installUrl,
      });
    }),
  ),

  // ---- repositories -------------------------------------------------------------
  HttpRouter.get(
    "/api/repos",
    Effect.flatMap(requireUser, accessibleRepos).pipe(Effect.flatMap((repos) => json(Schema.Array(Api.ApiRepo))(repos))),
  ),

  HttpRouter.post(
    "/api/repos",
    Effect.gen(function* () {
      const user = yield* requireUser;
      const body = yield* HttpServerRequest.schemaBodyJson(Api.CreateRepoBody);
      const name = body.name.trim();
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
        return yield* fail(400, "bad_request", "Use letters, digits, '.', '_' or '-' for the name.");
      }
      const token = yield* userAccessToken(user);
      const created = yield* (yield* GitHubUserApi)
        .createRepo(token, { name, description: body.description?.trim() || undefined, private: body.private })
        .pipe(Effect.either);
      if (created._tag === "Left") {
        if (created.left.status >= 500 || created.left.status === 0) return yield* created.left;
        return yield* fail(400, "github", created.left.message);
      }
      const repo = created.right;
      return yield* json(Api.ApiRepo)(
        {
          // Not tied to an installation yet: the app only sees it once it is granted access.
          installationId: 0,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch,
          private: repo.private,
          htmlUrl: repo.html_url,
        },
        201,
      );
    }),
  ),

  // ---- bring your own key -------------------------------------------------------
  HttpRouter.get(
    "/api/settings/keys",
    Effect.flatMap(requireUser, keySlots).pipe(Effect.flatMap((slots) => json(Schema.Array(Api.ApiKeySlot))(slots))),
  ),

  HttpRouter.put(
    "/api/settings/keys/:provider",
    Effect.gen(function* () {
      const user = yield* requireUser;
      const provider = yield* providerParam;
      const key = (yield* HttpServerRequest.schemaBodyJson(Api.SaveKeyBody)).key.trim();
      const error = validateApiKey(provider, key);
      if (error) return yield* fail(400, "bad_request", error);
      const cipher = yield* TokenCipher;
      yield* (yield* Store).upsertApiKey({ user_id: user.id, provider, key_enc: cipher.encrypt(key), hint: keyHint(key) });
      return yield* json(Schema.Array(Api.ApiKeySlot))(yield* keySlots(user));
    }),
  ),

  HttpRouter.del(
    "/api/settings/keys/:provider",
    Effect.gen(function* () {
      const user = yield* requireUser;
      const provider = yield* providerParam;
      yield* (yield* Store).deleteApiKey(user.id, provider);
      return yield* json(Schema.Array(Api.ApiKeySlot))(yield* keySlots(user));
    }),
  ),

  // ---- runs ---------------------------------------------------------------------
  HttpRouter.get(
    "/api/runs",
    Effect.gen(function* () {
      const user = yield* requireUser;
      const runs = yield* (yield* Store).listRuns(user.id, 100);
      return yield* json(Schema.Array(Api.ApiRun))(runs.map(toApiRun));
    }),
  ),

  HttpRouter.post(
    "/api/runs",
    Effect.gen(function* () {
      const user = yield* requireUser;
      const store = yield* Store;
      const body = yield* HttpServerRequest.schemaBodyJson(Api.CreateRunBody);
      const task = body.task.trim();
      if (!body.repo || !task) return yield* fail(400, "bad_request", "Pick a repository and describe the task.");
      if ((yield* store.listApiKeys(user.id)).length === 0) {
        return yield* fail(400, "api_key_required", "Add your model API key in Settings before starting a run.");
      }

      // Never trust the client: the repo must be one this user can reach through that installation.
      const repo = (yield* accessibleRepos(user)).find(
        (r) => r.installationId === body.installationId && r.fullName === body.repo,
      );
      if (!repo) return yield* fail(403, "forbidden", "You don't have access to that repository through the app.");

      const run = yield* store.enqueueRun({
        user_id: user.id,
        repo_full_name: repo.fullName,
        installation_id: repo.installationId,
        base_branch: body.baseBranch?.trim() || repo.defaultBranch,
        task,
      });
      return yield* json(Api.ApiRun)(toApiRun(run), 201);
    }),
  ),

  HttpRouter.get(
    "/api/runs/:id",
    Effect.gen(function* () {
      const { run } = yield* ownedRun;
      const page = yield* eventsPage(run.id);
      const diff = yield* (yield* Store).getDiff(run.id);
      return yield* json(Api.RunDetail)({
        run: toApiRun(run),
        ...page,
        diff: Option.getOrNull(Option.map(diff, (d) => ({ patch: d.patch, truncated: d.truncated, updatedAt: d.updated_at }))),
      });
    }),
  ),

  HttpRouter.get(
    "/api/runs/:id/diff",
    Effect.gen(function* () {
      const { run } = yield* ownedRun;
      const diff = yield* (yield* Store).getDiff(run.id);
      if (Option.isNone(diff)) return yield* fail(404, "not_found", "This run has not changed any files yet.");
      const { patch, truncated, updated_at } = diff.value;
      return yield* json(Api.ApiRunDiff)({ patch, truncated, updatedAt: updated_at });
    }),
  ),

  HttpRouter.post(
    "/api/runs/:id/messages",
    Effect.gen(function* () {
      const { user, run } = yield* ownedRun;
      const store = yield* Store;
      const text = (yield* HttpServerRequest.schemaBodyJson(Api.SendMessageBody)).text.trim();
      if (!text) return yield* fail(400, "bad_request", "Write a message first.");
      if (text.length > MAX_MESSAGE_CHARS) return yield* fail(400, "bad_request", "That message is too long.");
      if (run.status === "cancelling") {
        return yield* fail(400, "bad_request", "The agent is stopping. Send your message once it has stopped.");
      }
      if (run.status === "queued" || run.status === "running") {
        // The runner hands the message to the agent; an answer clears the open question.
        yield* store.addUserMessage(run.id, text);
      } else {
        // A finished run: the message starts the next turn, in the same sandbox when it is still there.
        if ((yield* store.listApiKeys(user.id)).length === 0) {
          return yield* fail(400, "api_key_required", "Add your model API key in Settings before continuing a run.");
        }
        yield* store.continueRun(run.id, text);
      }
      const updated = Option.getOrElse(yield* store.getRun(run.id), () => run);
      return yield* json(Api.ApiRun)(toApiRun(updated), 201);
    }),
  ),

  HttpRouter.post(
    "/api/runs/:id/cancel",
    Effect.gen(function* () {
      const { user, run } = yield* ownedRun;
      const store = yield* Store;
      yield* store.requestCancel(run.id, user.id);
      const updated = Option.getOrElse(yield* store.getRun(run.id), () => run);
      return yield* json(Api.ApiRun)(toApiRun(updated));
    }),
  ),

  HttpRouter.get(
    "/api/runs/:id/events",
    Effect.gen(function* () {
      const { run } = yield* ownedRun;
      const { after } = yield* HttpServerRequest.schemaSearchParams(
        Schema.Struct({ after: Schema.optionalWith(Schema.NumberFromString, { default: () => 0 }) }),
      );
      const page = yield* eventsPage(run.id, after);
      const diffUpdatedAt = yield* (yield* Store).diffUpdatedAt(run.id);
      return yield* json(Api.RunEventsPage)({ run: toApiRun(run), ...page, diffUpdatedAt: Option.getOrNull(diffUpdatedAt) });
    }),
  ),
);

/** Where the web app shows sign-in, with an optional error message. */
const loginPage = (error?: string) =>
  HttpServerResponse.redirect(error ? `/login?error=${encodeURIComponent(error)}` : "/login", { status: 302 });

/**
 * Turns the app's typed failures into answers: JSON errors for the API, and
 * redirects back to the web app's sign-in page for the browser-facing auth routes.
 */
export const app = router.pipe(
  Effect.catchTags({
    ApiFailure: (e) => Effect.succeed(errorJson(e.status, e.code, e.message)),
    Unauthorized: () => Effect.succeed(errorJson(401, "unauthorized", "Sign in to continue.")),
    ReauthRequired: () => Effect.succeed(errorJson(401, "reauth", "Your GitHub sign-in expired. Sign in again.")),
    LoginRejected: (e) => Effect.succeed(loginPage(e.message)),
    RouteNotFound: () => Effect.succeed(errorJson(404, "not_found", "Not found.")),
    ParseError: () => Effect.succeed(errorJson(400, "bad_request", "Bad request.")),
    RequestError: () => Effect.succeed(errorJson(400, "bad_request", "Bad request.")),
  }),
  Effect.catchAll((err) =>
    Effect.gen(function* () {
      yield* Effect.logError("request failed", err);
      return err instanceof GitHubError
        ? errorJson(502, "github", err.message)
        : errorJson(500, "internal", "Something went wrong.");
    }),
  ),
);

/**
 * Rejects state-changing requests whose Origin is not ours. Together with
 * SameSite=Lax cookies and JSON bodies this is the CSRF defence.
 */
export const originCheck = HttpMiddleware.make((httpApp) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const { publicUrl } = yield* HarnessConfig;
      if (req.headers.origin !== new URL(publicUrl).origin) {
        return errorJson(403, "forbidden", "Cross-origin request rejected.");
      }
    }
    return yield* httpApp;
  }),
);
