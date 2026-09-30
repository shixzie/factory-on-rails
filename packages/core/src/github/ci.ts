import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Effect, Redacted, Schema } from "effect";
import { executeJson, githubRequest } from "./http.js";

export interface CiCheck {
  readonly name: string;
  readonly state: "pending" | "passed" | "failed";
  readonly url: string | null;
}

const Check = Schema.Struct({ name: Schema.String, status: Schema.String, conclusion: Schema.NullOr(Schema.String), html_url: Schema.NullOr(Schema.String) });
const Suite = Schema.Struct({ id: Schema.Number, status: Schema.String, conclusion: Schema.NullOr(Schema.String) });
const Workflow = Schema.Struct({ id: Schema.Number, name: Schema.NullOr(Schema.String), status: Schema.String, conclusion: Schema.NullOr(Schema.String), html_url: Schema.String });
const Status = Schema.Struct({ context: Schema.String, state: Schema.String, target_url: Schema.NullOr(Schema.String) });

/** Neutral and skipped are successful terminal outcomes in GitHub's checks model. */
export const checkState = (status: string, conclusion: string | null): CiCheck["state"] =>
  status !== "completed" ? "pending" : ["success", "neutral", "skipped"].includes(conclusion ?? "") ? "passed" : "failed";

/** Read every page, including legacy statuses and workflows which have not created jobs yet. */
export const readCiChecks = (client: HttpClient.HttpClient, token: Redacted.Redacted<string>, repo: string, sha: string) =>
  Effect.gen(function* () {
    const get = <A, I>(path: string, schema: Schema.Schema<A, I>) =>
      githubRequest("GET", `/repos/${repo}/${path}`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token)),
        executeJson(client, schema),
      );
    const checks: CiCheck[] = [];
    for (let page = 1; ; page++) {
      const result = yield* get(`commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=100&page=${page}`, Schema.Struct({ check_runs: Schema.Array(Check) }));
      checks.push(...result.check_runs.map((c) => ({ name: c.name, state: checkState(c.status, c.conclusion), url: c.html_url })));
      if (result.check_runs.length < 100) break;
    }
    // A third-party suite may be queued before its individual checks exist.
    for (let page = 1; ; page++) {
      const result = yield* get(`commits/${encodeURIComponent(sha)}/check-suites?per_page=100&page=${page}`, Schema.Struct({ check_suites: Schema.Array(Suite) }));
      for (const suite of result.check_suites) {
        // Completed empty suites can have no conclusion and no checks to run.
        if (suite.status === "completed" && suite.conclusion === null) continue;
        const state = checkState(suite.status, suite.conclusion);
        if (state !== "passed") checks.push({ name: `Check suite ${suite.id}`, state, url: null });
      }
      if (result.check_suites.length < 100) break;
    }
    for (let page = 1; ; page++) {
      const result = yield* get(`actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100&page=${page}`, Schema.Struct({ workflow_runs: Schema.Array(Workflow) }));
      checks.push(...result.workflow_runs.map((c) => ({ name: c.name ?? `Workflow ${c.id}`, state: checkState(c.status, c.conclusion), url: c.html_url })));
      if (result.workflow_runs.length < 100) break;
    }
    for (let page = 1; ; page++) {
      // The combined endpoint returns the latest status for each context.
      const result = yield* get(`commits/${encodeURIComponent(sha)}/status?per_page=100&page=${page}`, Schema.Struct({ statuses: Schema.Array(Status) }));
      checks.push(...result.statuses.map((c): CiCheck => ({ name: c.context, state: c.state === "success" ? "passed" : c.state === "pending" ? "pending" : "failed", url: c.target_url })));
      if (result.statuses.length < 100) break;
    }
    return checks;
  });
