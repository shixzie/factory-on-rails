import { githubRequest } from "./http.js";

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  owner: { login: string };
}

export interface GitHubInstallation {
  id: number;
  account: { login: string; type: string } | null;
  repository_selection: "all" | "selected";
}

/** Calls made with a signed-in user's GitHub App user access token. */
export class UserGitHub {
  constructor(private readonly token: string) {}

  viewer(): Promise<GitHubUser> {
    return githubRequest("/user", { token: this.token });
  }

  async installations(): Promise<GitHubInstallation[]> {
    const res = await githubRequest<{ installations: GitHubInstallation[] }>("/user/installations?per_page=100", {
      token: this.token,
    });
    return res.installations;
  }

  /** Repos the user can see *and* the app is installed on, for one installation. */
  async installationRepos(installationId: number): Promise<GitHubRepo[]> {
    const res = await githubRequest<{ repositories: GitHubRepo[] }>(
      `/user/installations/${installationId}/repositories?per_page=100`,
      { token: this.token },
    );
    return res.repositories;
  }

  /** Needs the app's "Administration: write" repository permission. */
  createRepo(input: { name: string; description?: string; private: boolean }): Promise<GitHubRepo> {
    return githubRequest("/user/repos", {
      method: "POST",
      token: this.token,
      body: { ...input, auto_init: true },
    });
  }
}

/** Calls made with a repo-scoped installation token. */
export class RepoGitHub {
  constructor(
    private readonly token: string,
    readonly fullName: string,
  ) {}

  createPullRequest(input: { title: string; body: string; head: string; base: string; draft?: boolean }): Promise<{
    number: number;
    html_url: string;
  }> {
    return githubRequest(`/repos/${this.fullName}/pulls`, { method: "POST", token: this.token, body: input });
  }
}
