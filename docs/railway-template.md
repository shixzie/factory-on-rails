# The Railway template

Published draft: [railway.com/new/template/RKSPC6](https://railway.com/new/template/RKSPC6).

This is how the "Deploy on Railway" template for Factory on Rails is put
together, so it can be recreated or updated. Deploying from it is covered in
the [README](../README.md#host-your-own).

Railway templates are composed in Railway's template editor; they are not read
from this repository. `.railway/railway.ts` only drives the maintainers'
own project through CI, and Railway doesn't read `.railway/` on deploy. So the
template repeats the build and start settings from `.railway/railway.ts` by
hand, and when a service's build, start, pre-deploy or healthcheck changes
there, update the template too.

What a template can't do, the app does itself on first run (see
[architecture.md](architecture.md#first-run-setup)):

- A template deploys one environment. The `agents` environment that sandboxes
  run in is created by the setup page, through Railway's API, with a token
  the person pastes once.
- A template can't create a GitHub App. The setup page registers one from a
  manifest, with the callback URL and permissions filled in.

Everything else is wired by the template: the database, the private network
between services, the public domain, and a generated encryption key.

## Create it

1. Railway → your workspace → **Templates** → **New Template**
   (https://railway.com/workspace/templates).
2. Add the four services below (`+ Add` in the top right). For the three app
   services pick **GitHub Repo** and enter `https://github.com/shixzie/factory-on-rails`
   (the `main` branch). Name them exactly `web`, `harness`, `runner` and
   `Postgres`: the variables below refer to each other by those names.
3. Fill in each service's **Settings** and **Variables** as listed.
4. In the template's details, upload `apps/web/public/logo.svg` as its icon
   and use the overview text at the end of this page.
5. **Create Template**, then on the Templates page open it, copy its URL (it
   ends in the template code, for example `/new/template/AbCdEf`), and put the
   code in the README's Deploy button.
6. Optional: **Publish** it to the marketplace, category "AI/ML".

### Postgres

`+ Add` → **Database** → **PostgreSQL**. Keep Railway's defaults (volume,
generated password). Name it `Postgres`.

### harness

The JSON API and GitHub sign-in. No public domain: the web service reaches it
over the private network.

| Setting | Value |
|---|---|
| Build command | `pnpm run build` |
| Start command | `node apps/harness/dist/index.js` |
| Pre-deploy command | `node packages/core/dist/db.js` (database migrations) |
| Healthcheck path | `/healthz` |
| Watch paths | `apps/harness/**`, `packages/core/**`, `pnpm-lock.yaml` |
| Public networking | none |

| Variable | Value | Description |
|---|---|---|
| `ALLOWED_GITHUB_LOGINS` | *(empty, required)* | Your GitHub username. Only these accounts can sign in, and the GitHub App must belong to one of them. Comma-separate several; add an organization's name to create the App under it. After setup you can set `*` to let any GitHub account in. |
| `TOKEN_ENCRYPTION_KEY` | `${{secret(43, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/")}}=` | Encrypts GitHub tokens, users' model keys and MCP credentials, and the App's credentials. Generated; don't change it after deploy. |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | |
| `PUBLIC_URL` | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` | The address people use. Change it if you add a custom domain. |
| `PORT` | `8080` | |
| `HOST` | `::` | Listen on IPv6 so the private network reaches it. |
| `SANDBOX_SNAPSHOTS` | *(empty, optional)* | Prepared sandbox checkpoints users may start runs from, as `name=login\|login`, comma-separated (see setup.md, step 7). |
| `PREVIEW_SIGNING_KEY` | `${{secret(64, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/")}}` | Signs preview links and sandbox tunnel grants. Generated, so turning previews on later only needs a domain; unused until then. |

### web

The UI and the only public service. It forwards `/api` and `/auth` to the harness.

| Setting | Value |
|---|---|
| Build command | `pnpm run build && pnpm --filter @factory/web build` |
| Start command | `cd apps/web && node node_modules/next/dist/bin/next start --hostname 0.0.0.0` |
| Healthcheck path | `/healthz` |
| Watch paths | `apps/web/**`, `packages/core/**`, `pnpm-lock.yaml` |
| Public networking | **Generate domain**, port `8080` |

| Variable | Value |
|---|---|
| `HARNESS_INTERNAL_URL` | `http://${{harness.RAILWAY_PRIVATE_DOMAIN}}:8080` |
| `PORT` | `8080` |
| `NEXT_TELEMETRY_DISABLED` | `1` |

### runner

The worker that drives one sandbox per run. No networking.

| Setting | Value |
|---|---|
| Build command | `pnpm run build` |
| Start command | `node apps/runner/dist/index.js` |
| Watch paths | `apps/runner/**`, `packages/core/**`, `pnpm-lock.yaml` |
| Public networking | none |

| Variable | Value | Description |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | |
| `TOKEN_ENCRYPTION_KEY` | `${{harness.TOKEN_ENCRYPTION_KEY}}` | Same key as the harness. |
| `HARNESS_URL` | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` | Links pull requests back to their run. |
| `MAX_CONCURRENT_RUNS` | `3` (optional) | Runs at once, one sandbox each. |
| `SANDBOX_SNAPSHOTS` | `${{harness.SANDBOX_SNAPSHOTS}}` | The same list as the harness; checked again when a run starts. |
| `PREVIEW_SIGNING_KEY` | `${{harness.PREVIEW_SIGNING_KEY}}` | Same key as the harness. |
| `SANDBOX_REGION` | *(empty, optional)* | Where sandboxes run, e.g. `us-east4-eqdc4a`. Railway's default is us-west2; put them near the factory's region. |

The template sets no GitHub App or sandbox variables: the setup page creates
both and stores them in the database, encrypted with `TOKEN_ENCRYPTION_KEY`.
Setting `GITHUB_APP_*`, `RAILWAY_SANDBOX_TOKEN` and `SANDBOX_ENVIRONMENT_ID`
by hand still works and takes precedence ([setup.md](setup.md)).

### Previews: not in the template

The preview gateway is left out: it needs a wildcard custom domain, which a
template can't bring, and without one it won't start. The template generates
`PREVIEW_SIGNING_KEY` so that adding it later is only the service and the
domain, as the README's [Previews (optional)](../README.md#previews-optional)
describes. For reference, the service it adds:

| Setting | Value |
|---|---|
| Build command | `pnpm run build` |
| Start command | `node apps/preview/dist/index.js` |
| Healthcheck path | `/healthz` |
| Watch paths | `apps/preview/**`, `packages/core/**`, `pnpm-lock.yaml` |
| Public networking | the wildcard custom domain, port `8080` |
| Replicas | 1 (sandboxes' tunnels live in its memory) |

| Variable | Value |
|---|---|
| `PORT` | `8080` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `PREVIEW_DOMAIN` | e.g. `preview.example.com` (the wildcard without `*.`) |
| `PUBLIC_URL` | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` |
| `PREVIEW_SIGNING_KEY` | `${{harness.PREVIEW_SIGNING_KEY}}` |

## Overview text for the marketplace

```md
# Deploy and Host Factory on Rails with Railway

Factory on Rails is a self-hosted software factory. Sign in with GitHub, pick
a repository, describe a change, and a coding agent (Claude Code or Codex) does
the work in its own Railway sandbox and opens a pull request. You can follow
the agent live, answer its questions, attach screenshots and keep the
conversation going. The agent writes the PR's title and description, waits for
CI and fixes failing checks itself. Users bring their own tools as MCP
servers, and with an optional wildcard domain can open the app the agent is
running in its sandbox, privately.

## About Hosting Factory on Rails

The template deploys the web UI, an API and auth service, a runner, and
Postgres, wired together over Railway's private network with a generated
encryption key. On first visit a setup page creates the GitHub App from a
manifest (no credentials to copy) and, with a Railway token you paste once,
creates the separate `agents` environment the sandboxes run in. Each user
brings their own model API key; sandbox usage is billed to your Railway
workspace.

## Common Use Cases

- Hand small, well-defined changes to a coding agent and review them as PRs
- Run several agents in parallel, each isolated in its own sandbox
- Give a team one place to queue agent work against its repositories
- Let agents keep a PR's CI green without anyone babysitting it

## Dependencies for Factory on Rails Hosting

- A GitHub account (for the GitHub App and sign-in)
- A model credential per user: a Claude subscription token, an Anthropic API key, a ChatGPT sign-in, or an OpenAI API key
- Railway Sandboxes

### Deployment Dependencies

- Source: https://github.com/shixzie/factory-on-rails
- Railway Sandboxes: https://docs.railway.com/sandboxes

### Why Deploy Factory on Rails on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway
will host your infrastructure so you don't have to deal with configuration,
while allowing you to vertically and horizontally scale it.

By deploying Factory on Rails on Railway, you are one step closer to
supporting a complete full-stack application with minimal burden. Host your
servers, databases, AI agents, and more on Railway.
```
