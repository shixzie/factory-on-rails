import type { ApiMcpServer, SaveMcpServerBody } from "@factory/core/api";

export type McpFormValues = {
  name: string;
  enabled: boolean;
  transport: "http" | "stdio";
  url: string;
  auth: "none" | "bearer" | "oauth";
  command: string;
  args: string;
  bearerToken: string;
  headers: string;
  env: string;
};

export const mcpFormValues = (server?: ApiMcpServer): McpFormValues => ({
  name: server?.name ?? "",
  enabled: server?.enabled ?? true,
  transport: server?.config.transport ?? "http",
  url: server?.config.transport === "http" ? server.config.url : "",
  auth: server?.config.transport === "http" ? server.config.auth : "none",
  command: server?.config.transport === "stdio" ? server.config.command : "",
  args: server?.config.transport === "stdio" ? JSON.stringify(server.config.args) : "[]",
  bearerToken: "",
  headers: "",
  env: "",
});

/** Credentials are retained only while the server destination stays unchanged. */
export function mcpFormKeepsSecrets(values: McpFormValues, server?: ApiMcpServer): boolean {
  if (!server || values.transport !== server.config.transport) return false;
  if (server.config.transport === "http") {
    return values.url.trim() === server.config.url && values.auth === server.config.auth;
  }
  const config = server.config;
  if (values.command.trim() !== config.command) return false;
  try {
    const args: unknown = JSON.parse(values.args.trim() || "[]");
    return Array.isArray(args) && args.length === config.args.length &&
      args.every((arg, index) => arg === config.args[index]);
  } catch {
    return false;
  }
}

function secretMap(value: string, label: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be a JSON object, for example {"KEY":"value"}.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    Object.values(parsed).some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a JSON object containing only string values.`);
  }
  return parsed as Record<string, string>;
}

/** Empty secret fields keep saved credentials; explicit objects replace their maps. */
export function mcpFormBody(values: McpFormValues): SaveMcpServerBody {
  const common = { name: values.name.trim(), enabled: values.enabled };
  if (values.transport === "http") {
    const headers = secretMap(values.headers, "Headers");
    const bearerToken = values.auth === "bearer" && values.bearerToken.trim() ? values.bearerToken.trim() : undefined;
    return {
      ...common,
      config: { transport: "http", url: values.url.trim(), auth: values.auth },
      ...(headers !== undefined || bearerToken !== undefined ? {
        secrets: { ...(headers !== undefined ? { headers } : {}), ...(bearerToken !== undefined ? { bearerToken } : {}) },
      } : {}),
    };
  }

  let args: unknown;
  try {
    args = JSON.parse(values.args.trim() || "[]");
  } catch {
    throw new Error("Arguments must be a JSON array, for example [\"-y\",\"@example/mcp-server\"].");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("Arguments must be a JSON array containing only strings.");
  }
  const env = secretMap(values.env, "Environment variables");
  return {
    ...common,
    config: { transport: "stdio", command: values.command.trim(), args },
    ...(env !== undefined ? { secrets: { env } } : {}),
  };
}
