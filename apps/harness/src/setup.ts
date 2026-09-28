import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Api, appManifest, GitHubUserApi, InstanceSettings, manifestFormUrl, randomToken, type UserRow } from "@factory/core";
import { Data, Effect, Option, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { cookieOptions, currentUser, namedLogins, requireUser } from "./auth.js";
import { HarnessConfig } from "./config.js";
import { fail } from "./errors.js";
import { RailwayApi } from "./railway.js";

/**
 * First-run setup, for a deployment made from the Railway template: no GitHub
 * App and no sandbox environment exist yet. The web app's /setup page walks
 * through creating both:
 *
 * 1. The GitHub App, from a manifest. Anyone can start this (nobody can sign
 *    in yet), so the App is only accepted if GitHub says it belongs to an
 *    account named in ALLOWED_GITHUB_LOGINS: someone else who finds a fresh
 *    deployment can't plant their own App in it.
 * 2. The `agents` environment and its project token, created through Railway's
 *    API with a token the admin pastes once. Only a signed-in admin can do it.
 *
 * A deployment configured with environment variables (docs/setup.md) skips both.
 */

export const SETUP_STATE_COOKIE = "factory_setup_state";

/** A failed step of the GitHub App registration, shown on the setup page. */
export class SetupRejected extends Data.TaggedError("SetupRejected")<{ readonly message: string }> {}

export const appInstallUrl = (slug: string) => `https://github.com/apps/${slug}/installations/new`;

/** Admins may finish setup: logins named in the allowlist, and whoever owns the App the setup page created. */
export const isAdmin = (allowed: ReadonlyArray<string>, appOwner: string | null, login: string): boolean => {
  const name = login.toLowerCase();
  return namedLogins(allowed).includes(name) || appOwner?.toLowerCase() === name;
};

const status = (viewer: Option.Option<UserRow>) =>
  Effect.gen(function* () {
    const config = yield* HarnessConfig;
    const app = yield* (yield* GitHubUserApi).app;
    const settings = yield* InstanceSettings;
    const oauth = yield* settings.githubOAuth;
    const owner = Option.getOrNull(Option.flatMap(app, (a) => Option.fromNullable(a.owner)));
    return {
      githubApp: Option.getOrNull(
        Option.map(app, (a) => ({
          slug: a.slug,
          fromEnv: Option.exists(oauth, (o) => o.source === "env"),
          owner: a.owner,
          installUrl: appInstallUrl(a.slug),
        })),
      ),
      sandboxes: yield* settings.sandboxesReady,
      owners: Option.isNone(app) ? [...namedLogins(config.allowedLogins)] : [],
      viewer: Option.getOrNull(
        Option.map(viewer, (u) => ({ login: u.github_login, admin: isAdmin(config.allowedLogins, owner, u.github_login) })),
      ),
    } satisfies Api.SetupStatus;
  });

const statusJson = (viewer: Option.Option<UserRow>) =>
  Effect.flatMap(status(viewer), (body) => HttpServerResponse.schemaJson(Api.SetupStatus)(body));

export const setupRoutes = HttpRouter.empty.pipe(
  HttpRouter.get("/api/setup", Effect.flatMap(currentUser, statusJson)),

  // Step 1: the form the browser posts to GitHub. GitHub sends the person back to the callback below.
  HttpRouter.post(
    "/api/setup/github-app",
    Effect.gen(function* () {
      const config = yield* HarnessConfig;
      if (Option.isSome(yield* (yield* GitHubUserApi).app)) {
        return yield* fail(409, "conflict", "The GitHub App is already set up.");
      }
      const owners = namedLogins(config.allowedLogins);
      if (owners.length === 0) {
        return yield* fail(400, "bad_request", "Set ALLOWED_GITHUB_LOGINS to your GitHub username on the harness service first: the App must belong to an account named there.");
      }
      const body = yield* HttpServerRequest.schemaBodyJson(Api.CreateGitHubAppBody);
      const organization = body.organization?.trim() || undefined;
      if (organization && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(organization)) {
        return yield* fail(400, "bad_request", "That isn't a GitHub organization name.");
      }
      if (organization && !owners.includes(organization.toLowerCase())) {
        return yield* fail(400, "bad_request", `Add ${organization} to ALLOWED_GITHUB_LOGINS first: the App must belong to an account named there.`);
      }
      const state = randomToken(16);
      // GitHub App names are unique across GitHub, so each deployment's gets a suffix (it can be renamed later).
      const name = `Factory on Rails ${randomBytes(3).toString("hex")}`;
      const form: Api.GitHubAppForm = {
        action: manifestFormUrl(state, organization),
        manifest: JSON.stringify(appManifest(config.publicUrl, name)),
      };
      return yield* HttpServerResponse.schemaJson(Api.GitHubAppForm)(form).pipe(
        Effect.flatMap(HttpServerResponse.setCookie(SETUP_STATE_COOKIE, state, cookieOptions(config.publicUrl, 3600))),
      );
    }),
  ),

  HttpRouter.get(
    "/auth/setup/github-app",
    Effect.gen(function* () {
      const config = yield* HarnessConfig;
      const github = yield* GitHubUserApi;
      const req = yield* HttpServerRequest.HttpServerRequest;
      const { code, state } = yield* HttpServerRequest.schemaSearchParams(
        Schema.Struct({ code: Schema.optional(Schema.String), state: Schema.optional(Schema.String) }),
      );
      const expected = req.cookies[SETUP_STATE_COOKIE];
      if (!code || !state || !expected || state !== expected) {
        return yield* new SetupRejected({ message: "GitHub App setup failed: the setup state did not match. Start again." });
      }
      if (Option.isSome(yield* github.app)) {
        return yield* new SetupRejected({ message: "A GitHub App is already set up. Delete the one you just created in your GitHub settings." });
      }
      const app = yield* github.convertManifest(code).pipe(
        Effect.mapError((e) => new SetupRejected({ message: `GitHub did not hand over the new App: ${e.message}` })),
      );
      if (!namedLogins(config.allowedLogins).includes(app.owner.toLowerCase())) {
        return yield* new SetupRejected({
          message: `The App was created under ${app.owner}, which ALLOWED_GITHUB_LOGINS doesn't name, so it wasn't used. Delete it at ${app.htmlUrl} and create it from an allowed account.`,
        });
      }
      if (!(yield* (yield* InstanceSettings).saveGitHubApp(app))) {
        return yield* new SetupRejected({ message: `Another GitHub App was set up first. Delete ${app.htmlUrl} in your GitHub settings.` });
      }
      yield* Effect.logInfo(`GitHub App ${app.slug} created by the setup page, owned by ${app.owner}`);
      return yield* HttpServerResponse.redirect("/setup", { status: 302 }).pipe(
        HttpServerResponse.expireCookie(SETUP_STATE_COOKIE, { path: "/" }),
      );
    }),
  ),

  // Step 2: the sandbox environment, by a signed-in admin with a Railway token that is used once and dropped.
  HttpRouter.post(
    "/api/setup/sandboxes",
    Effect.gen(function* () {
      const config = yield* HarnessConfig;
      const user = yield* requireUser;
      const app = yield* (yield* GitHubUserApi).app;
      const owner = Option.getOrNull(Option.flatMap(app, (a) => Option.fromNullable(a.owner)));
      if (!isAdmin(config.allowedLogins, owner, user.github_login)) {
        return yield* fail(403, "forbidden", "Only an account named in ALLOWED_GITHUB_LOGINS, or the GitHub App's owner, can finish setup.");
      }
      const settings = yield* InstanceSettings;
      if ((yield* settings.sandboxesReady).fromEnv) {
        return yield* fail(409, "conflict", "Sandboxes are configured with environment variables.");
      }
      if (Option.isNone(config.railwayProjectId)) {
        return yield* fail(400, "bad_request", "RAILWAY_PROJECT_ID is not set: sandbox setup only works when the factory runs on Railway.");
      }
      const token = (yield* HttpServerRequest.schemaBodyJson(Api.SetupSandboxesBody)).token.trim();
      if (!token) return yield* fail(400, "bad_request", "Paste a Railway token first.");
      const provisioned = yield* (yield* RailwayApi).provisionSandboxes(token, config.railwayProjectId.value);
      yield* settings.saveSandboxes(provisioned);
      yield* Effect.logInfo(`Sandboxes set up in environment ${provisioned.environmentName} by ${user.github_login}`);
      return yield* statusJson(Option.some(user));
    }),
  ),
);
