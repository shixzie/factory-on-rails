import { AGENT_LABELS } from "./api.js";

/**
 * Model providers a user can bring their own key for. Each key is injected
 * into that user's sandboxes under `envVar`, which is what the agent CLI reads.
 */
export const MODEL_PROVIDERS = {
  anthropic: {
    label: "Anthropic API key",
    description: "Claude Code bills your Anthropic Console account.",
    envVar: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-api03-...",
    helpUrl: "https://console.anthropic.com/settings/keys",
    helpLabel: "Get a key",
  },
  claude_oauth: {
    label: "Claude subscription token",
    description:
      "Claude Code uses your Pro, Max, Team or Enterprise plan instead. Run `claude setup-token` on your own machine and paste the token it prints. Used instead of your Anthropic API key when both are saved.",
    envVar: "CLAUDE_CODE_OAUTH_TOKEN",
    placeholder: "sk-ant-oat01-...",
    helpUrl: "https://code.claude.com/docs/en/authentication#generate-a-long-lived-token",
    helpLabel: "How to get one",
  },
  openai: {
    label: "OpenAI API key",
    description: "Codex bills your OpenAI Platform account.",
    // What `codex exec` reads; it takes precedence over a ChatGPT sign-in.
    envVar: "CODEX_API_KEY",
    placeholder: "sk-proj-...",
    helpUrl: "https://platform.openai.com/api-keys",
    helpLabel: "Get a key",
  },
} as const;

export type ModelProvider = keyof typeof MODEL_PROVIDERS;

export function isModelProvider(value: string): value is ModelProvider {
  return Object.hasOwn(MODEL_PROVIDERS, value);
}

/** Returns an error message, or null when the key looks usable. */
export function validateApiKey(provider: ModelProvider, key: string): string | null {
  if (key.length < 20 || key.length > 512) return "That doesn't look like a complete key.";
  if (/\s/.test(key)) return "Keys can't contain spaces or line breaks.";
  switch (provider) {
    case "anthropic":
      if (key.startsWith("sk-ant-oat")) return "That is a subscription token. Save it as your Claude subscription token instead.";
      if (!key.startsWith("sk-ant-")) return "Anthropic API keys start with sk-ant-.";
      return null;
    case "claude_oauth":
      if (!key.startsWith("sk-ant-oat")) return "Subscription tokens from `claude setup-token` start with sk-ant-oat.";
      return null;
    case "openai":
      if (!key.startsWith("sk-")) return "OpenAI API keys start with sk-.";
      return null;
  }
}

export function keyHint(key: string): string {
  return key.slice(-4);
}

/**
 * The coding agents a run can use, and the saved credentials each one reads,
 * best first. A run gets the first one the user has saved and none of the
 * others: Claude Code prefers an API key over a subscription token, so a
 * saved subscription token must go in alone to be used.
 */
export const AGENTS = {
  claude: { label: AGENT_LABELS.claude, providers: ["claude_oauth", "anthropic"] },
  codex: { label: AGENT_LABELS.codex, providers: ["openai"] },
} as const satisfies Record<string, { label: string; providers: ReadonlyArray<ModelProvider> }>;

export type AgentId = keyof typeof AGENTS;

export const DEFAULT_AGENT: AgentId = "claude";

export function isAgentId(value: string): value is AgentId {
  return Object.hasOwn(AGENTS, value);
}

/** The saved credential the agent should use, if the user has one. */
export function agentCredential(agent: AgentId, saved: Iterable<string>): ModelProvider | undefined {
  const have = new Set(saved);
  return AGENTS[agent].providers.find((p) => have.has(p));
}

/**
 * Sandbox snapshots: Railway checkpoints in the sandbox environment that an
 * operator prepared (agent CLIs signed in to an account or subscription,
 * toolchains installed) and declared in SANDBOX_SNAPSHOTS, each with the
 * GitHub logins allowed to start runs from it. A checkpoint can hold
 * someone's credentials, so a user can only pick one declared for them.
 *
 * Format: `name=login|login` entries separated by commas or new lines, with
 * `*` for every signed-in user, e.g. `shixzie-agents=shixzie, node-base=*`.
 */
export interface SandboxSnapshot {
  readonly name: string;
  /** Lower-cased GitHub logins, or `*`. */
  readonly logins: ReadonlyArray<string>;
}

/** Railway checkpoint names the runner takes for stopped runs; never a snapshot. */
const RESERVED = /^run-/;

export function parseSnapshots(raw: string): { snapshots: ReadonlyArray<SandboxSnapshot>; errors: ReadonlyArray<string> } {
  const snapshots: SandboxSnapshot[] = [];
  const errors: string[] = [];
  for (const entry of raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const name = (eq < 0 ? entry : entry.slice(0, eq)).trim();
    const logins = (eq < 0 ? "" : entry.slice(eq + 1))
      .split("|")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!/^[A-Za-z0-9._-]{1,63}$/.test(name) || RESERVED.test(name)) errors.push(`"${name}" is not a usable snapshot name`);
    else if (logins.length === 0) errors.push(`${name} names nobody who may use it (add =login or =*)`);
    else if (snapshots.some((s) => s.name === name)) errors.push(`${name} is listed twice`);
    else snapshots.push({ name, logins });
  }
  return { snapshots, errors };
}

/** The snapshots this GitHub user may start runs from. */
export function snapshotsFor(snapshots: ReadonlyArray<SandboxSnapshot>, login: string): ReadonlyArray<string> {
  const me = login.toLowerCase();
  return snapshots.filter((s) => s.logins.includes("*") || s.logins.includes(me)).map((s) => s.name);
}
