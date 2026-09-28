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
docs/setup.md           One-time setup (GitHub App, tokens, shared variables)
```

```bash
pnpm install
pnpm run typecheck
pnpm test
```

Start with [docs/setup.md](docs/setup.md) to deploy, and
[docs/architecture.md](docs/architecture.md) for the design.
