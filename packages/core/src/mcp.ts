import type { McpServerConfig } from "./api.js";

/** Never return this payload through the settings API; it is encrypted at rest. */
export interface McpServerSecrets {
  bearerToken?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  oauth?: {
    clientInformation?: Record<string, unknown>;
    tokens?: Record<string, unknown>;
    codeVerifier?: string;
    expiresAt?: number;
    redirectUri?: string;
    discoveryState?: Record<string, unknown>;
  };
}

export interface McpServerRow {
  id: string;
  user_id: string;
  name: string;
  enabled: boolean;
  config: McpServerConfig;
  secrets_enc: string | null;
  /** Optimistic concurrency protects refreshed credentials from stale edits. */
  revision: number;
  created_at: Date;
  updated_at: Date;
}

export type McpServerInput = Pick<McpServerRow, "name" | "enabled" | "config" | "secrets_enc">;

/** A one-time, expiring OAuth attempt bound to a user and a server revision. */
export interface McpOAuthState {
  state_hash: string;
  user_id: string;
  server_id: string;
  revision: number;
}
