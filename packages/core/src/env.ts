/** Reads a required environment variable, failing fast with a clear message. */
export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function optionalEnv(
  name: string,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

export function intEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return value;
}

/** Comma-separated list, trimmed and lower-cased; empty entries dropped. */
export function listEnv(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Railway's variable editor tends to store PEM keys with literal "\n"
 * sequences. Accept either form.
 */
export function pemFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return requireEnv(name, env).replace(/\\n/g, "\n");
}
