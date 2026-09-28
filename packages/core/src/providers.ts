/**
 * Model providers a user can bring their own key for. Each key is injected
 * into that user's sandboxes under `envVar`, which is what the agent CLI reads.
 */
export const MODEL_PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-...",
    consoleUrl: "https://console.anthropic.com/settings/keys",
  },
} as const;

export type ModelProvider = keyof typeof MODEL_PROVIDERS;

export function isModelProvider(value: string): value is ModelProvider {
  return Object.hasOwn(MODEL_PROVIDERS, value);
}

/** Returns an error message, or null when the key looks usable. */
export function validateApiKey(provider: ModelProvider, key: string): string | null {
  if (key.length < 20 || key.length > 512) return "That doesn't look like a complete API key.";
  if (/\s/.test(key)) return "API keys can't contain spaces or line breaks.";
  if (provider === "anthropic" && !key.startsWith("sk-ant-")) return "Anthropic API keys start with sk-ant-.";
  return null;
}

export function keyHint(key: string): string {
  return key.slice(-4);
}
