/**
 * Railway Infrastructure as Code for Factory on Rails: the web app (public),
 * the harness (private API and auth), the runner (worker) and Postgres.
 *
 *   railway config plan    # preview against the linked environment
 *   railway config apply   # apply after review (CI does this on merge)
 *
 * Secrets are not in this file. They live as shared variables on the
 * environment (Project Settings -> Shared Variables) and are referenced with
 * `ctx.shared.NAME`; see docs/setup.md for the list.
 *
 * Sandboxes are not declared here: they are created on demand by the runner
 * through the Railway SDK, in a separate environment (SANDBOX_ENVIRONMENT_ID).
 */
import { defineRailway, github, group, postgres, project, service } from "railway/iac";

const REPO = "shixzie/factory-on-rails";

export default defineRailway((ctx) => {
  const source = github(REPO, { branch: "main" });

  const db = postgres("postgres");

  // The web app (apps/web, Next.js) is the public face, served on a custom
  // domain in production (DNS via Cloudflare, SSL mode Full strict). Other
  // environments use its generated Railway domain. It forwards /api/* and
  // /auth/* to the harness over the private network, so the browser only ever
  // talks to one origin: PUBLIC_URL below is the web app's URL for both.
  // Change the domain, its port or PUBLIC_URL here rather than in the
  // dashboard: a dashboard edit invalidates any open PR's pinned plan.
  const production = ctx.isEnvironment("production");
  const publicUrl = production ? "https://factory.shixzie.com" : "https://${{web.RAILWAY_PUBLIC_DOMAIN}}";

  // API and auth backend for the web app. No public domain: only reachable
  // on the private network (listening on :: so the private DNS name resolves).
  const harness = service("harness", {
    source,
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm run build",
      watchPatterns: ["apps/harness/**", "packages/core/**", "pnpm-lock.yaml"],
    },
    start: "node apps/harness/dist/index.js",
    preDeploy: "node packages/core/dist/db.js",
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    env: {
      PORT: "8080",
      HOST: "::",
      // The origin users see (the web app): OAuth redirects, cookies and the Origin check use it.
      PUBLIC_URL: publicUrl,
      DATABASE_URL: db.env.DATABASE_URL,
      GITHUB_APP_SLUG: ctx.shared.GITHUB_APP_SLUG,
      GITHUB_APP_CLIENT_ID: ctx.shared.GITHUB_APP_CLIENT_ID,
      GITHUB_APP_CLIENT_SECRET: ctx.shared.GITHUB_APP_CLIENT_SECRET,
      TOKEN_ENCRYPTION_KEY: ctx.shared.TOKEN_ENCRYPTION_KEY,
      // Any GitHub account can sign in (each user brings their own model key).
      // Set a comma-separated list of logins instead to restrict it.
      ALLOWED_GITHUB_LOGINS: "*",
    },
  });

  const web = service("web", {
    source,
    build: {
      builder: "RAILPACK",
      // Builds packages/core first: the web app imports its API schemas.
      buildCommand: "pnpm run build && pnpm --filter @factory/web build",
      watchPatterns: ["apps/web/**", "packages/core/**", "pnpm-lock.yaml"],
    },
    start: "cd apps/web && node node_modules/next/dist/bin/next start --hostname 0.0.0.0",
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    // Pin the port so the custom domain's target port always matches.
    domains: production ? [{ domain: "factory.shixzie.com", port: 8080 }] : [],
    env: {
      PORT: "8080",
      NEXT_TELEMETRY_DISABLED: "1",
      // Railway resolves ${{service.VAR}} inside literal values at deploy time.
      HARNESS_INTERNAL_URL: "http://${{harness.RAILWAY_PRIVATE_DOMAIN}}:8080",
    },
  });

  const runner = service("runner", {
    source,
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm run build",
      watchPatterns: ["apps/runner/**", "packages/core/**", "pnpm-lock.yaml"],
    },
    start: "node apps/runner/dist/index.js",
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      // Railway resolves ${{service.VAR}} inside literal values at deploy time.
      // Links PRs back to their run page on the web app.
      HARNESS_URL: publicUrl,
      GITHUB_APP_ID: ctx.shared.GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY: ctx.shared.GITHUB_APP_PRIVATE_KEY,
      // Decrypts each user's own model API key (bring your own key).
      TOKEN_ENCRYPTION_KEY: ctx.shared.TOKEN_ENCRYPTION_KEY,
      RAILWAY_SANDBOX_TOKEN: ctx.shared.RAILWAY_SANDBOX_TOKEN,
      SANDBOX_ENVIRONMENT_ID: ctx.shared.SANDBOX_ENVIRONMENT_ID,
      MAX_CONCURRENT_RUNS: ctx.isEnvironment("production") ? "5" : "1",
    },
  });

  return project("factory-on-rails", {
    resources: [group("Factory", [web, harness, runner]), group("Data", [db])],
  });
});
