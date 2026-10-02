import type { ApiRepo } from "@factory/core/api";

/** A project link must never silently fall back to a different repository. */
export function initialComposerRepo(
  repos: ReadonlyArray<ApiRepo>,
  { requestedRepo, defaultRepo }: { requestedRepo?: string; defaultRepo?: string },
): ApiRepo | undefined {
  const name = requestedRepo ?? defaultRepo;
  const match = repos.find((repo) => repo.fullName.toLowerCase() === name?.toLowerCase());
  return match ?? (requestedRepo === undefined ? repos[0] : undefined);
}
