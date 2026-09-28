import {
  enqueueRun,
  getRun,
  GitHubError,
  listEvents,
  listRuns,
  requestCancel,
  UserGitHub,
  type Sql,
  type UserRow,
} from "@factory/core";
import { Hono, type Context } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import {
  beginLogin,
  completeLogin,
  logout,
  originCheck,
  ReauthRequired,
  sessionMiddleware,
  userAccessToken,
  type Env,
} from "./auth.js";
import type { HarnessConfig } from "./config.js";
import { Dashboard, LoginPage, MessagePage, NewRepoPage, RunPage, type RepoOption } from "./views.js";

/** Renders a full HTML document (Hono JSX does not emit a doctype on its own). */
const render = (c: Context, node: Child, status: 200 | 400 | 403 | 500 = 200) =>
  c.html(<>{raw("<!doctype html>")}{node}</>, status);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp(sql: Sql, config: HarnessConfig) {
  const app = new Hono<Env>();
  const installUrl = `https://github.com/apps/${config.github.appSlug}/installations/new`;

  app.get("/healthz", async (c) => {
    await sql`select 1`;
    return c.text("ok");
  });

  app.use("*", originCheck(config));
  app.use("*", sessionMiddleware(sql));

  app.onError((err, c) => {
    if (err instanceof ReauthRequired) return c.redirect("/auth/login");
    console.error(err);
    const detail = err instanceof GitHubError ? err.message : "Something went wrong.";
    return render(c, <MessagePage title="Error" user={c.get("user")}><p>{detail}</p></MessagePage>, 500);
  });

  // ---- auth -----------------------------------------------------------------

  app.get("/auth/login", (c) => beginLogin(c, config));

  app.get("/auth/callback", async (c) => {
    const result = await completeLogin(c, sql, config);
    if (!result.ok) return render(c, <LoginPage error={result.message} />, result.status);
    return c.redirect("/");
  });

  app.post("/auth/logout", async (c) => {
    await logout(c, sql);
    return c.redirect("/");
  });

  // Everything below needs a signed-in user.
  const requireUser = (c: Context<Env>): UserRow | Response => c.get("user") ?? c.redirect("/");
  const github = async (user: UserRow) => new UserGitHub(await userAccessToken(sql, config, user));

  async function accessibleRepos(user: UserRow): Promise<RepoOption[]> {
    const gh = await github(user);
    const installations = await gh.installations();
    const perInstallation = await Promise.all(
      installations.map(async (inst) =>
        (await gh.installationRepos(inst.id)).map((repo) => ({ installationId: inst.id, repo })),
      ),
    );
    return perInstallation.flat().sort((a, b) => a.repo.full_name.localeCompare(b.repo.full_name));
  }

  // ---- pages ----------------------------------------------------------------

  app.get("/", async (c) => {
    const user = c.get("user");
    if (!user) return render(c, <LoginPage />);
    const [repos, runs] = await Promise.all([accessibleRepos(user), listRuns(sql, user.id)]);
    return render(c, <Dashboard user={user} repos={repos} runs={runs} installUrl={installUrl} />);
  });

  app.get("/repos/new", (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    return render(c, <NewRepoPage user={user} />);
  });

  app.post("/repos", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const form = await c.req.parseBody();
    const name = String(form.name ?? "").trim();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
      return render(c, <NewRepoPage user={user} error="Use letters, digits, '.', '_' or '-' for the name." />, 400);
    }
    try {
      const repo = await (await github(user)).createRepo({
        name,
        description: String(form.description ?? "").trim() || undefined,
        private: form.private === "1",
      });
      return render(
        c,
        <MessagePage title="Repository created" user={user}>
          <p>
            Created <a href={repo.html_url}>{repo.full_name}</a>. If it doesn't show up in the run form, make sure the
            app can access it: <a href={installUrl}>manage the installation</a>.
          </p>
          <a class="button" href="/">Back to dashboard</a>
        </MessagePage>,
      );
    } catch (err) {
      if (err instanceof GitHubError && err.status < 500) {
        return render(c, <NewRepoPage user={user} error={err.message} />, 400);
      }
      throw err;
    }
  });

  app.post("/runs", async (c) => {
    const user = requireUser(c);
    if (user instanceof Response) return user;
    const form = await c.req.parseBody();
    const [installation, fullName] = String(form.repo ?? "").split(/:(.*)/s);
    const task = String(form.task ?? "").trim();
    if (!installation || !fullName || !task) return c.text("repo and task are required", 400);

    // Never trust the form: the repo must be one this user can reach through that installation.
    const installationId = Number(installation);
    const repo = (await accessibleRepos(user)).find(
      (r) => r.installationId === installationId && r.repo.full_name === fullName,
    );
    if (!repo) return c.text("You don't have access to that repository through the app", 403);

    const run = await enqueueRun(sql, {
      user_id: user.id,
      repo_full_name: repo.repo.full_name,
      installation_id: installationId,
      base_branch: String(form.base_branch ?? "").trim() || repo.repo.default_branch,
      task,
    });
    return c.redirect(`/runs/${run.id}`);
  });

  async function ownedRun(c: Context<Env>) {
    const user = c.get("user");
    const id = c.req.param("id") ?? "";
    if (!user || !UUID.test(id)) return undefined;
    const run = await getRun(sql, id);
    return run && run.user_id === user.id ? { user, run } : undefined;
  }

  app.get("/runs/:id", async (c) => {
    const found = await ownedRun(c);
    if (!found) return c.notFound();
    const events = await listEvents(sql, found.run.id);
    return render(c, <RunPage user={found.user} run={found.run} events={events} />);
  });

  app.post("/runs/:id/cancel", async (c) => {
    const found = await ownedRun(c);
    if (!found) return c.notFound();
    await requestCancel(sql, found.run.id, found.user.id);
    return c.redirect(`/runs/${found.run.id}`);
  });

  app.get("/api/runs/:id/events", async (c) => {
    const found = await ownedRun(c);
    if (!found) return c.json({ error: "not found" }, 404);
    const after = Number.parseInt(c.req.query("after") ?? "0", 10) || 0;
    const events = await listEvents(sql, found.run.id, after);
    return c.json({
      run: { status: found.run.status, pull_request_url: found.run.pull_request_url, error: found.run.error },
      events,
    });
  });

  return app;
}
