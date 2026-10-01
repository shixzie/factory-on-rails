import type { ApiRun } from "@factory/core/api";
import { describe, expect, it } from "vitest";
import { isThreadSettled, sidebarThreads, threadPullRequests, visibleRecentThreads } from "../src/lib/threads.js";

const url = (number: number) => `https://github.com/acme/app/pull/${number}`;
const run = (patch: Partial<ApiRun> = {}): ApiRun => ({
  id: "run", repo: "acme/app", baseBranch: "main", task: "Build something", title: null, titleByUser: false,
  agent: "codex", model: null, reasoningEffort: null, status: "succeeded", branch: "feature", error: null,
  pullRequestUrl: url(1), pullRequestUrls: [url(1)], pullRequests: [{ url: url(1), state: "merged" }],
  createdAt: new Date("2026-09-01T00:00:00Z"), startedAt: null, finishedAt: null, lastActivityAt: null,
  awaitingInput: false, sandboxState: "stopped", previewPorts: null,
  ...patch,
});

describe("thread settlement", () => {
  it("settles only when every linked PR has merged", () => {
    expect(isThreadSettled(run())).toBe(true);
    expect(isThreadSettled(run({
      pullRequestUrls: [url(1), url(2)],
      pullRequests: [{ url: url(1), state: "merged" }, { url: url(2), state: "merged" }],
    }))).toBe(true);
  });

  it.each(["open", "draft", "closed", "unknown"] as const)("keeps a thread with a %s PR visible", (state) => {
    expect(isThreadSettled(run({
      pullRequestUrls: [url(1), url(2)],
      pullRequests: [{ url: url(1), state: "merged" }, { url: url(2), state }],
    }))).toBe(false);
  });

  it("does not mistake missing statuses or no PRs for merged", () => {
    expect(isThreadSettled(run({ pullRequests: [] }))).toBe(false);
    expect(isThreadSettled(run({ pullRequestUrls: [url(1), url(2)] }))).toBe(false);
    expect(isThreadSettled(run({ pullRequestUrl: null, pullRequestUrls: [], pullRequests: [] }))).toBe(false);
  });

  it.each(["queued", "running", "cancelling"] as const)("keeps merged threads visible while %s", (status) => {
    expect(isThreadSettled(run({ status }))).toBe(false);
  });

  it("keeps unanswered questions visible, even if the run has finished", () => {
    expect(isThreadSettled(run({ awaitingInput: true }))).toBe(false);
  });

  it("deduplicates canonical links and includes legacy and newly linked PRs", () => {
    expect(threadPullRequests(run({
      pullRequestUrl: "https://github.com/ACME/APP/pull/1/",
      pullRequestUrls: [url(1), url(2)],
    }))).toEqual([{ url: url(1), state: "merged" }, { url: url(2), state: "unknown" }]);
  });
});

describe("sidebar threads", () => {
  it("promotes every active thread ahead of recent history and puts questions first", () => {
    const active = Array.from({ length: 8 }, (_, index) => run({ id: `active-${index}`, status: "running" }));
    const recent = run({ id: "recent", pullRequests: [], createdAt: new Date("2026-09-30") });
    const question = run({ id: "question", status: "running", awaitingInput: true, repo: "acme/other" });
    const result = sidebarThreads([recent, ...active, question], null);
    expect(result.active.map((r) => r.id)).toEqual(["question", ...active.map((r) => r.id)]);
    expect(result.repos[0]!.recent.map((r) => r.id)).toEqual(["recent"]);
    expect(result.repos[0]!.activeCount).toBe(8);
  });

  it("uses last activity to order history without mutating API data", () => {
    const older = run({ id: "older", pullRequests: [], lastActivityAt: new Date("2026-09-30") });
    const newer = run({ id: "newer", pullRequests: [], createdAt: new Date("2026-09-20") });
    const input = [newer, older];
    expect(sidebarThreads(input, null).repos[0]!.recent.map((r) => r.id)).toEqual(["older", "newer"]);
    expect(input.map((r) => r.id)).toEqual(["newer", "older"]);
  });

  it("keeps the project and its settled history, and reveals a selected settled thread", () => {
    expect(sidebarThreads([run()], null).repos[0]).toMatchObject({ repo: "acme/app", recent: [], settled: [{ id: "run" }] });
    expect(sidebarThreads([run()], "run").repos[0]).toMatchObject({ recent: [{ id: "run" }], settled: [] });
  });

  it("restores a settled thread to Active when follow-up work starts", () => {
    const result = sidebarThreads([run({ status: "queued" })], null);
    expect(result.active.map((r) => r.id)).toEqual(["run"]);
    expect(result.repos[0]!.settled).toEqual([]);
  });

  it("never hides the selected thread behind the recent-history limit", () => {
    const history = Array.from({ length: 10 }, (_, index) => run({ id: String(index) }));
    expect(visibleRecentThreads(history, false, "9").map((r) => r.id)).toEqual(["0", "1", "2", "3", "4", "5", "9"]);
    expect(visibleRecentThreads(history, true, "9")).toHaveLength(10);
  });
});
