import { afterEach, describe, expect, it, vi } from "vitest";
import { api, runInBrowser } from "../src/lib/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("browser polling requests", () => {
  it("aborts a hung request so polling can reconnect after a deployment", async () => {
    vi.stubGlobal("window", { location: { origin: "https://factory.example" } });
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn((_url: unknown, init: RequestInit) => {
      signal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await runInBrowser(api.runEvents("run-1", "42"), { timeoutMs: 100 });

    expect(result).toMatchObject({ _tag: "Left", left: { code: "network", status: 0 } });
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("thread settlement requests", () => {
  it("posts to the thread's settle endpoint and decodes the saved timestamp", async () => {
    vi.stubGlobal("window", { location: { origin: "https://factory.example" } });
    const fetch = vi.fn(async (_url: unknown, _init: RequestInit) => Response.json({
      id: "run/1", repo: "acme/app", baseBranch: "main", task: "Build something", status: "succeeded",
      branch: null, pullRequestUrl: null, error: null,
      createdAt: "2026-09-01T00:00:00.000Z", startedAt: null, finishedAt: null,
      settledAt: "2026-10-01T00:00:00.000Z",
    }));
    vi.stubGlobal("fetch", fetch);

    const result = await runInBrowser(api.settleRun("run/1"));

    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://factory.example/api/runs/run%2F1/settle");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(result).toMatchObject({ _tag: "Right", right: { settledAt: new Date("2026-10-01T00:00:00.000Z") } });
  });

  it("preserves the server's explanation if a thread can no longer be settled", async () => {
    vi.stubGlobal("window", { location: { origin: "https://factory.example" } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { code: "bad_request", error: "This thread is still active." }, { status: 409 },
    )));

    expect(await runInBrowser(api.settleRun("run-1"))).toMatchObject({
      _tag: "Left", left: { status: 409, message: "This thread is still active." },
    });
  });
});
