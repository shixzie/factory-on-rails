import { intEnv, listEnv, optionalEnv, parseEncryptionKey, pemFromEnv, requireEnv } from "@factory/core";

export interface HarnessConfig {
  port: number;
  /** Public origin, e.g. https://harness-production.up.railway.app. Used for OAuth redirects and origin checks. */
  publicUrl: string;
  databaseUrl: string;
  github: {
    appId: string;
    appSlug: string;
    clientId: string;
    clientSecret: string;
    privateKeyPem: string;
  };
  encryptionKey: Buffer;
  /** GitHub logins allowed to sign in. Empty means nobody: the harness is closed by default. */
  allowedLogins: string[];
  sessionTtlSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HarnessConfig {
  // On Railway, fall back to the service's generated domain.
  const port = intEnv("PORT", 3000, env);
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const publicUrl = optionalEnv("PUBLIC_URL", railwayDomain ? `https://${railwayDomain}` : `http://localhost:${port}`, env);

  return {
    port,
    publicUrl: publicUrl.replace(/\/$/, ""),
    databaseUrl: requireEnv("DATABASE_URL", env),
    github: {
      appId: requireEnv("GITHUB_APP_ID", env),
      appSlug: requireEnv("GITHUB_APP_SLUG", env),
      clientId: requireEnv("GITHUB_APP_CLIENT_ID", env),
      clientSecret: requireEnv("GITHUB_APP_CLIENT_SECRET", env),
      privateKeyPem: pemFromEnv("GITHUB_APP_PRIVATE_KEY", env),
    },
    encryptionKey: parseEncryptionKey(requireEnv("TOKEN_ENCRYPTION_KEY", env)),
    allowedLogins: listEnv("ALLOWED_GITHUB_LOGINS", env),
    sessionTtlSeconds: intEnv("SESSION_TTL_SECONDS", 7 * 24 * 3600, env),
  };
}
