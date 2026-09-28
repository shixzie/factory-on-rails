# Setup

One-time steps to bring Factory on Rails up in the Railway project
`f4356592-cac1-4edf-a3bd-b58d0a8c023a`. Everything after these steps is driven
by `.railway/railway.ts` and CI.

## 1. Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

| Setting | Value |
|---|---|
| Homepage URL | Your harness URL (step 3), or the repo URL for now |
| Callback URL | `https://<harness domain>/auth/callback` |
| Expire user authorization tokens | On (default) |
| Request user authorization (OAuth) during installation | Optional |
| Webhook | Off for now |
| Repository permissions | Contents: **Read and write** · Pull requests: **Read and write** · Metadata: Read · Repository creation: **Read and write** (if your account doesn't offer it, use Administration: Read and write instead) |
| Where can this App be installed | Only on this account |

Then:

- Note the **App ID**, **Client ID** and the app's **slug** (the last part of its public URL).
- Generate a **client secret** and a **private key** (`.pem`).
- **Install** the App on your account, for all repositories or the ones the factory should work on.

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
| `ALLOWED_GITHUB_LOGINS` | `shixzie` (comma-separated for more people) |
| `RAILWAY_SANDBOX_TOKEN` | Token from step 2 |
| `SANDBOX_ENVIRONMENT_ID` | Environment id from step 2 |

## 4. Let CI apply the infrastructure

- Project Settings → Tokens: create a **project token for `production`**.
- GitHub repo → Settings → Secrets and variables → Actions: add it as `RAILWAY_TOKEN`.
- Make sure the Railway GitHub App can see this repository (Railway builds the services from it).

All infrastructure changes go through Railway's GitHub Action
(`railwayapp/config`, wired up in `.github/workflows/railway-config.yml`):
every PR that changes `.railway/` gets a plan comment, and merging applies
exactly that plan. Don't apply from your machine: an out-of-band change moves
the environment's config etag and makes the pending PR's apply fail until it
is re-planned.

For the first apply, add the secret before merging the PR that introduces
`.railway/railway.ts`, then push to it (or close and reopen it) so the plan job
runs with the token. Review the plan comment, then merge.

To preview locally without applying:

```bash
npm i -g @railway/cli   # needs CLI 5.42.1 or newer
railway login && railway link   # project factory-on-rails, environment production
pnpm install
railway config plan
```

## 5. Give the harness a domain

In the `harness` service → Settings → Networking, **Generate Domain** (or add a
custom one). Then put `https://<that domain>/auth/callback` in the GitHub App's
Callback URL. The harness derives its public URL from `RAILWAY_PUBLIC_DOMAIN`;
set `PUBLIC_URL` on the service only if you use a custom domain.

There is no platform-wide model API key. The factory is bring-your-own-key:
each user saves their own key under **Settings** in the harness, and only their
runs use it.

## 6. Smoke test

Open the harness, sign in with GitHub, save your Anthropic API key under
**Settings**, pick a repository, and start a run with
a small task ("Add a CONTRIBUTING.md with a short how-to-run section"). You
should see the sandbox come up in the `agents` environment's Sandboxes tab,
the log stream on the run page, and a PR on the repository when it finishes.

## Local development

```bash
cp .env.example .env    # fill in; a GitHub App with callback http://localhost:3000/auth/callback
pnpm install
pnpm migrate
pnpm dev:harness
pnpm dev:runner         # talks to real Railway sandboxes via RAILWAY_SANDBOX_TOKEN
```

Tests: `pnpm test`. Set `TEST_DATABASE_URL` to a disposable Postgres database
to include the database and HTTP suites (they drop and recreate its `public` schema).
