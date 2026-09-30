import { HttpClient, HttpClientResponse } from "@effect/platform";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { checkState, readCiChecks } from "../src/github/ci.js";

const sha = "a".repeat(40);
const check = { name: "Tests", status: "completed", conclusion: "success", html_url: "https://github.com/o/r/actions/runs/1" };

const clientFor = (respond: (url: URL) => Response) => HttpClient.make((req) =>
  Effect.sync(() => HttpClientResponse.fromWeb(req, respond(new URL(req.url)))),
);

describe("GitHub CI", () => {
  it("treats every unfinished state as pending and unsuccessful conclusions as failures", () => {
    for (const state of ["queued", "in_progress", "waiting", "requested", "pending"]) expect(checkState(state, null)).toBe("pending");
    for (const result of ["success", "neutral", "skipped"]) expect(checkState("completed", result)).toBe("passed");
    for (const result of [null, "failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"]) expect(checkState("completed", result)).toBe("failed");
  });

  it.effect("paginates checks, workflows and legacy contexts on the requested commit", () =>
    Effect.gen(function* () {
      const requests: URL[] = [];
      const client = clientFor((url) => {
        requests.push(url);
        const first = url.searchParams.get("page") === "1";
        if (url.pathname.endsWith("check-runs")) {
          expect(url.pathname).toContain(`/commits/${sha}/`);
          expect(url.searchParams.get("filter")).toBe("latest");
          return Response.json({ check_runs: first ? Array.from({ length: 100 }, () => check) : [{ ...check, name: "Broken", conclusion: "failure" }] });
        }
        if (url.pathname.endsWith("check-suites")) {
          return Response.json({ check_suites: [{ id: 7, status: "queued", conclusion: null }, { id: 8, status: "completed", conclusion: null }, { id: 9, status: "completed", conclusion: "failure" }] });
        }
        if (url.pathname.endsWith("actions/runs")) {
          expect(url.searchParams.get("head_sha")).toBe(sha);
          const run = { id: 1, name: "CI", status: "queued", conclusion: null, html_url: check.html_url };
          return Response.json({ workflow_runs: first ? Array.from({ length: 100 }, () => run) : [] });
        }
        expect(url.pathname).toContain(`/commits/${sha}/status`);
        return Response.json({ statuses: first ? Array.from({ length: 100 }, () => ({ context: "External", state: "success", target_url: null })) : [
          { context: "Deploy", state: "pending", target_url: null },
          { context: "Lint", state: "error", target_url: null },
        ] });
      });
      const checks = yield* readCiChecks(client, Redacted.make("token"), "o/r", sha);
      expect(requests).toHaveLength(7);
      expect(checks).toHaveLength(305);
      expect(checks).toContainEqual({ name: "Check suite 9", state: "failed", url: null });
      expect(checks).toContainEqual({ name: "Check suite 7", state: "pending", url: null });
      expect(checks).toContainEqual({ name: "Broken", state: "failed", url: check.html_url });
      expect(checks).toContainEqual({ name: "CI", state: "pending", url: check.html_url });
      expect(checks).toContainEqual({ name: "Deploy", state: "pending", url: null });
      expect(checks).toContainEqual({ name: "Lint", state: "failed", url: null });
    }),
  );

  it.effect("propagates permission errors instead of returning an empty check list", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(readCiChecks(clientFor(() => Response.json({ message: "Forbidden" }, { status: 403 })), Redacted.make("token"), "o/r", sha));
      expect(result).toMatchObject({ _tag: "Left", left: { status: 403 } });
    }),
  );
});
