import {
  MODEL_PROVIDERS,
  type ApiKeySummary,
  type GitHubRepo,
  type ModelProvider,
  type RunEventRow,
  type RunRow,
  type UserRow,
} from "@factory/core";
import type { Child } from "hono/jsx";

export interface RepoOption {
  installationId: number;
  repo: GitHubRepo;
}

const css = `
:root { color-scheme: light dark; --fg:#1b1b1f; --muted:#6b6b76; --bg:#fafafa; --card:#fff; --line:#e4e4e8; --accent:#7c3aed; }
@media (prefers-color-scheme: dark) { :root { --fg:#ececf1; --muted:#9a9aa5; --bg:#111114; --card:#1a1a1f; --line:#2c2c33; } }
* { box-sizing: border-box; }
body { margin:0; font: 15px/1.5 system-ui, sans-serif; color:var(--fg); background:var(--bg); }
header { display:flex; align-items:center; gap:12px; padding:12px 20px; border-bottom:1px solid var(--line); }
header .brand { font-weight:700; margin-right:auto; }
main { max-width: 960px; margin: 0 auto; padding: 20px 16px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
a { color: var(--accent); }
label { display:block; font-weight:600; margin:10px 0 4px; }
input, select, textarea { width:100%; padding:8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; }
textarea { min-height: 120px; }
button, .button { display:inline-block; margin-top:12px; padding:8px 14px; border:0; border-radius:6px; background:var(--accent); color:#fff; font:inherit; cursor:pointer; text-decoration:none; }
button.secondary { background: transparent; color: var(--fg); border:1px solid var(--line); }
table { width:100%; border-collapse: collapse; }
td, th { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align: top; }
.muted { color: var(--muted); }
.status { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); white-space:nowrap; }
.status.succeeded { border-color:#16a34a; color:#16a34a; } .status.failed { border-color:#dc2626; color:#dc2626; }
.status.running, .status.cancelling { border-color:#d97706; color:#d97706; }
pre.log { background:#0d0d10; color:#d4d4d8; padding:12px; border-radius:8px; overflow:auto; max-height:70vh; font-size:13px; white-space:pre-wrap; }
.log .stderr, .log .error { color:#f87171; } .log .info { color:#a78bfa; }
`;

