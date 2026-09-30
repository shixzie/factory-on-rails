import type { ApiRepo } from "@factory/core/api";
import { describe, expect, it } from "vitest";
import { initialComposerRepo } from "../src/lib/composer-repo.js";

const repos: ReadonlyArray<ApiRepo> = [
  { installationId: 1, fullName: "team/first", defaultBranch: "main", htmlUrl: "https://github.com/team/first", private: false },
  { installationId: 1, fullName: "team/second", defaultBranch: "develop", htmlUrl: "https://github.com/team/second", private: true },
];

describe("composer repository selection", () => {
  it("uses the project from the link ahead of recent repository preferences", () => {
    expect(initialComposerRepo(repos, { requestedRepo: "team/second", defaultRepo: "team/first" })).toBe(repos[1]);
  });

  it("matches GitHub repository names regardless of casing", () => {
    expect(initialComposerRepo(repos, { requestedRepo: "Team/Second" })).toBe(repos[1]);
  });

  it("leaves invalid or inaccessible project links unselected instead of using an unrelated repository", () => {
    for (const requestedRepo of ["team/removed", "", "not-a-repository"]) {
      expect(initialComposerRepo(repos, { requestedRepo, defaultRepo: "team/first" })).toBeUndefined();
    }
    expect(initialComposerRepo([], { requestedRepo: "team/first" })).toBeUndefined();
  });

  it("keeps the recent repository default and fallback for the general composer", () => {
    expect(initialComposerRepo(repos, { defaultRepo: "team/second" })).toBe(repos[1]);
    expect(initialComposerRepo(repos, { defaultRepo: "team/removed" })).toBe(repos[0]);
    expect(initialComposerRepo(repos, {})).toBe(repos[0]);
    expect(initialComposerRepo([], {})).toBeUndefined();
  });
});
