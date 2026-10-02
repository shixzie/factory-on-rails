/**
 * GitHub App manifests: the setup page posts one to GitHub, the person
 * confirms the App there, and GitHub hands back a code that converts into the
 * App's credentials (`GitHubUserApi.convertManifest`). Nobody copies a secret.
 * https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */

/** Where GitHub sends the person back with the code. Under /auth so the web app forwards it to the harness. */
export const MANIFEST_CALLBACK_PATH = "/auth/setup/github-app";

/**
 * The factory's App. Contents, pull requests and workflows let agents push
 * branches (including workflow files) and open PRs. Administration is what
 * lets a user token create repositories (`POST /user/repos`); GitHub's
 * narrower "Repository creation" permission can replace it in the App's
 * settings where the account offers it. Webhooks stay off: nothing listens.
 */
export function appManifest(publicUrl: string, name: string) {
  return {
    name,
    url: publicUrl,
    description: "Factory on Rails: coding agents that work in Railway sandboxes and open pull requests.",
    public: false,
    redirect_url: `${publicUrl}${MANIFEST_CALLBACK_PATH}`,
    callback_urls: [`${publicUrl}/auth/callback`],
    setup_url: `${publicUrl}/setup`,
    request_oauth_on_install: false,
    hook_attributes: { url: `${publicUrl}/api/github/webhook`, active: false },
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      workflows: "write",
      administration: "write",
      metadata: "read",
      checks: "read",
      statuses: "read",
      actions: "read",
    },
    default_events: [],
  };
}

/** The form action that registers a manifest, for a personal account or an organization. */
export function manifestFormUrl(state: string, organization?: string): string {
  const path = organization
    ? `/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : "/settings/apps/new";
  const url = new URL(path, "https://github.com");
  url.searchParams.set("state", state);
  return url.toString();
}
