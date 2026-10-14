import { AGENT_LABELS, type AgentId } from "./api.js";

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
  codex_oauth: {
    label: "ChatGPT subscription",
    description:
      "Codex uses your eligible ChatGPT plan. Run `codex login --device-auth` on your computer, then paste the contents of `~/.codex/auth.json` here.",
    envVar: "CODEX_AUTH_JSON",
    placeholder: '{"auth_mode":"chatgpt","tokens":{...}}',
    helpUrl: "https://developers.openai.com/codex/auth/",
    helpLabel: "Code login instructions",
    multiline: true,
  },
  opencode: {
    label: "OpenCode API key",
    description:
      "OpenCode bills your OpenCode account: pay-as-you-go Zen models, and the Go models when you subscribe to OpenCode Go. The same key covers both.",
    envVar: "OPENCODE_API_KEY",
    placeholder: "sk-...",
    helpUrl: "https://opencode.ai/auth",
    helpLabel: "Get a key",
  },
} as const;

export type ModelProvider = keyof typeof MODEL_PROVIDERS;

export function isModelProvider(value: string): value is ModelProvider {
  return Object.hasOwn(MODEL_PROVIDERS, value);
}

/** Returns an error message, or null when the key looks usable. */
export function validateApiKey(provider: ModelProvider, key: string): string | null {
  if (key.length < 20 || key.length > (provider === "codex_oauth" ? 32_768 : 512)) return "That doesn't look like a complete credential.";
  if (provider !== "codex_oauth" && /\s/.test(key)) return "Keys can't contain spaces or line breaks.";
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
    case "opencode":
      if (key.startsWith("sk-ant-")) return "That is an Anthropic key. Save it as your Anthropic API key instead; OpenCode uses it from there.";
      return null;
    case "codex_oauth": {
      try {
        const auth = JSON.parse(key) as { auth_mode?: unknown; tokens?: { access_token?: unknown; refresh_token?: unknown } };
        if (auth.auth_mode !== "chatgpt" || typeof auth.tokens?.access_token !== "string" || typeof auth.tokens.refresh_token !== "string") {
          return "Paste the complete auth.json created by `codex login --device-auth`.";
        }
        return null;
      } catch {
        return "That is not valid JSON. Paste the contents of ~/.codex/auth.json.";
      }
    }
  }
}

export function keyHint(key: string, provider?: ModelProvider): string {
  if (provider === "codex_oauth") return "login";
  return key.slice(-4);
}

interface AgentSpec {
  readonly label: string;
  /** The saved credentials it reads, best first. */
  readonly providers: ReadonlyArray<ModelProvider>;
  /**
   * Every saved credential goes in, not only the first: the agent picks a
   * provider per model (OpenCode's `provider/model`), so each key is usable.
   */
  readonly allProviders?: boolean;
  /** Where this agent reads a credential, when not the provider's own `envVar`. */
  readonly envVars?: Partial<Record<ModelProvider, string>>;
}

/**
 * The coding agents a run can use, and the saved credentials each one reads,
 * best first. Claude Code and Codex get the first one the user has saved and
 * none of the others: Claude Code prefers an API key over a subscription
 * token, so a saved subscription token must go in alone to be used. OpenCode
 * gets all of its own: an OpenCode key for Zen and Go models, and Anthropic
 * and OpenAI keys for those providers' models.
 */
export const AGENTS = {
  claude: { label: AGENT_LABELS.claude, providers: ["claude_oauth", "anthropic"] },
  codex: { label: AGENT_LABELS.codex, providers: ["codex_oauth", "openai"] },
  opencode: {
    label: AGENT_LABELS.opencode,
    providers: ["opencode", "anthropic", "openai"],
    allProviders: true,
    // OpenCode reads the OpenAI key where the OpenAI SDK does, not where Codex does.
    envVars: { openai: "OPENAI_API_KEY" },
  },
} as const satisfies Record<AgentId, AgentSpec>;

export type { AgentId };

export const DEFAULT_AGENT: AgentId = "claude";

export function isAgentId(value: string): value is AgentId {
  return Object.hasOwn(AGENTS, value);
}

/** The saved credential the agent should use, if the user has one. */
export function agentCredential(agent: AgentId, saved: Iterable<string>): ModelProvider | undefined {
  return agentCredentials(agent, saved)[0];
}

/** Every saved credential that goes into the agent's sandbox, best first. */
export function agentCredentials(agent: AgentId, saved: Iterable<string>): ReadonlyArray<ModelProvider> {
  const have = new Set(saved);
  const spec: AgentSpec = AGENTS[agent];
  const usable = spec.providers.filter((p) => have.has(p));
  return spec.allProviders ? usable : usable.slice(0, 1);
}

/** The env var the agent reads a credential from. */
export function agentEnvVar(agent: AgentId, provider: ModelProvider): string {
  const spec: AgentSpec = AGENTS[agent];
  return spec.envVars?.[provider] ?? MODEL_PROVIDERS[provider].envVar;
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
