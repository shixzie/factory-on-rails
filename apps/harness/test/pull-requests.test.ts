import { describe, expect, it } from "@effect/vitest";
import { Api, GitHubError, GitHubUserApi, Store, TokenCipher, type PullRequestState, type StoreService, type UserRow } from "@factory/core";
import { Effect, Fiber, Layer, Option, Schema, TestClock } from "effect";
import { PullRequestStatuses } from "../src/pull-requests.js";

const cipher = TokenCipher.fromKey(Buffer.alloc(32, 7));
const user = (id: string): UserRow => ({
  id, github_id: id, github_login: id, name: null, avatar_url: null,
  access_token_enc: cipher.encrypt(`token-${id}`), access_token_expires_at: null,
  refresh_token_enc: null, refresh_token_expires_at: null, sandbox_snapshot: null,
});
const url = (number: number) => `https://github.com/o/r/pull/${number}`;
const run = (numbers: number[], userId = "one") => ({
  user_id: userId, pull_request_url: null, pull_request_urls: numbers.map(url),
});
const pr = (number: number, state: "open" | "closed", merged = false, draft = false): PullRequestState => ({
  number, html_url: url(number), state, merged, draft, head: { sha: "abc" },
});
const services = (read: GitHubUserApi["Type"]["pullRequest"]) => PullRequestStatuses.Live.pipe(
  Layer.provide(Layer.succeed(GitHubUserApi, { pullRequest: read } as GitHubUserApi["Type"])),
  Layer.provide(Layer.succeed(Store, { getUser: (id: string) => Effect.succeed(Option.some(user(id))) } as unknown as StoreService)),
  Layer.provide(Layer.succeed(TokenCipher, cipher)),
);

describe("pull request statuses", () => {
  it.effect("reads every linked PR with the user's token and keeps closed or unreadable PRs unmerged", () => {
    const calls: Array<[string, string, number]> = [];
    return Effect.gen(function* () {
      const statuses = yield* PullRequestStatuses;
      const result = yield* statuses.forRun({ ...run([1, 2, 3, 4, 5]), pull_request_url: url(1).toUpperCase() });
      expect(result).toEqual([
        { url: url(1), state: "open" }, { url: url(2), state: "draft" },
        { url: url(3), state: "closed" }, { url: url(4), state: "merged" },
        { url: url(5), state: "unknown" },
      ]);
      expect(calls).toHaveLength(5);
      expect(calls.every(([token, repo]) => token === "token-one" && repo === "o/r")).toBe(true);
      expect(yield* statuses.forRun(run([]))).toEqual([]);
      expect(yield* statuses.forRun({ ...run([]), pull_request_url: "https://github.com.evil/o/r/pull/1" })).toEqual([
        { url: "https://github.com.evil/o/r/pull/1", state: "unknown" },
      ]);
      expect(calls).toHaveLength(5);
    }).pipe(Effect.provide(services((token, repo, number) => Effect.suspend(() => {
      calls.push([token, repo, number]);
      return number === 5
        ? Effect.fail(new GitHubError({ status: 403, message: "Forbidden" }))
        : Effect.succeed(pr(number, number >= 3 ? "closed" : "open", number === 4, number === 2));
    }))));
  });

  it.effect("shares lookups across threads, scopes cached answers to the user, and refreshes after 30 seconds", () => {
    let calls = 0;
    let merged = false;
    return Effect.gen(function* () {
      const statuses = yield* PullRequestStatuses;
      const initial = yield* Effect.all([statuses.forRun(run([1])), statuses.forRun(run([1]))], { concurrency: "unbounded" });
      expect(initial.every((value) => value[0]?.state === "open")).toBe(true);
      expect(calls).toBe(1);
      expect((yield* statuses.forRun(run([1], "two")))[0]?.state).toBe("unknown");
      expect(calls).toBe(2);
      merged = true;
      yield* TestClock.adjust("29 seconds");
      expect((yield* statuses.forRun(run([1])))[0]?.state).toBe("open");
      expect(calls).toBe(2);
      yield* TestClock.adjust("2 seconds");
      expect((yield* statuses.forRun(run([1])))[0]?.state).toBe("merged");
      expect(calls).toBe(3);
    }).pipe(Effect.provide(services((token, _repo, number) => Effect.suspend(() => {
      calls++;
      return token === "token-two"
        ? Effect.fail(new GitHubError({ status: 404, message: "Not found" }))
        : Effect.succeed(pr(number, merged ? "closed" : "open", merged));
    }))));
  });

  it.effect("limits concurrent GitHub calls across requests and includes queued lookups in the timeout", () => {
    let current = 0;
    let maximum = 0;
    return Effect.gen(function* () {
      const statuses = yield* PullRequestStatuses;
      const pending = yield* Effect.fork(Effect.all([
        statuses.forRun(run([1, 2, 3, 4, 5, 6])),
        statuses.forRun(run([7, 8, 9, 10, 11, 12])),
      ], { concurrency: "unbounded" }));
      yield* TestClock.adjust("1 second");
      expect(current).toBe(6);
      expect(maximum).toBe(6);
      yield* TestClock.adjust("3 seconds");
      const result = (yield* Fiber.join(pending)).flat();
      expect(result).toHaveLength(12);
      expect(result.every((value) => value.state === "unknown")).toBe(true);
      expect(current).toBe(0);
      expect(maximum).toBe(6);
    }).pipe(Effect.provide(services(() => Effect.acquireUseRelease(
      Effect.sync(() => { current++; maximum = Math.max(maximum, current); }),
      () => Effect.never,
      () => Effect.sync(() => { current--; }),
    ))));
  });

  it("decodes older run responses without PR states", () => {
    const decoded = Schema.decodeUnknownSync(Api.ApiRun)({
      id: "run", repo: "o/r", baseBranch: "main", task: "task", status: "succeeded",
      branch: null, pullRequestUrl: url(1), error: null,
      createdAt: new Date(0).toISOString(), startedAt: null, finishedAt: null,
    });
    expect(decoded.pullRequests).toEqual([]);
  });
});
