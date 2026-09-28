import { appendEvents, type RunEventRow, type Sql } from "@factory/core";

type Event = Pick<RunEventRow, "kind" | "message">;

/**
 * Batches run events so streaming agent output becomes a handful of inserts
 * per second rather than one per chunk. Output beyond `maxOutputBytes` is
 * dropped (with one notice) to keep a runaway agent from filling Postgres.
 */
export class LogBuffer {
  private pending: Event[] = [];
  private outputBytes = 0;
  private truncated = false;
  private timer: NodeJS.Timeout;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly sql: Sql,
    private readonly runId: string,
    private readonly maxOutputBytes = 5 * 1024 * 1024,
    flushMs = 1000,
  ) {
    this.timer = setInterval(() => void this.flush(), flushMs);
  }

  push(kind: Event["kind"], message: string): void {
    if (kind === "stdout" || kind === "stderr") {
      if (this.truncated) return;
      this.outputBytes += Buffer.byteLength(message);
      if (this.outputBytes > this.maxOutputBytes) {
        this.truncated = true;
        this.pending.push({ kind: "info", message: "Output limit reached; further agent output is not stored" });
        return;
      }
    }
    this.pending.push({ kind, message });
  }

  flush(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    this.flushing = this.flushing
      .then(() => appendEvents(this.sql, this.runId, batch))
      .catch((err) => console.error(`failed to store events for run ${this.runId}`, err));
    return this.flushing;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}
