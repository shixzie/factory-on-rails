# Factory on Rails

A software factory hosted entirely on [Railway](https://railway.com). Sign in with
GitHub, pick or create a repository, describe a change, and a coding agent does
the work in a disposable Railway sandbox and opens a pull request. Written in
TypeScript with [Effect](https://effect.website).

<img src="docs/media/run-flow.webp" alt="A live run: the agent starts three subagents in parallel, the thread follows each one's work, and the Flow map animates every read, edit and command between you, the agent, its subagents and the workspace." width="100%">

While a run works you can follow it live, answer the agent's questions, and
watch its subagents and the flow of work between them on the Flow map.

- **Claude Code or Codex**, per run, on each user's own credential: a Claude
  subscription token, an Anthropic API key, a ChatGPT sign-in or an OpenAI API
  key. The composer also picks the model and reasoning effort.
- **Images and MCP servers.** Paste or drop up to four images into a task or
  follow-up. Under **Settings → MCP servers**, connect your own tools (remote
  HTTP with a token, headers or OAuth, or a command run in the sandbox); see
  [MCP servers](docs/setup.md#mcp-servers).
- **Pull requests that go green.** The agent writes each PR's title and
  description, a thread can open several PRs, and after every push the
  runner waits for CI and sends the agent back to fix failing checks.
- **Threads that tidy themselves.** The sidebar keeps active threads on top,
  questions first, with each PR's status. A thread whose PRs have all merged
  moves to its repository's **Settled** list (or settle one yourself from its
  row); a follow-up brings it back.
- **Private previews** of servers the agent runs in its sandbox, from the
  run's **Preview** tab (optional, see [Previews](#previews-optional)).
- **Deploys don't interrupt runs.** A redeployed runner reconnects to the
  agent still working in its sandbox.

Our own instance runs at [factory.shixzie.com](https://factory.shixzie.com), and
its Railway infrastructure is public: you can look around the project behind it
at
[railway.com/project/f4356592-cac1-4edf-a3bd-b58d0a8c023a](https://railway.com/project/f4356592-cac1-4edf-a3bd-b58d0a8c023a).

```
.railway/railway.ts     Railway infrastructure as code (services, database)
apps/web                Web UI (Next.js + shadcn/ui): runs as threads, composer, settings
apps/harness            API and auth backend: GitHub login, repos, runs, keys (JSON)
apps/runner             Worker: runs each task in a Railway sandbox, opens the PR
apps/preview            Preview gateway: serves apps running in sandboxes to their run's owner
packages/core           Schema, data access, GitHub App auth, encryption
docs/architecture.md    How it fits together and what comes next
docs/setup.md           Setup by hand: GitHub App, tokens, shared variables, IaC
docs/railway-template.md  How the one-click Railway template is put together
```

```bash
pnpm install
pnpm run typecheck
pnpm test
```

See [docs/architecture.md](docs/architecture.md) for the design.

## Host your own

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/factory-on-rails?utm_medium=integration&utm_source=button&utm_campaign=factory-on-rails)

Factory on Rails runs entirely on [Railway](https://railway.com). The Railway
template deploys the web UI, the API, the runner and Postgres, already wired
together with a generated encryption key. What's left is what only you can
do, and the app walks you through it on its setup page:

1. **Deploy the template.** Railway asks for one value, `ALLOWED_GITHUB_LOGINS`:
   your GitHub username (comma-separate several). Only those accounts can sign
   in, and the GitHub App has to belong to one of them.
2. **Open the web service's URL** once it's deployed (Railway shows it on the
   `web` service). It takes you to `/setup`.
3. **Create the GitHub App.** Click **Create GitHub App**, check what GitHub
   shows you, and confirm. The App's callback URL and permissions are filled
   in, and its credentials go straight into the factory's database, encrypted.
   To own it with an organization, type the organization's name and add it to
   `ALLOWED_GITHUB_LOGINS` first.
4. **Install the App** on the repositories the factory should work on
   (**Install on GitHub** on the setup page), then **sign in** with GitHub.
5. **Connect Railway sandboxes.** Create an account or workspace token at
   [railway.com/account/tokens](https://railway.com/account/tokens) and paste
   it. The factory uses it once to create an empty `agents` environment in the
   project and a token that can only reach that environment, then forgets it;
   you can delete the token afterwards.
6. **Save your agent credential** under **Settings** (a Claude subscription
   token or Anthropic API key for Claude Code, a ChatGPT sign-in or an OpenAI
   API key for Codex) and start a run.

Costs: services and sandboxes are billed to the Railway workspace you deploy
into; each user's model usage goes to their own key or subscription. To open sign-in to
any GitHub account, set `ALLOWED_GITHUB_LOGINS` to `*` on the `harness` service
after setup.

### Previews (optional)

Previews let a run's owner open what the agent is running in its sandbox (a
dev server, an API) from the run's **Preview** tab. Each run and port gets its
own subdomain, so previews need a wildcard domain you control, which a
template can't bring. Everything else works without them. To turn them on:

1. **Add a `preview` service** from this repository (`+ Create` → GitHub Repo)
   with start command `node apps/preview/dist/index.js`, healthcheck
   `/healthz`, one replica, and the variables in
   [docs/railway-template.md](docs/railway-template.md#previews-not-in-the-template).
   The signing key the template generated is shared with it by reference.
2. **Add the wildcard domain** to it (Settings → Networking → Custom Domain,
   e.g. `*.preview.example.com`, port 8080) and create the DNS records Railway
   shows. On Cloudflare, leave them **DNS only** (grey cloud).
3. **Point the others at it.** On `harness` set `PREVIEW_DOMAIN` to the domain
   without `*.` (`preview.example.com`); on `runner` set `PREVIEW_TUNNEL_URL`
   to `wss://tunnel.preview.example.com/connect`.

Step 4 of the setup page turns green once the harness sees them.

### Custom domain

For a custom domain, add it to the `web` service in Railway, then set
`PUBLIC_URL` on `harness` (and on `preview`, if you added it) and `HARNESS_URL`
on `runner` to `https://<your domain>`, and add
`https://<your domain>/auth/callback` to the GitHub App's callback URLs.

### Without the template

To run it without the template, with every credential in environment
variables and the infrastructure in `.railway/railway.ts` applied by CI (how
the maintainers' own deployment runs), follow [docs/setup.md](docs/setup.md).
How the template itself is built is in
[docs/railway-template.md](docs/railway-template.md).

### Updating

Railway redeploys each service when its part of the repository changes, and
the harness applies database migrations before it starts, so updating needs
nothing by hand. One exception: a GitHub App created before CI checks were
read needs three more repository permissions (Checks, Commit statuses and
Actions, all read-only), or runs fail when they look at CI. Add them in the
App's settings and accept the update on its installation
([setup.md, step 1](docs/setup.md#1-create-the-github-app)).

## License

[MIT](LICENSE)
