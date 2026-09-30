import { afterEach, describe, expect, it, vi } from "vitest";
import { startPolling } from "../src/lib/poll.js";

afterEach(() => vi.useRealTimers());

describe("run activity polling", () => {
  it("retries after a deploy interrupts a request and keeps its event cursor", async () => {
    vi.useFakeTimers();
    let cursor = "10";
    const cursors: string[] = [];
    const onError = vi.fn();
    const tick = vi.fn(async () => {
      cursors.push(cursor);
      if (cursors.length === 1) throw new Error("connection reset");
      cursor = "12";
      return cursors.length === 3 ? false as const : 2_000;
    });
    startPolling({ tick, delay: 0, retryDelay: 2_000, onError });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(cursors).toEqual(["10", "10", "12"]);
    expect(onError).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconnects immediately without making overlapping requests", async () => {
    vi.useFakeTimers();
    let finish!: (value: number) => void;
    const tick = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
    const poll = startPolling({ tick, delay: 15_000, retryDelay: 2_000, onError: vi.fn() });
    poll.now();
    poll.now();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(tick).toHaveBeenCalledOnce();
    finish(15_000);
    await vi.advanceTimersByTimeAsync(0);
    poll.now();
    expect(tick).toHaveBeenCalledTimes(2);
    poll.stop();
    finish(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("does not restart or report an error after the view is removed", async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    const tick = vi.fn(() => new Promise<number>((_resolve, reject) => { fail = reject; }));
    const onError = vi.fn();
    const poll = startPolling({ tick, delay: 0, retryDelay: 2_000, onError });
    await vi.advanceTimersByTimeAsync(0);
    poll.stop();
    fail(new Error("connection reset"));
    poll.now();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onError).not.toHaveBeenCalled();
    expect(tick).toHaveBeenCalledOnce();
  });
});