export function Layout(props: { title: string; user?: UserRow | null; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title} · Factory on Rails</title>
        <style>{css}</style>
      </head>
      <body>
        <header>
          <a class="brand" href="/">Factory on Rails</a>
          {props.user ? (
            <>
              <a href="/repos/new">New repo</a>
              <a href="/settings">Settings</a>
              <span class="muted">@{props.user.github_login}</span>
              <form method="post" action="/auth/logout" style="margin:0">
                <button class="secondary" style="margin:0">Sign out</button>
              </form>
            </>
          ) : null}
        </header>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

export function LoginPage(props: { error?: string }) {
  return (
    <Layout title="Sign in">
      <div class="card">
        <h1>Factory on Rails</h1>
        <p>Queue coding tasks against your GitHub repos. Each task runs in its own Railway sandbox and comes back as a pull request.</p>
        {props.error ? <p style="color:#dc2626">{props.error}</p> : null}
        <a class="button" href="/auth/login">Sign in with GitHub</a>
      </div>
    </Layout>
  );
}

function Status(props: { status: string }) {
  return <span class={`status ${props.status}`}>{props.status}</span>;
}

export function Dashboard(props: {
  user: UserRow;
  repos: ReadonlyArray<RepoOption>;
  runs: ReadonlyArray<RunRow>;
  installUrl: string;
  hasApiKey: boolean;
}) {
  return (
    <Layout title="Dashboard" user={props.user}>
      <div class="card">
        <h2 style="margin-top:0">New run</h2>
        {!props.hasApiKey ? (
          <p>
            Runs use your own model API key. <a href="/settings">Add your key in Settings</a> to start a run.
          </p>
        ) : props.repos.length === 0 ? (
          <p>
            The GitHub App can't see any of your repositories yet. <a href={props.installUrl}>Install it</a> on the
            repos the factory should work on, then reload.
          </p>
        ) : (
          <form method="post" action="/runs">
            <label for="repo">Repository</label>
            <select id="repo" name="repo" required>
              {props.repos.map(({ installationId, repo }) => (
                <option value={`${installationId}:${repo.full_name}`}>{repo.full_name}</option>
              ))}
            </select>
            <label for="base_branch">Base branch</label>
            <input id="base_branch" name="base_branch" placeholder="Repository default branch" />
            <label for="task">Task</label>
            <textarea id="task" name="task" required placeholder="Describe the change you want. The agent opens a PR when it's done." />
            <button type="submit">Start run</button>
            <p class="muted">
              Missing a repo? <a href={props.installUrl}>Grant the app access</a>.
            </p>
          </form>
        )}
      </div>
      <div class="card">
        <h2 style="margin-top:0">Recent runs</h2>
        {props.runs.length === 0 ? (
          <p class="muted">No runs yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Task</th><th>Repo</th><th>Status</th><th>PR</th></tr>
            </thead>
            <tbody>
              {props.runs.map((r) => (
                <tr>
                  <td><a href={`/runs/${r.id}`}>{r.task.split("\n")[0]!.slice(0, 80)}</a></td>
                  <td class="muted">{r.repo_full_name}</td>
                  <td><Status status={r.status} /></td>
                  <td>{r.pull_request_url ? <a href={r.pull_request_url}>open</a> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}

const pollScript = (runId: string, lastId: string) => `
let after = ${JSON.stringify(lastId)};
const log = document.getElementById("log");
async function poll() {
  const res = await fetch("/api/runs/${runId}/events?after=" + after);
  if (!res.ok) return;
  const data = await res.json();
  for (const e of data.events) {
    const span = document.createElement("span");
    span.className = e.kind;
    span.textContent = e.kind === "info" || e.kind === "error" ? "» " + e.message + "\\n" : e.message;
    log.appendChild(span);
    after = e.id;
  }
  if (data.events.length) log.scrollTop = log.scrollHeight;
  document.getElementById("status").textContent = data.run.status;
  document.getElementById("status").className = "status " + data.run.status;
  if (data.run.pull_request_url) {
    const pr = document.getElementById("pr");
    pr.href = data.run.pull_request_url; pr.textContent = data.run.pull_request_url; pr.parentElement.hidden = false;
  }
  if (!${JSON.stringify(["succeeded", "failed", "cancelled"])}.includes(data.run.status)) setTimeout(poll, 2000);
}
poll();
`;

export function RunPage(props: { user: UserRow; run: RunRow; events: ReadonlyArray<RunEventRow> }) {
  const { run } = props;
  const active = ["queued", "running"].includes(run.status);
  const lastId = props.events.at(-1)?.id ?? "0";
  return (
    <Layout title="Run" user={props.user}>
      <div class="card">
        <p class="muted" style="margin:0">{run.repo_full_name} · base {run.base_branch}{run.branch ? ` · branch ${run.branch}` : ""}</p>
        <h2 style="white-space:pre-wrap">{run.task}</h2>
        <p>
          <span id="status" class={`status ${run.status}`}>{run.status}</span>
          {run.error ? <span style="color:#dc2626"> {run.error}</span> : null}
        </p>
        <p hidden={!run.pull_request_url}>
          Pull request: <a id="pr" href={run.pull_request_url ?? "#"}>{run.pull_request_url}</a>
        </p>
        {active ? (
          <form method="post" action={`/runs/${run.id}/cancel`}>
            <button class="secondary">Cancel run</button>
          </form>
        ) : null}
      </div>
      <pre id="log" class="log">
        {props.events.map((e) => (
          <span class={e.kind}>{e.kind === "info" || e.kind === "error" ? `» ${e.message}\n` : e.message}</span>
        ))}
      </pre>
      <script dangerouslySetInnerHTML={{ __html: pollScript(run.id, lastId) }} />
    </Layout>
  );
}

export function NewRepoPage(props: { user: UserRow; error?: string }) {
  return (
    <Layout title="New repository" user={props.user}>
      <div class="card">
        <h2 style="margin-top:0">Create a repository</h2>
        <p class="muted">Created under your GitHub account with an initial commit, so runs can target it right away.</p>
        {props.error ? <p style="color:#dc2626">{props.error}</p> : null}
        <form method="post" action="/repos">
          <label for="name">Name</label>
          <input id="name" name="name" required pattern="[A-Za-z0-9._-]+" />
          <label for="description">Description</label>
          <input id="description" name="description" />
          <label><input type="checkbox" name="private" value="1" checked style="width:auto" /> Private</label>
          <button type="submit">Create repository</button>
        </form>
      </div>
    </Layout>
  );
}

export function MessagePage(props: { title: string; user?: UserRow | null; children: Child }) {
  return (
    <Layout title={props.title} user={props.user}>
      <div class="card">{props.children}</div>
    </Layout>
  );
}

export function SettingsPage(props: { user: UserRow; keys: ReadonlyArray<ApiKeySummary>; error?: string; notice?: string }) {
  const byProvider = new Map(props.keys.map((k) => [k.provider, k]));
  return (
    <Layout title="Settings" user={props.user}>
      <div class="card">
        <h2 style="margin-top:0">API keys</h2>
        <p class="muted">
          Bring your own key: your runs use your key, and only your runs. Keys are encrypted at rest, never shown again
          after you save them, and only handed to the sandboxes that run your tasks.
        </p>
        {props.error ? <p style="color:#dc2626">{props.error}</p> : null}
        {props.notice ? <p style="color:#16a34a">{props.notice}</p> : null}
        {(Object.keys(MODEL_PROVIDERS) as ModelProvider[]).map((provider) => {
          const meta = MODEL_PROVIDERS[provider];
          const saved = byProvider.get(provider);
          return (
            <div style="border-top:1px solid var(--line); padding-top:8px; margin-top:12px">
              <h3 style="margin:4px 0">{meta.label}</h3>
              <p class="muted" style="margin:0">
                {saved
                  ? `Key ending in …${saved.hint}, saved ${saved.updated_at.toISOString().slice(0, 10)}.`
                  : "No key saved."}{" "}
                <a href={meta.consoleUrl}>Get a key</a>
              </p>
              <form method="post" action={`/settings/keys/${provider}`}>
                <label for={`key-${provider}`}>{saved ? "Replace key" : "API key"}</label>
                <input
                  id={`key-${provider}`}
                  name="key"
                  type="password"
                  autocomplete="off"
                  placeholder={meta.placeholder}
                  required
                />
                <button type="submit">Save key</button>
              </form>
              {saved ? (
                <form method="post" action={`/settings/keys/${provider}/delete`}>
                  <button class="secondary">Remove key</button>
                </form>
              ) : null}
            </div>
          );
        })}
      </div>
    </Layout>
  );
}
