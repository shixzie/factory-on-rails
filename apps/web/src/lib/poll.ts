/** Poll without overlapping requests, and recover if a request rejects during a deploy. */
export function startPolling({
  tick,
  delay,
  retryDelay,
  onError,
}: {
  /** Return the next delay, or false when there is nothing left to poll. */
  tick: () => Promise<number | false>;
  delay: number;
  retryDelay: number;
  onError: () => void;
}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    timer = undefined;
    let next: number | false;
    try {
      next = await tick();
    } catch {
      if (stopped) return;
      onError();
      next = retryDelay;
    }
    if (!stopped && next !== false) timer = setTimeout(run, next);
  };
  timer = setTimeout(run, delay);
  return {
    now: () => {
      // A request is already in flight, or polling has finished.
      if (stopped || timer === undefined) return;
      clearTimeout(timer);
      void run();
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
