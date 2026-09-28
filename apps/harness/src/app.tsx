import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import {
  GitHubError,
  GitHubUserApi,
  isModelProvider,
  keyHint,
  Store,
  TokenCipher,
  validateApiKey,
  type UserRow,
} from "@factory/core";
import { Effect, Option, Schema } from "effect";
import type { Child } from "hono/jsx";
import {
  beginLogin,
  completeLogin,
  logout,
  requireUser,
  currentUser,
  userAccessToken,
} from "./auth.js";
import { HarnessConfig } from "./config.js";
import { Dashboard, LoginPage, MessagePage, NewRepoPage, RunPage, SettingsPage, type RepoOption } from "./views.js";

type Status = 200 | 400 | 403 | 404 | 500;

/** Renders a hono/jsx tree to a full HTML document (hono/jsx is used only as a template engine). */
export const render = (node: Child, status: Status = 200) =>
  Effect.promise(async () => `<!doctype html>${String(await node)}`).pipe(
    Effect.map((body) => HttpServerResponse.text(body, { status, contentType: "text/html; charset=utf-8" })),
  );

const redirect = (location: string) => HttpServerResponse.redirect(location, { status: 302 });

const RunId = Schema.Struct({ id: Schema.UUID });
const ProviderParam = Schema.Struct({ provider: Schema.String });

const accessibleRepos = (user: UserRow) =>
  Effect.gen(function* () {
    const github = yield* GitHubUserApi;
    const token = yield* userAccessToken(user);
    const installations = yield* github.installations(token);
    const perInstallation = yield* Effect.forEach(
      installations,
      (inst) =>
        Effect.map(github.installationRepos(token, inst.id), (repos) =>
          repos.map((repo): RepoOption => ({ installationId: inst.id, repo })),
        ),
      { concurrency: 4 },
    );
    return perInstallation.flat().sort((a, b) => a.repo.full_name.localeCompare(b.repo.full_name));
  });

const installUrl = Effect.map(GitHubUserApi, (gh) => `https://github.com/apps/${gh.appSlug}/installations/new`);

const settingsPage = (user: UserRow, extra: { error?: string; notice?: string } = {}, status: Status = 200) =>
  Effect.flatMap(Store, (store) => store.listApiKeys(user.id)).pipe(
    Effect.flatMap((keys) => render(<SettingsPage user={user} keys={keys} {...extra} />, status)),
  );

/** A run owned by the signed-in user, or a 404. */
const ownedRun = Effect.gen(function* () {
  const user = yield* requireUser;
  const { id } = yield* HttpRouter.schemaPathParams(RunId);
  const run = yield* (yield* Store).getRun(id);
  return Option.filter(run, (r) => r.user_id === user.id).pipe(Option.map((run) => ({ user, run })));
});

