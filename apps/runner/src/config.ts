import { hostname } from "node:os";
import { intEnv, optionalEnv, parseEncryptionKey, pemFromEnv, requireEnv } from "@factory/core";

export const DEFAULT_AGENT_SETUP = "command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code";
export const DEFAULT_AGENT_COMMAND = 'claude -p "$(cat "$FACTORY_TASK_FILE")" --dangerously-skip-permissions';

export interface RunnerConfig {
  databaseUrl: string;
  /** Harness origin, used to link PRs back to their run page. */
  harnessUrl?: string;
  workerId: string;
  maxConcurrentRuns: number;
  pollIntervalMs: number;
  /** A run whose heartbeat is older than this is considered abandoned. */
  staleRunSeconds: number;
  github: { appId: string; privateKeyPem: string };
  /** Decrypts users' own API keys (bring your own key). Same key the harness encrypts with. */
  encryptionKey: Buffer;
  sandbox: {
    /**
     * Railway project token for the environment sandboxes live in. Kept
     * separate from RAILWAY_TOKEN so the runner can never touch the
     * environment its own services run in.
     */
    token: string;
    environmentId: string;
    region?: string;
    /** Boot from a named checkpoint (e.g. one with the agent CLI preinstalled) instead of a blank sandbox. */
    checkpoint?: string;
    idleTimeoutMinutes: number;
  };
  agent: {
    setupCommand: string;
    command: string;
    timeoutSec: number;
    /**
     * Extra runner env vars copied into every sandbox. Model API keys do not
     * belong here: each user brings their own (see packages/core/src/providers.ts).
     */
    passthroughEnv: Record<string, string>;
  };
  git: { authorName: string; authorEmail: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const passthroughNames = (env.AGENT_ENV_PASSTHROUGH ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const passthroughEnv: Record<string, string> = {};
  for (const name of passthroughNames) {
    const value = env[name];
    if (value) passthroughEnv[name] = value;
    else console.warn(`AGENT_ENV_PASSTHROUGH names ${name}, but it is not set on the runner`);
  }

  return {
    databaseUrl: requireEnv("DATABASE_URL", env),
    harnessUrl: env.HARNESS_URL?.trim().replace(/\/$/, "") || undefined,
    workerId: optionalEnv("RAILWAY_REPLICA_ID", hostname(), env),
    maxConcurrentRuns: intEnv("MAX_CONCURRENT_RUNS", 3, env),
    pollIntervalMs: intEnv("POLL_INTERVAL_MS", 5000, env),
    staleRunSeconds: intEnv("STALE_RUN_SECONDS", 180, env),
    github: {
      appId: requireEnv("GITHUB_APP_ID", env),
      privateKeyPem: pemFromEnv("GITHUB_APP_PRIVATE_KEY", env),
    },
    encryptionKey: parseEncryptionKey(requireEnv("TOKEN_ENCRYPTION_KEY", env)),
    sandbox: {
      token: requireEnv("RAILWAY_SANDBOX_TOKEN", env),
      environmentId: requireEnv("SANDBOX_ENVIRONMENT_ID", env),
      region: env.SANDBOX_REGION?.trim() || undefined,
      checkpoint: env.SANDBOX_CHECKPOINT?.trim() || undefined,
      idleTimeoutMinutes: intEnv("SANDBOX_IDLE_TIMEOUT_MINUTES", 15, env),
    },
    agent: {
      setupCommand: optionalEnv("AGENT_SETUP_COMMAND", DEFAULT_AGENT_SETUP, env),
      command: optionalEnv("AGENT_COMMAND", DEFAULT_AGENT_COMMAND, env),
      timeoutSec: intEnv("AGENT_TIMEOUT_SECONDS", 3600, env),
      passthroughEnv,
    },
    git: {
      authorName: optionalEnv("GIT_AUTHOR_NAME", "Factory on Rails", env),
      authorEmail: optionalEnv("GIT_AUTHOR_EMAIL", "factory-on-rails@users.noreply.github.com", env),
    },
  };
}
