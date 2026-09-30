import { Api, GitHubUserApi, Store, TokenCipher, type RunRow } from "@factory/core";
import { Cache, Context, Data, Effect, Layer, Option } from "effect";
import { userAccessToken } from "./auth.js";

class PullRequestKey extends Data.Class<{ userId: string; url: string }> {}
type RunPullRequests = Pick<RunRow, "user_id" | "pull_request_urls" | "pull_request_url">;

/** Short, user-scoped caching keeps sidebar and conversation polling inexpensive. */
export class PullRequestStatuses extends Context.Tag("@factory/PullRequestStatuses")<
  PullRequestStatuses,
  { readonly forRun: (run: RunPullRequests) => Effect.Effect<readonly Api.ApiPullRequest[]> }
>() {
  static readonly Live = Layer.effect(
    PullRequestStatuses,
    Effect.gen(function* () {
      const github = yield* GitHubUserApi;
      const store = yield* Store;
      const cipher = yield* TokenCipher;
      // Shared across requests, so a large sidebar or several tabs never floods GitHub.
      const slots = yield* Effect.makeSemaphore(6);
      const tokens = yield* Cache.make({
        capacity: 1000,
        timeToLive: "30 seconds",
        lookup: (userId: string) => Effect.gen(function* () {
          const user = yield* store.getUser(userId);
          if (Option.isNone(user)) return null;
          return yield* userAccessToken(user.value).pipe(
            Effect.provideService(GitHubUserApi, github),
            Effect.provideService(Store, store),
            Effect.provideService(TokenCipher, cipher),
          );
        }).pipe(Effect.timeout("3 seconds"), Effect.orElseSucceed(() => null)),
      });
      const states = yield* Cache.make({
        capacity: 5000,
        timeToLive: "30 seconds",
        lookup: ({ userId, url }: PullRequestKey) => Effect.gen(function* () {
          const match = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/pull\/([1-9]\d*)$/.exec(url);
          if (!match || !Number.isSafeInteger(Number(match[2]))) return "unknown" as const;
          const token = yield* tokens.get(userId);
          if (!token) return "unknown" as const;
          const pr = yield* github.pullRequest(token, match[1]!, Number(match[2]));
          return pr.merged ? "merged" as const : pr.state === "closed" ? "closed" as const : pr.draft ? "draft" as const : "open" as const;
        }).pipe(
          slots.withPermits(1),
          // Include time spent waiting for a slot: even a large list answers promptly.
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed(() => "unknown" as const),
        ),
      });
      return {
        forRun: (run) => {
          const urls = [...new Set([
            ...run.pull_request_urls,
            ...(run.pull_request_url ? [run.pull_request_url] : []),
          ].map((url) => url.toLowerCase().replace(/\/$/, "")))];
          return Effect.forEach(urls, (url) => Effect.map(
            states.get(new PullRequestKey({ userId: run.user_id, url })),
            (state) => ({ url, state }),
          ), { concurrency: "unbounded" });
        },
      };
    }),
  );
}
