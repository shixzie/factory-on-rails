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

  // The harness is served on a custom domain in production (DNS via Cloudflare,
  // SSL mode Full). Other environments use their generated Railway domain.
  // Change the domain, its port or PUBLIC_URL here rather than in the
  // dashboard: a dashboard edit invalidates any open PR's pinned plan.
  const production = ctx.isEnvironment("production");
  const harnessUrl = production ? "https://factory.shixzie.com" : "https://${{harness.RAILWAY_PUBLIC_DOMAIN}}";

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
    // Pin the port so the custom domain's target port always matches.
    domains: production ? [{ domain: "factory.shixzie.com", port: 8080 }] : [],
    env: {
      PORT: "8080",
      PUBLIC_URL: harnessUrl,
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
      HARNESS_URL: harnessUrl,
      GITHUB_APP_ID: ctx.shared.GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY: ctx.shared.GITHUB_APP_PRIVATE_KEY,
      // Decrypts each user's own model API key (bring your own key).
      TOKEN_ENCRYPTION_KEY: ctx.shared.TOKEN_ENCRYPTION_KEY,
      RAILWAY_SANDBOX_TOKEN: ctx.shared.RAILWAY_SANDBOX_TOKEN,
      SANDBOX_ENVIRONMENT_ID: ctx.shared.SANDBOX_ENVIRONMENT_ID,
      // Without a region Railway puts sandboxes in us-west2; keep them next to the factory.
      SANDBOX_REGION: "us-east4-eqdc4a",
      MAX_CONCURRENT_RUNS: ctx.isEnvironment("production") ? "5" : "1",
    },
  });

  return project("factory-on-rails", {
    resources: [group("Factory", [harness, runner]), group("Data", [db])],
  });
});
