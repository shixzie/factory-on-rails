/**
 * Railway Infrastructure as Code for Factory on Rails: the web app (public),
 * the harness (private API and auth), the runner (worker), the preview
 * gateway (public, production only) and Postgres.
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

  // The web app (apps/web, Next.js) is the public face. It forwards /api/*
  // and /auth/* to the harness over the private network, so the browser only
  // ever talks to one origin: PUBLIC_URL below is the web app's URL for both.
  // Production serves it on factory.shixzie.com (DNS via Cloudflare, SSL mode
  // Full strict); other environments use its generated Railway domain.
  //
  // Railway IaC can manage a custom domain but not register one on a service:
  // add a new domain in the dashboard first, then declare it here. See
  // docs/setup.md, step 5.
  const production = ctx.isEnvironment("production");
  const publicUrl = production ? "https://factory.shixzie.com" : "https://${{web.RAILWAY_PUBLIC_DOMAIN}}";

  // Sandbox snapshots: prepared checkpoints in the agents environment that
  // users can start their runs from (docs/setup.md, step 7). Entries are
  // `name=login|login`, comma-separated, `*` for everyone. A snapshot holds
  // the sign-in of whoever prepared it, so list only them unless it holds none.
  const sandboxSnapshots = production ? "shixzie-agents=shixzie" : "";

  // Previews of servers running in sandboxes (packages/core/src/preview.ts):
  // each run's port gets its own origin, p<port>-<run>.preview.shixzie.com,
  // served by the preview gateway, which sandboxes dial out to at
  // tunnel.preview.shixzie.com. Needs the wildcard domain on the gateway and
  // the PREVIEW_SIGNING_KEY shared variable (docs/setup.md, step 8). Without
  // them the harness and runner simply leave previews off.
  const previewDomain = "preview.shixzie.com";
  const inProduction = <T extends object>(env: T): Partial<T> => (production ? env : {});
  const previewEnv = inProduction({ PREVIEW_SIGNING_KEY: ctx.shared.PREVIEW_SIGNING_KEY });

  // API and auth backend for the web app. No public domain: only reached on
  // the private network (listening on :: so the private DNS name resolves).
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
      ...previewEnv,
      ...inProduction({ PREVIEW_DOMAIN: previewDomain }),
      // Any GitHub account can sign in (each user brings their own model key).
      // Set a comma-separated list of logins instead to restrict it.
      ALLOWED_GITHUB_LOGINS: "*",
      SANDBOX_SNAPSHOTS: sandboxSnapshots,
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
      // Without a region Railway puts sandboxes in us-west2; keep them next to the factory.
      SANDBOX_REGION: "us-east4-eqdc4a",
      // Checked again when a run starts, in case a snapshot was taken away.
      SANDBOX_SNAPSHOTS: sandboxSnapshots,
      MAX_CONCURRENT_RUNS: ctx.isEnvironment("production") ? "5" : "1",
      ...previewEnv,
      ...inProduction({ PREVIEW_TUNNEL_URL: `wss://tunnel.${previewDomain}/connect` }),
    },
  });

  // The preview gateway (apps/preview). Public: browsers reach previews on
  // *.preview.shixzie.com and sandboxes (which have internet egress only)
  // connect to tunnel.preview.shixzie.com. Keep one replica: tunnels live in
  // its memory. The wildcard domain is added in the dashboard first, then
  // declared here (IaC can't register a custom domain).
  const preview = service("preview", {
    source,
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm run build",
      watchPatterns: ["apps/preview/**", "packages/core/**", "pnpm-lock.yaml"],
    },
    start: "node apps/preview/dist/index.js",
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    env: {
      PORT: "8080",
      DATABASE_URL: db.env.DATABASE_URL,
      PREVIEW_DOMAIN: previewDomain,
      // Links back to runs, and the only page allowed to frame the gateway's own pages.
      PUBLIC_URL: publicUrl,
      ...previewEnv,
    },
  });

  return project("factory-on-rails", {
    resources: [group("Factory", production ? [web, harness, runner, preview] : [web, harness, runner]), group("Data", [db])],
  });
});
