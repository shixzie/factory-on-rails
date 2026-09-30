import { GitHubAppApi, GitHubError, type RunRow } from "@factory/core";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Redacted } from "effect";
import { openPullRequest } from "../src/execute.js";
import type { RunLog } from "../src/run-log.js";

const run = { id: "run-1", repo_full_name: "owner/repo", task: "Fix it", base_branch: "main", pull_request_url: null } as RunRow;
const token = Redacted.make("token");
const log: RunLog = { push: () => {}, redact: (s) => s, addSecret: () => {}, info: () => Effect.void, error: () => Effect.void, flush: Effect.void };
const duplicate = new GitHubError({ status: 422, message: "A pull request already exists for owner:factory/run-1." });
const current = { number: 9, html_url: "https://github.com/owner/repo/pull/9" };

const github = (calls: unknown[][], { found = true, error = duplicate }: { found?: boolean; error?: GitHubError } = {}) => ({
  installationToken: () => Effect.succeed(token),
  createPullRequest: () => Effect.fail(error),
  findOpenPullRequest: (_token: Redacted.Redacted<string>, repo: string, refs: { head: string; base: string }) =>
    Effect.sync(() => {
      calls.push(["find", repo, refs]);
      return found ? Option.some(current) : Option.none();
    }),
  updatePullRequest: (_token: Redacted.Redacted<string>, repo: string, number: number) =>
    Effect.sync(() => {
      calls.push(["update", repo, number]);
      return current;
    }),
});

describe("pull request publication recovery", () => {
  it.effect("finds a PR created before the runner could persist its URL", () => Effect.gen(function* () {
    const calls: unknown[][] = [];
    const result = yield* openPullRequest(run, token, "factory/run-1", Option.none(), undefined, log).pipe(
      Effect.provideService(GitHubAppApi, github(calls)),
    );
    expect(result).toEqual({ url: current.html_url, opened: false, updated: false });
    expect(calls).toEqual([["find", "owner/repo", { head: "factory/run-1", base: "main" }]]);
  }));

  it.effect("updates the matching open PR even when the stored URL points to an older PR", () => Effect.gen(function* () {
    const calls: unknown[][] = [];
    const result = yield* openPullRequest(
      { ...run, pull_request_url: "https://github.com/owner/repo/pull/2" }, token, "factory/run-1", Option.none(),
      { title: "Fix it", description: "Fixed" }, log,
    ).pipe(Effect.provideService(GitHubAppApi, github(calls)));
    expect(result).toEqual({ url: current.html_url, opened: false, updated: true });
    expect(calls.at(-1)).toEqual(["update", "owner/repo", 9]);
  }));

  it.effect("keeps the error if no matching open PR exists", () => Effect.gen(function* () {
    const calls: unknown[][] = [];
    const error = yield* Effect.flip(openPullRequest(run, token, "factory/run-1", Option.none(), undefined, log).pipe(
      Effect.provideService(GitHubAppApi, github(calls, { found: false })),
    ));
    expect(error).toBe(duplicate);
    expect(calls).toHaveLength(1);
  }));

  it.effect("does not hide unrelated validation failures", () => Effect.gen(function* () {
    const calls: unknown[][] = [];
    const rejected = new GitHubError({ status: 422, message: "The base branch does not exist." });
    const error = yield* Effect.flip(openPullRequest(run, token, "factory/run-1", Option.none(), undefined, log).pipe(
      Effect.provideService(GitHubAppApi, github(calls, { error: rejected })),
    ));
    expect(error).toBe(rejected);
    expect(calls).toHaveLength(0);
  }));
});
