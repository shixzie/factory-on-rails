# Setup

One-time steps to bring Factory on Rails up in the Railway project
`f4356592-cac1-4edf-a3bd-b58d0a8c023a`. Everything after these steps is driven
by `.railway/railway.ts` and CI.

## 1. Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

| Setting | Value |
|---|---|
| Homepage URL | Your site URL (step 5), or the repo URL for now |
| Callback URL | `https://<site domain>/auth/callback` (the web app's domain, step 5) |
| Expire user authorization tokens | On (default) |
| Request user authorization (OAuth) during installation | Optional |
| Webhook | Off for now |
| Repository permissions | Contents: **Read and write** · Pull requests: **Read and write** · Workflows: **Read and write** · Metadata: Read · Repository creation: **Read and write** (if your account doesn't offer it, use Administration: Read and write instead) |
| Where can this App be installed | Only on this account |

Then:

- Note the **App ID**, **Client ID** and the app's **slug** (the last part of its public URL).
- Generate a **client secret** and a **private key** (`.pem`).
- **Install** the App on your account, for all repositories or the ones the factory should work on.

Workflows lets agents change files in `.github/workflows`. Without it, GitHub
rejects any push that touches them, and the run fails with a message saying so.
To add it to an App you already created: App settings → Permissions & events →
Repository permissions → Workflows: Read and write → Save changes. Then accept
the new permission on the installation (GitHub emails you a link, or open
Settings → Applications → Installed GitHub Apps → the App → Review request).

## 2. Create the `agents` environment and its token

Sandboxes run in their own environment so the runner's token can't touch production.

- In the Railway project, create an environment named `agents`
  (dashboard, or `railway environment new agents`). Leave it empty.
- Project Settings → Tokens: create a **project token for `agents`**. This is `RAILWAY_SANDBOX_TOKEN`.
- Copy the `agents` environment id (Project Settings → Environments, or
  `railway status --json`). This is `SANDBOX_ENVIRONMENT_ID`.

## 3. Set shared variables in `production`

Project → `production` → Settings → **Shared Variables**:

| Name | Value |
|---|---|
| `GITHUB_APP_ID` | App ID from step 1 |
| `GITHUB_APP_SLUG` | App slug |
| `GITHUB_APP_CLIENT_ID` | Client ID |
| `GITHUB_APP_CLIENT_SECRET` | Client secret |
| `GITHUB_APP_PRIVATE_KEY` | Full `.pem` contents |
| `TOKEN_ENCRYPTION_KEY` | Output of `openssl rand -base64 32`. Encrypts stored GitHub tokens and users' API keys. Don't rotate it casually: after a rotation users sign in again and re-save their API keys. |
| `RAILWAY_SANDBOX_TOKEN` | Token from step 2 |
| `SANDBOX_ENVIRONMENT_ID` | Environment id from step 2 |

## 4. Let CI apply the infrastructure

- Project Settings → Tokens: create a **project token for `production`**.
- GitHub repo → Settings → Secrets and variables → Actions: add it as `RAILWAY_TOKEN`.
- Make sure the Railway GitHub App can see this repository (Railway builds the services from it).

All infrastructure changes go through Railway's GitHub Action
(`railwayapp/config`, wired up in `.github/workflows/railway-config.yml`):
every PR that changes `.railway/` gets a plan comment, and merging applies
exactly that plan. Don't apply from your machine: any change to the
environment after the plan (a local apply, or dashboard edits such as adding
shared variables) moves its config etag, and the apply on merge then fails with
"The environment changed since this plan was computed".

So finish dashboard changes first, then push to the PR (or close and reopen it)
so the plan is fresh, review the plan comment, and merge. If an apply on merge
still fails that way, nothing was changed; open a PR that touches `.railway/`
(or the workflow) to get a new plan, and merge that.

To preview locally without applying:

```bash
npm i -g @railway/cli   # needs CLI 5.42.1 or newer
railway login && railway link   # project factory-on-rails, environment production
pnpm install
railway config plan
```

## 5. Give the web app a domain

Production serves the web app (`apps/web`) on `factory.shixzie.com`. The
harness needs no public domain: the web app forwards `/api/*` and `/auth/*` to
it over the private network, and the harness's `PUBLIC_URL` is the web app's
URL. Both listen on `PORT=8080`.

Railway IaC can keep a custom domain in sync but can't register one on a
service, so a domain is added in the dashboard first and then declared in
`.railway/railway.ts` (a plan that declares an unregistered domain fails with
"Custom-domain registration is not supported"). To move `factory.shixzie.com`
from the harness to the web service:

1. In the dashboard, remove `factory.shixzie.com` from the `harness` service
   (Settings → Networking), then add it to the `web` service with target
   port 8080.
2. Copy the DNS record Railway shows for it on `web` (each service gets its own
   target) into Cloudflare, keeping SSL/TLS mode **Full (strict)**.
3. Merge a PR that moves the `domains` entry from `harness` to `web` in
   `.railway/railway.ts`, opened after step 1 so its plan is fresh.

With Cloudflare in front, "Flexible" SSL makes Cloudflare call Railway over
HTTP, Railway redirects to HTTPS, and every request loops on a 301.

Put `https://factory.shixzie.com/auth/callback` in the GitHub App's Callback URL.
For another environment, generate a Railway domain for the web service instead;
the IaC points the harness's `PUBLIC_URL` at it.

Sign-in is open to any GitHub account (`ALLOWED_GITHUB_LOGINS: "*"` in the
IaC). To restrict it, change that value to a comma-separated list of logins.

There is no platform-wide model API key. The factory is bring-your-own-key:
each user saves their own key under **Settings** in the web app, and only their
runs use it.

## 6. Smoke test

Open the site, sign in with GitHub, save your Anthropic API key under
**Settings**, pick a repository, and start a run with
a small task ("Add a CONTRIBUTING.md with a short how-to-run section"). You
should see the sandbox come up in the `agents` environment's Sandboxes tab,
the log stream on the run page, and a PR on the repository when it finishes.

## Local development

```bash
cp .env.example .env    # fill in; a GitHub App with callback http://localhost:3000/auth/callback
pnpm install
pnpm migrate
pnpm dev:harness        # API on :3001 (PORT in .env)
pnpm dev:web            # UI on http://localhost:3000, forwards /api and /auth to :3001
pnpm dev:runner         # talks to real Railway sandboxes via RAILWAY_SANDBOX_TOKEN
```

Tests: `pnpm test`. Set `TEST_DATABASE_URL` to a disposable Postgres database
to include the database and HTTP suites (they drop and recreate its `public` schema).
