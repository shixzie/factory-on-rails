/**
 * Railway Infrastructure as Code for Factory on Rails.
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

  const harness = service("harness", {
    source,
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm run build",
      watchPatterns: ["apps/harness/**", "packages/core/**", "pnpm-lock.yaml"],
    },
    start: "node apps/harness/dist/index.js",
    preDeploy: "node packages/core/dist/migrate.js",
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      GITHUB_APP_ID: ctx.shared.GITHUB_APP_ID,
      GITHUB_APP_SLUG: ctx.shared.GITHUB_APP_SLUG,
      GITHUB_APP_CLIENT_ID: ctx.shared.GITHUB_APP_CLIENT_ID,
      GITHUB_APP_CLIENT_SECRET: ctx.shared.GITHUB_APP_CLIENT_SECRET,
      GITHUB_APP_PRIVATE_KEY: ctx.shared.GITHUB_APP_PRIVATE_KEY,
      TOKEN_ENCRYPTION_KEY: ctx.shared.TOKEN_ENCRYPTION_KEY,
      ALLOWED_GITHUB_LOGINS: ctx.shared.ALLOWED_GITHUB_LOGINS,
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
      HARNESS_URL: "https://${{harness.RAILWAY_PUBLIC_DOMAIN}}",
      GITHUB_APP_ID: ctx.shared.GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY: ctx.shared.GITHUB_APP_PRIVATE_KEY,
      RAILWAY_SANDBOX_TOKEN: ctx.shared.RAILWAY_SANDBOX_TOKEN,
      SANDBOX_ENVIRONMENT_ID: ctx.shared.SANDBOX_ENVIRONMENT_ID,
      ANTHROPIC_API_KEY: ctx.shared.ANTHROPIC_API_KEY,
      MAX_CONCURRENT_RUNS: ctx.isEnvironment("production") ? "5" : "1",
    },
  });

  return project("factory-on-rails", {
    resources: [group("Factory", [harness, runner]), group("Data", [db])],
  });
});
