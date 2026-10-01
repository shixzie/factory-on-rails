# Setup

One-time steps to bring Factory on Rails up by hand, with every credential in
environment variables and the infrastructure applied from `.railway/railway.ts`
by CI. This is how the maintainers' deployment (Railway project
`f4356592-cac1-4edf-a3bd-b58d0a8c023a`, factory.shixzie.com) runs.

To host your own copy, the Railway template is quicker: it wires the services
together, and the app's `/setup` page creates the GitHub App and the `agents`
environment for you (see the README's "Host your own"). Variables set as below
take precedence over what the setup page stored, so a template deployment can
switch to this way at any time.

## 1. Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

| Setting | Value |
|---|---|
| Homepage URL | Your site URL (step 5), or the repo URL for now |
| Callback URL | `https://<site domain>/auth/callback` (the web app's domain, step 5) |
| Expire user authorization tokens | On (default) |
| Request user authorization (OAuth) during installation | Optional |
| Webhook | Off for now |
| Repository permissions | Contents: **Read and write** · Pull requests: **Read and write** · Workflows: **Read and write** · Checks: **Read** · Commit statuses: **Read** · Actions: **Read** · Metadata: Read · Repository creation: **Read and write** (if your account doesn't offer it, use Administration: Read and write instead) |
| Where can this App be installed | Only on this account |

Then:

- Note the **App ID**, **Client ID** and the app's **slug** (the last part of its public URL).
- Generate a **client secret** and a **private key** (`.pem`).
- **Install** the App on your account, for all repositories or the ones the factory should work on.

CI verification requires **Checks**, **Commit statuses**, and **Actions** read access.
For an existing GitHub App, add these repository permissions in the App settings
and accept the permission update on each installation. Runs fail if CI cannot be
read; they do not silently skip verification.

After opening or updating a PR, the runner waits for checks and commit statuses
on the pushed commit. Failed checks resume the agent to diagnose and fix them,
then the runner pushes and verifies the new commit. The agent is idle while
the factory waits for CI and stays idle once checks pass or the PR is merged.
If checks turn green or the PR is merged during an automatic repair, the
factory stops that repair. A new message still starts a new turn, and idle
sandboxes are saved and stopped as usual. Neutral/skipped checks are
accepted as GitHub terminal non-failures. Repositories reporting no checks get a
60-second discovery period. CI waiting and repair share an additional
`AGENT_TIMEOUT_SECONDS` budget (one hour by default); a timeout or an agent that
cannot produce a fix leaves the run failed with the PR available for inspection.

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
| `TOKEN_ENCRYPTION_KEY` | Output of `openssl rand -base64 32`. Encrypts stored GitHub tokens, users' API keys and MCP credentials. Don't rotate it casually: after a rotation users must sign in again and re-save their credentials. |
| `RAILWAY_SANDBOX_TOKEN` | Token from step 2 |
| `SANDBOX_ENVIRONMENT_ID` | Environment id from step 2 |
| `PREVIEW_SIGNING_KEY` | Output of `openssl rand -base64 48`. Signs preview links and sandbox tunnel grants (step 8). Without it previews are off and the `preview` service won't start. |

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
runs use it. Runs use Claude Code or Codex, picked per run in the composer:

| Agent | Credential in Settings | What it bills |
|---|---|---|
| Claude Code | Claude subscription token (`claude setup-token`) | Your Pro, Max, Team or Enterprise plan |
| Claude Code | Anthropic API key | Your Anthropic Console account |
| Codex | OpenAI API key | Your OpenAI Platform account |
| Codex | ChatGPT device login (`codex login --device-auth`) | Your eligible ChatGPT plan |

A run gets only its agent's credential. For ChatGPT, run `codex login
--device-auth` locally, finish the code login, and paste the contents of
`~/.codex/auth.json` into the ChatGPT subscription field in Settings. With
both saved, Claude Code gets the
subscription token (it would prefer an API key if it had both). An agent can
also run on the sign-in inside a sandbox snapshot (step 7).

### MCP servers

Apply migration `014_user_mcp_servers.sql` before deploying this feature (the
harness runs migrations before deployment).

Open **Settings → MCP servers → Add MCP server**. Give the server a unique name
using letters, numbers, underscores or hyphens (`factory` is reserved for the
built-in tools), then choose a connection:

- **Remote HTTP:** enter the MCP endpoint, such as
  `https://mcp.example.com/mcp`. Select no authentication, paste a bearer token,
  or select OAuth. Optional HTTP headers are a JSON object of string values,
  such as `{"X-API-Key":"your-key"}`.
- **Local command (stdio):** enter an executable available in the sandbox,
  such as `npx`, and arguments as a JSON array, such as
  `["-y","@example/mcp-server"]`. Environment variables are an optional JSON
  object of string values, such as `{"API_KEY":"your-key"}`. Install any required
  executable in your sandbox snapshot or use an available package runner.

For OAuth, save the server and click **Sign in**, then complete authorization
at its provider. The server must use public HTTPS endpoints and support OAuth
discovery and automatic client registration. Private-network OAuth endpoints
are not supported. Providers that require a separately configured client ID and
secret are not supported by this flow; use a provider-issued bearer token or
header if the provider offers one. The callback address is
`<PUBLIC_URL>/auth/mcp/callback`. **Reconnect** starts a new sign-in and
**Disconnect** removes Factory's saved authorization. Disconnecting does not
revoke the grant at the provider; use its account settings to do that.

Saved servers apply to your account's Claude Code and Codex threads. Each new
thread and each subsequent agent turn loads your latest enabled servers and
credentials. Settings do not change a command already running. OAuth access
tokens are refreshed before a new turn when possible; a long-running agent may
need a new turn after its token expires. Sign in again if a grant expires or is
revoked. An unauthenticated server remains listed so you can
finish connecting it.

Tokens, HTTP header values, environment values and OAuth credentials are
encrypted with `TOKEN_ENCRYPTION_KEY`. Settings shows saved header and variable
names, never their values. When editing, leave a secret field blank to keep its
saved value. Changing the URL, authentication method, transport, command or
arguments clears previous credentials; enter replacements and sign in again as
needed. Renaming or enabling a server keeps its credentials. Entering a JSON
object replaces all saved headers or environment variables; `{}` clears them.
Disabling or removing a server takes effect on the
next turn. MCP credentials are made available to your isolated task sandbox,
where the coding agent needs them to use the server.

## 6. Smoke test

Open the site, sign in with GitHub, save your Anthropic API key under
**Settings**, pick a repository, and start a run with
a small task ("Add a CONTRIBUTING.md with a short how-to-run section"). You
should see the sandbox come up in the `agents` environment's Sandboxes tab,
the log stream on the run page, and a PR on the repository when it finishes.

## 7. Sandbox snapshots (optional)

A snapshot is a sandbox prepared once by hand and saved as a Railway
checkpoint in the `agents` environment. Runs of the users it is declared for
boot from it instead of a blank sandbox. Use one to have Codex (or Claude Code)
signed in to your ChatGPT or Claude subscription, or to preinstall
toolchains a repository needs. For Claude Code alone you don't need one: save
a subscription token in Settings instead.

Railway's standard sandbox image already has git, Node and the common coding
agents; the runner installs Claude Code or Codex if a snapshot lacks them.

1. Start a sandbox in `agents` and open a shell in it. `ssh` needs an SSH key
   on your Railway account (Account Settings → SSH Keys); the dashboard's
   Sandboxes tab can open one in the browser instead.

   ```bash
   railway link                     # project factory-on-rails
   railway sandbox create -e agents --idle-timeout-minutes 60
   railway sandbox ssh -e agents
   ```

2. In that shell, set it up as the agent should find it:

   - Codex with ChatGPT: `codex login --device-auth`, then open the link it
     prints on any device and enter the code. `codex login status` confirms it.
   - Claude Code with your plan: run `claude`, type `/login`, open the link
     and paste the code back. (Or skip this and use the token in Settings.)
   - Anything else runs need: toolchains, package caches, global config.

   Stay out of `/workspace/repo`, which is where each run clones its
   repository. Then `exit`.

3. Save it and remove the sandbox (reusing a name replaces that checkpoint,
   which is also how you update one):

   ```bash
   railway sandbox checkpoint create shixzie-agents -e agents
   railway sandbox destroy -e agents
   ```

4. Declare who may use it in `SANDBOX_SNAPSHOTS` in `.railway/railway.ts`
   (both the harness and the runner read it) and merge the PR: entries are
   `name=login|login`, comma-separated, and `*` means everyone. A snapshot
   holds the sign-in of whoever prepared it, and every run that boots from it
   can use that account, so list only that person unless it has no
   credentials in it.

5. In the web app, **Settings → Sandbox snapshot**, pick it. New sandboxes for
   your runs boot from it; an agent with no key saved in Settings uses the
   sign-in in the snapshot, and a saved key takes precedence.

Good to know:

- A sandbox from a checkpoint runs in the region the checkpoint was captured
  in, and the CLI creates sandboxes in us-west2, so runs from a CLI-made
  snapshot run there rather than next to the factory.
- Snapshots count toward the same per-environment checkpoint limit as stopped
  runs (50 on Hobby, 100 on Pro).
- If runs from a snapshot start failing to authenticate (a login expired),
  redo steps 1 to 3 with the same name.
- `SANDBOX_CHECKPOINT` on the runner still names a base every run starts from
  when its user hasn't picked a snapshot. It is for everyone, so it must not
  hold anyone's sign-in.

## 8. Give the preview gateway its wildcard domain

Previews of servers running in a sandbox are served by the `preview` service
on `*.preview.shixzie.com`: one origin per run and port
(`p5173-<run>.preview.shixzie.com`), and `tunnel.preview.shixzie.com` for
sandboxes to connect to. As with the web domain, the domain is added in the
dashboard first:

1. Make sure `PREVIEW_SIGNING_KEY` is set (step 3), then let the IaC create
   the `preview` service.
2. In the dashboard, add the custom domain `*.preview.shixzie.com` to the
   `preview` service (Settings → Networking) with target port 8080.
3. In Cloudflare, add the records Railway shows: the `*.preview` CNAME, the
   `_acme-challenge.preview` CNAME and the TXT record. Set both CNAMEs to
   **DNS only** (grey cloud): Cloudflare's free certificate doesn't cover a
   second-level wildcard, so Railway issues and serves the certificate itself.
4. Merge a PR that declares the domain on `preview` in `.railway/railway.ts`
   (`domains: [{ domain: "*.preview.shixzie.com", port: 8080 }]`).

Keep the `preview` service at one replica: sandboxes' tunnels live in its
memory. It is a small always-on Node process; preview traffic is billed as
egress.

## Local development

```bash
cp .env.example .env    # fill in; a GitHub App with callback http://localhost:3000/auth/callback
pnpm install
pnpm migrate
pnpm dev:harness        # API on :3001 (PORT in .env)
pnpm dev:web            # UI on http://localhost:3000, forwards /api and /auth to :3001
pnpm dev:runner         # talks to real Railway sandboxes via RAILWAY_SANDBOX_TOKEN
```

Previews work locally too: set `PREVIEW_DOMAIN=preview.localhost:8090` and a
`PREVIEW_SIGNING_KEY` for the harness, and run the gateway with
`PORT=8090 PUBLIC_URL=http://localhost:3000 node apps/preview/dist/index.js`.
Browsers resolve `*.localhost` to your machine, and `*.localhost` is served
over plain http. Real sandboxes can't reach your machine, so point a preview
agent at it by hand (see apps/preview/test/gateway.test.ts for how).

Tests: `pnpm test`. Set `TEST_DATABASE_URL` to a disposable Postgres database
to include the database and HTTP suites (they drop and recreate its `public` schema).
