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
