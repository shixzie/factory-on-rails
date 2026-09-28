import { createSign } from "node:crypto";
import { githubRequest } from "./http.js";

export interface GitHubAppCredentials {
  appId: string;
  privateKeyPem: string;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Signs the short-lived RS256 JWT a GitHub App uses to authenticate as itself.
 * Backdated 60s for clock drift; GitHub caps lifetime at 10 minutes.
 */
export function createAppJwt(creds: GitHubAppCredentials, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: creds.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(creds.privateKeyPem))}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

/**
 * Mints an installation access token, optionally narrowed to specific repos
 * and permissions. Agents only ever see tokens scoped to the one repo they
 * work on, valid for an hour.
 */
export async function createInstallationToken(
  creds: GitHubAppCredentials,
  installationId: number,
  scope: { repositories?: string[]; permissions?: Record<string, "read" | "write"> } = {},
): Promise<InstallationToken> {
  const res = await githubRequest<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST", token: createAppJwt(creds), body: scope },
  );
  return { token: res.token, expiresAt: res.expires_at };
}
