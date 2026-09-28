import { Api, snapshotsConfig, type AgentId, type SandboxSnapshot } from "@factory/core";
import { Config, Context, Duration, Effect, Layer, Option } from "effect";
import { hostname } from "node:os";

export const DEFAULT_AGENT_SETUP = "command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code";
/**
 * Claude Code in headless mode, streaming JSON so the run page can show each
 * message and tool call, with the factory's ask-the-user tool and inbox hook
 * (see agent-tools.ts). On a later turn in the same sandbox FACTORY_CONTINUE
 * is set, and it continues its earlier session. Subagents' own prose and
 * thinking are forwarded too when the installed CLI supports it, so the run
 * page can show what each one is doing. Any CLI that edits the working tree
 * works as AGENT_COMMAND; plain text output is shown as a log.
 */
export const DEFAULT_AGENT_COMMAND = [
  'claude ${FACTORY_CONTINUE:+--continue} -p "$(cat "$FACTORY_TASK_FILE")"',
  "--dangerously-skip-permissions",
  "--output-format stream-json --verbose",
  "$(claude --help 2>/dev/null | grep -q -- --forward-subagent-text && echo --forward-subagent-text)",
  '--mcp-config "$FACTORY_MCP_CONFIG"',
  '--settings "$FACTORY_SETTINGS_FILE"',
  '--append-system-prompt "$(cat "$FACTORY_SYSTEM_PROMPT_FILE")"',
].join(" ");

export const DEFAULT_CODEX_SETUP = "command -v codex >/dev/null 2>&1 || npm install -g @openai/codex";
/**
 * Codex in non-interactive mode, printing JSON events (see codex-stream.ts).
 * The factory's ask-the-user server, inbox hooks and instructions come in as
 * `-c` overrides, one per line of FACTORY_CODEX_CONFIG (see agent-tools.ts).
 * The task arrives on stdin, so one starting with "-" is never read as a
 * flag. On a later turn in the same sandbox it resumes its last session.
 * Codex's own sandbox and approvals are off: the Railway sandbox is the
 * boundary, as with Claude Code's --dangerously-skip-permissions.
 */
export const DEFAULT_CODEX_COMMAND = [
  "set --",
  'while IFS= read -r line; do if [ -n "$line" ]; then set -- "$@" -c "$line"; fi; done < "$FACTORY_CODEX_CONFIG"',
  [
    "codex exec ${FACTORY_CONTINUE:+resume --last} --json",
    "--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --skip-git-repo-check",
    '"$@" - < "$FACTORY_TASK_FILE"',
  ].join(" "),
].join("\n");

/** How to install and run one agent CLI in a sandbox. */
export interface AgentCommands {
  readonly setupCommand: string;
  readonly command: string;
}

export interface AgentSettings {
  /** Per agent: Claude Code (AGENT_SETUP_COMMAND, AGENT_COMMAND) and Codex (CODEX_SETUP_COMMAND, CODEX_COMMAND). */
  readonly commands: Readonly<Record<AgentId, AgentCommands>>;
  readonly timeoutSec: number;
  /**
   * Extra runner env vars copied into every sandbox. Model API keys do not
   * belong here: each user brings their own (see packages/core/src/providers.ts).
   */
  readonly passthroughEnv: Readonly<Record<string, string>>;
}

export interface RunnerSettings {
  /** Harness origin, used to link PRs back to their run page. */
  readonly harnessUrl: Option.Option<string>;
  readonly workerId: string;
  readonly maxConcurrentRuns: number;
  readonly pollInterval: Duration.Duration;
  /** A run whose heartbeat is older than this is considered abandoned. */
  readonly staleRunSeconds: number;
  /** How often a run records liveness and checks for cancellation. */
  readonly heartbeatInterval: Duration.Duration;
  /** A finished run's sandbox is stopped after this long without activity. */
  readonly sandboxIdleStop: Duration.Duration;
  /** A run with no activity for this many days is deleted, with its sandbox. */
  readonly runRetentionDays: number;
  /** How often idle sandboxes and expired runs are looked for. */
  readonly lifecycleInterval: Duration.Duration;
  readonly agent: AgentSettings;
  /** Sandbox snapshots users may pick, and who may use each (SANDBOX_SNAPSHOTS). */
  readonly snapshots: ReadonlyArray<SandboxSnapshot>;
  readonly git: { readonly authorName: string; readonly authorEmail: string };
}

const int = (name: string, fallback: number) => Config.integer(name).pipe(Config.withDefault(fallback));
const str = (name: string, fallback: string) => Config.string(name).pipe(Config.withDefault(fallback));

/** Reads each variable named in AGENT_ENV_PASSTHROUGH from the runner's own env. */
const passthroughEnv = Effect.gen(function* () {
  const names = (yield* str("AGENT_ENV_PASSTHROUGH", ""))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = yield* Config.option(Config.nonEmptyString(name));
    if (Option.isSome(value)) env[name] = value.value;
    else yield* Effect.logWarning(`AGENT_ENV_PASSTHROUGH names ${name}, but it is not set on the runner`);
  }
  return env;
});

export class RunnerConfig extends Context.Tag("@factory/RunnerConfig")<RunnerConfig, RunnerSettings>() {
  static readonly Live = Layer.effect(
    RunnerConfig,
    Effect.gen(function* () {
      const settings = yield* Config.all({
        harnessUrl: Config.option(Config.nonEmptyString("HARNESS_URL").pipe(Config.map((u) => u.trim().replace(/\/$/, "")))),
        workerId: str("RAILWAY_REPLICA_ID", hostname()),
        maxConcurrentRuns: int("MAX_CONCURRENT_RUNS", 3),
        pollInterval: int("POLL_INTERVAL_MS", 5000).pipe(Config.map(Duration.millis)),
        staleRunSeconds: int("STALE_RUN_SECONDS", 180),
        heartbeatInterval: int("HEARTBEAT_INTERVAL_MS", 10_000).pipe(Config.map(Duration.millis)),
        sandboxIdleStop: int("SANDBOX_IDLE_STOP_MINUTES", Api.SANDBOX_IDLE_STOP_MINUTES).pipe(Config.map(Duration.minutes)),
        runRetentionDays: int("RUN_RETENTION_DAYS", Api.RUN_RETENTION_DAYS),
        lifecycleInterval: int("LIFECYCLE_INTERVAL_MS", 30_000).pipe(Config.map(Duration.millis)),
        agent: Config.all({
          commands: Config.all({
            claude: Config.all({
              setupCommand: str("AGENT_SETUP_COMMAND", DEFAULT_AGENT_SETUP),
              command: str("AGENT_COMMAND", DEFAULT_AGENT_COMMAND),
            }),
            codex: Config.all({
              setupCommand: str("CODEX_SETUP_COMMAND", DEFAULT_CODEX_SETUP),
              command: str("CODEX_COMMAND", DEFAULT_CODEX_COMMAND),
            }),
          }),
          timeoutSec: int("AGENT_TIMEOUT_SECONDS", 3600),
        }),
        git: Config.all({
          authorName: str("GIT_AUTHOR_NAME", "Factory on Rails"),
          authorEmail: str("GIT_AUTHOR_EMAIL", "factory-on-rails@users.noreply.github.com"),
        }),
      });
      const { snapshots, errors } = yield* snapshotsConfig;
      for (const error of errors) yield* Effect.logWarning(`SANDBOX_SNAPSHOTS: ${error}`);
      return { ...settings, snapshots, agent: { ...settings.agent, passthroughEnv: yield* passthroughEnv } };
    }),
  );
}
