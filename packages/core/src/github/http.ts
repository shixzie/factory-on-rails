export const GITHUB_API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export async function githubRequest<T>(
  path: string,
  init: { method?: string; token?: string; body?: unknown; authScheme?: "token" | "Bearer" } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "factory-on-rails",
  };
  if (init.token) headers.Authorization = `${init.authScheme ?? "Bearer"} ${init.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(path.startsWith("http") ? path : `${GITHUB_API}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (body as { message?: string } | null)?.message ?? res.statusText;
    throw new GitHubError(`GitHub ${init.method ?? "GET"} ${path} failed: ${res.status} ${message}`, res.status, body);
  }
  return body as T;
}
