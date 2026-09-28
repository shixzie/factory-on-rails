# Factory on Rails

A software factory hosted entirely on [Railway](https://railway.com). Sign in with
GitHub, pick or create a repository, describe a change, and a coding agent does
the work in a disposable Railway sandbox and opens a pull request. Written in
TypeScript with [Effect](https://effect.website).

<img src="docs/media/run-flow.webp" alt="A live run: the agent starts three subagents in parallel, the thread follows each one's work, and the Flow map animates every read, edit and command between you, the agent, its subagents and the workspace." width="100%">

While a run works you can follow it live, answer the agent's questions, and
watch its subagents and the flow of work between them on the Flow map.

```
.railway/railway.ts     Railway infrastructure as code (services, database)
apps/web                Web UI (Next.js + shadcn/ui): runs as threads, composer, settings
apps/harness            API and auth backend: GitHub login, repos, runs, keys (JSON)
apps/runner             Worker: runs each task in a Railway sandbox, opens the PR
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

<!-- Deploy button: replace TEMPLATE_CODE with the template's code (docs/railway-template.md, step 4), then uncomment.
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/TEMPLATE_CODE?utm_medium=integration&utm_source=button&utm_campaign=factory-on-rails)
-->

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
6. **Save your model API key** under **Settings** and start a run.

Costs: services and sandboxes are billed to the Railway workspace you deploy
into; each user's model usage goes to their own API key. To open sign-in to
any GitHub account, set `ALLOWED_GITHUB_LOGINS` to `*` on the `harness` service
after setup.

For a custom domain, add it to the `web` service in Railway, then set
`PUBLIC_URL` on `harness` and `HARNESS_URL` on `runner` to `https://<your domain>`,
and add `https://<your domain>/auth/callback` to the GitHub App's callback URLs.

To run it without the template, with every credential in environment
variables and the infrastructure in `.railway/railway.ts` applied by CI (how
the maintainers' own deployment runs), follow [docs/setup.md](docs/setup.md).
How the template itself is built is in
[docs/railway-template.md](docs/railway-template.md).
