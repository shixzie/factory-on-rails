# Factory on Rails

A software factory hosted entirely on [Railway](https://railway.com). Sign in with
GitHub, pick or create a repository, describe a change, and a coding agent does
the work in a disposable Railway sandbox and opens a pull request. Written in
TypeScript with [Effect](https://effect.website).

```
.railway/railway.ts     Railway infrastructure as code (services, database)
apps/harness            Web app: GitHub login, repos, runs, live logs
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