const notFound = HttpServerResponse.text("Not found", { status: 404 });

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

  // ---- pages ------------------------------------------------------------------
  HttpRouter.get(
    "/",
    Effect.gen(function* () {
      const user = yield* currentUser;
      if (Option.isNone(user)) return yield* render(<LoginPage />);
      const store = yield* Store;
      const [repos, runs, keys] = yield* Effect.all(
        [accessibleRepos(user.value), store.listRuns(user.value.id), store.listApiKeys(user.value.id)],
        { concurrency: "unbounded" },
      );
      return yield* render(
        <Dashboard user={user.value} repos={repos} runs={runs} installUrl={yield* installUrl} hasApiKey={keys.length > 0} />,
      );
    }),
  ),

  HttpRouter.get("/repos/new", Effect.flatMap(requireUser, (user) => render(<NewRepoPage user={user} />))),

  HttpRouter.post(
    "/repos",
    Effect.gen(function* () {
      const user = yield* requireUser;
      const form = yield* HttpServerRequest.schemaBodyUrlParams(
        Schema.Struct({
          name: Schema.String,
          description: Schema.optional(Schema.String),
          private: Schema.optional(Schema.String),
        }),
      );
      const name = form.name.trim();
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
        return yield* render(<NewRepoPage user={user} error="Use letters, digits, '.', '_' or '-' for the name." />, 400);
      }
      const token = yield* userAccessToken(user);
      const created = yield* (yield* GitHubUserApi)
        .createRepo(token, { name, description: form.description?.trim() || undefined, private: form.private === "1" })
        .pipe(Effect.either);
      if (created._tag === "Left") {
        if (created.left.status >= 500 || created.left.status === 0) return yield* created.left;
        return yield* render(<NewRepoPage user={user} error={created.left.message} />, 400);
      }
      const repo = created.right;
      return yield* render(
        <MessagePage title="Repository created" user={user}>
          <p>
            Created <a href={repo.html_url}>{repo.full_name}</a>. If it doesn't show up in the run form, make sure the
            app can access it: <a href={yield* installUrl}>manage the installation</a>.
          </p>
          <a class="button" href="/">Back to dashboard</a>
        </MessagePage>,
      );
    }),
  ),

  // ---- bring your own key -------------------------------------------------------
  HttpRouter.get("/settings", Effect.flatMap(requireUser, (user) => settingsPage(user))),

  HttpRouter.post(
    "/settings/keys/:provider",
    Effect.gen(function* () {
      const user = yield* requireUser;
      const { provider } = yield* HttpRouter.schemaPathParams(ProviderParam);
      if (!isModelProvider(provider)) return notFound;
      const { key: raw } = yield* HttpServerRequest.schemaBodyUrlParams(Schema.Struct({ key: Schema.String }));
      const key = raw.trim();
      const error = validateApiKey(provider, key);
      if (error) return yield* settingsPage(user, { error }, 400);
      const cipher = yield* TokenCipher;
      yield* (yield* Store).upsertApiKey({ user_id: user.id, provider, key_enc: cipher.encrypt(key), hint: keyHint(key) });
      return yield* settingsPage(user, { notice: "Key saved." });
    }),
  ),

  HttpRouter.post(
    "/settings/keys/:provider/delete",
    Effect.gen(function* () {
      const user = yield* requireUser;
      const { provider } = yield* HttpRouter.schemaPathParams(ProviderParam);
      if (!isModelProvider(provider)) return notFound;
      yield* (yield* Store).deleteApiKey(user.id, provider);
      return yield* settingsPage(user, { notice: "Key removed." });
    }),
  ),

  // ---- runs ---------------------------------------------------------------------
  HttpRouter.post(
    "/runs",
    Effect.gen(function* () {
      const user = yield* requireUser;
      const store = yield* Store;
      const form = yield* HttpServerRequest.schemaBodyUrlParams(
        Schema.Struct({ repo: Schema.String, task: Schema.String, base_branch: Schema.optional(Schema.String) }),
      );
      const [installation, fullName] = form.repo.split(/:(.*)/s);
      const task = form.task.trim();
      if (!installation || !fullName || !task) return HttpServerResponse.text("repo and task are required", { status: 400 });
      if ((yield* store.listApiKeys(user.id)).length === 0) return redirect("/settings");

      // Never trust the form: the repo must be one this user can reach through that installation.
      const installationId = Number(installation);
      const repo = (yield* accessibleRepos(user)).find(
        (r) => r.installationId === installationId && r.repo.full_name === fullName,
      );
      if (!repo) return HttpServerResponse.text("You don't have access to that repository through the app", { status: 403 });

      const run = yield* store.enqueueRun({
        user_id: user.id,
        repo_full_name: repo.repo.full_name,
        installation_id: installationId,
        base_branch: form.base_branch?.trim() || repo.repo.default_branch,
        task,
      });
      return redirect(`/runs/${run.id}`);
    }),
  ),

  HttpRouter.get(
    "/runs/:id",
    Effect.gen(function* () {
      const found = yield* ownedRun;
      if (Option.isNone(found)) return notFound;
      const { user, run } = found.value;
      const events = yield* (yield* Store).listEvents(run.id);
      return yield* render(<RunPage user={user} run={run} events={events} />);
    }),
  ),

  HttpRouter.post(
    "/runs/:id/cancel",
    Effect.gen(function* () {
      const found = yield* ownedRun;
      if (Option.isNone(found)) return notFound;
      yield* (yield* Store).requestCancel(found.value.run.id, found.value.user.id);
      return redirect(`/runs/${found.value.run.id}`);
    }),
  ),

  HttpRouter.get(
    "/api/runs/:id/events",
    Effect.gen(function* () {
      const found = yield* ownedRun;
      if (Option.isNone(found)) return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 });
      const { run } = found.value;
      const { after } = yield* HttpServerRequest.schemaSearchParams(
        Schema.Struct({ after: Schema.optionalWith(Schema.NumberFromString, { default: () => 0 }) }),
      );
      const events = yield* (yield* Store).listEvents(run.id, after);
      return yield* HttpServerResponse.json({
        run: { status: run.status, pull_request_url: run.pull_request_url, error: run.error },
        events,
      });
    }),
  ),
);

/**
 * Turns the app's typed failures into pages: sign-in redirects, 400s for bad
 * input, 404s, and a generic error page for anything else.
 */
export const app = router.pipe(
  Effect.catchTags({
    Unauthorized: () => Effect.succeed(redirect("/")),
    ReauthRequired: () => Effect.succeed(redirect("/auth/login")),
    LoginRejected: (e) => render(<LoginPage error={e.message} />, e.status),
    RouteNotFound: () => Effect.succeed(notFound),
    ParseError: () => Effect.succeed(HttpServerResponse.text("Bad request", { status: 400 })),
  }),
  Effect.catchAll((err) =>
    Effect.gen(function* () {
      yield* Effect.logError("request failed", err);
      const detail = err instanceof GitHubError ? err.message : "Something went wrong.";
      const user = yield* Effect.orElseSucceed(currentUser, () => Option.none<UserRow>());
      return yield* render(
        <MessagePage title="Error" user={Option.getOrNull(user)}>
          <p>{detail}</p>
        </MessagePage>,
        500,
      );
    }),
  ),
);

/**
 * Rejects state-changing requests whose Origin is not ours. Together with
 * SameSite=Lax cookies this is the CSRF defence for the HTML forms.
 */
export const originCheck = HttpMiddleware.make((httpApp) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const { publicUrl } = yield* HarnessConfig;
      if (req.headers.origin !== new URL(publicUrl).origin) {
        return HttpServerResponse.text("Cross-origin request rejected", { status: 403 });
      }
    }
    return yield* httpApp;
  }),
);
