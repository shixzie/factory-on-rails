import {
  claimNextRun,
  createDb,
  createInstallationToken,
  finishRun,
  heartbeat,
  reapStaleRuns,
  RepoGitHub,
  updateRun,
  type RunRow,
} from "@factory/core";
import { Sandbox } from "railway";
import { loadConfig } from "./config.js";
import { executeRun, type SandboxLike } from "./execute.js";
import { LogBuffer } from "./log-buffer.js";

const config = loadConfig();
const sql = createDb(config.databaseUrl);
const sandboxAuth = { token: config.sandbox.token, authType: "project-token" as const, environmentId: config.sandbox.environmentId };
const active = new Set<Promise<void>>();
let stopping = false;

async function createSandbox(env: Record<string, string>): Promise<SandboxLike> {
  const options = {
    ...sandboxAuth,
    env,
    region: config.sandbox.region,
    idleTimeoutMinutes: config.sandbox.idleTimeoutMinutes,
    // Agents get internet egress but no route to the factory's own services or database.
    networkIsolation: "ISOLATED" as const,
  };
  return config.sandbox.checkpoint ? Sandbox.create(config.sandbox.checkpoint, options) : Sandbox.create(options);
}

async function handleRun(run: RunRow): Promise<void> {
  const log = new LogBuffer(sql, run.id);
  log.push("info", `Claimed by runner ${config.workerId}`);
  const outcome = await executeRun(run, {
    createSandbox,
    mintRepoToken: async (installationId, repoFullName) =>
      (
        await createInstallationToken(config.github, installationId, {
          repositories: [repoFullName.split("/")[1]!],
          permissions: { contents: "write", pull_requests: "write", metadata: "read" },
        })
      ).token,
    createPullRequest: async (token, repoFullName, pr) =>
      (await new RepoGitHub(token, repoFullName).createPullRequest(pr)).html_url,
    report: {
      info: (m) => log.push("info", m),
      error: (m) => log.push("error", m),
      output: (stream, chunk) => log.push(stream, chunk),
      update: (patch) => updateRun(sql, run.id, patch),
      heartbeat: () => heartbeat(sql, run.id),
    },
    agent: { ...config.agent, env: config.agent.passthroughEnv },
    git: config.git,
    harnessUrl: config.harnessUrl,
  });
  await log.close();
  await finishRun(sql, run.id, outcome.status, outcome.status === "failed" ? outcome.error : undefined);
  console.log(`run ${run.id} ${outcome.status}`);
}

/** Fails runs whose runner died and tears down the sandboxes they left behind. */
async function reap(): Promise<void> {
  for (const stale of await reapStaleRuns(sql, config.staleRunSeconds)) {
    console.warn(`reaped stale run ${stale.id}`);
    if (!stale.sandbox_id) continue;
    try {
      await (await Sandbox.connect(stale.sandbox_id, sandboxAuth)).destroy();
    } catch (err) {
      console.warn(`could not destroy sandbox ${stale.sandbox_id}`, err);
    }
  }
}

async function fill(): Promise<void> {
  while (!stopping && active.size < config.maxConcurrentRuns) {
    const run = await claimNextRun(sql, config.workerId);
    if (!run) return;
    console.log(`claimed run ${run.id} (${run.repo_full_name})`);
    const task = handleRun(run)
      .catch((err) => console.error(`run ${run.id} crashed`, err))
      .finally(() => {
        active.delete(task);
        void tick();
      });
    active.add(task);
  }
}

let ticking = false;
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await reap();
    await fill();
  } catch (err) {
    console.error("runner tick failed", err);
  } finally {
    ticking = false;
  }
}

// Poll as a fallback; LISTEN wakes us as soon as the harness queues a run.
const interval = setInterval(() => void tick(), config.pollIntervalMs);
await sql.listen("runs_queued", () => void tick());
void tick();
console.log(`runner ${config.workerId} started (max ${config.maxConcurrentRuns} concurrent runs)`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // Stop claiming; in-flight runs keep heartbeating until they finish or the
    // container is killed, after which the reaper on another replica fails them.
    stopping = true;
    clearInterval(interval);
    await Promise.allSettled(active);
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
