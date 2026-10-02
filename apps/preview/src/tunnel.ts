/**
 * The gateway's end of one sandbox's tunnel: a WebSocket from the sandbox's
 * preview agent, carrying many TCP streams (see `Frame` in @factory/core).
 * Each stream is a Duplex, so Node's HTTP client can use it as a socket.
 */
import {
  decodeFrame,
  encodeFrame,
  Frame,
  type FrameType,
  type PreviewPort,
} from "@factory/core";
import { Duplex } from "node:stream";
import type { WebSocket } from "ws";

/** Streams one tunnel may hold open at once. */
const MAX_STREAMS = 512;
const PING_MS = 25_000;
/** A tunnel that answers no ping for this long is dropped. */
const DEAD_MS = 75_000;

/** Why a stream could not be opened, as the sandbox's agent reported it. */
export class OpenFailed extends Error {
  constructor(
    readonly port: number,
    readonly reason: string,
  ) {
    super(`Could not connect to port ${port} in the sandbox: ${reason}`);
  }
}

export class TunnelStream extends Duplex {
  /** The agent asked us to stop sending until it drains. */
  private remotePaused = false;
  private held: (() => void) | undefined;
  /** We asked the agent to stop sending. */
  private pausedRemote = false;
  private remoteClosed = false;
  private remoteEnded = false;

  constructor(
    private readonly tunnel: Tunnel,
    readonly id: number,
  ) {
    super({ allowHalfOpen: true });
    // Whoever is using the stream (Node's HTTP client, an upgraded socket)
    // handles its errors; one nobody is using must not crash the gateway.
    this.on("error", () => {});
  }

  // Node's HTTP client calls these on real sockets.
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  setTimeout(_ms: number, cb?: () => void) {
    if (cb) this.once("timeout", cb);
    return this;
  }

  override _write(
    chunk: Buffer,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ) {
    const go = () => this.tunnel.send(Frame.Data, this.id, chunk, cb);
    if (this.remotePaused) this.held = go;
    else go();
  }

  override _final(cb: (err?: Error | null) => void) {
    this.tunnel.send(Frame.End, this.id, undefined, () => cb());
  }

  override _read() {
    if (this.pausedRemote) {
      this.pausedRemote = false;
      this.tunnel.send(Frame.Resume, this.id);
    }
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void) {
    if (!this.remoteClosed) this.tunnel.send(Frame.Close, this.id);
    this.tunnel.forget(this.id);
    cb(err);
  }

  /** @internal Frames from the agent for this stream. */
  receive(type: number, payload: Buffer) {
    if (type === Frame.Data) {
      if (!this.push(payload) && !this.pausedRemote) {
        this.pausedRemote = true;
        this.tunnel.send(Frame.Pause, this.id);
      }
    } else if (type === Frame.End) {
      this.remoteEnded = true;
      this.push(null);
    } else if (type === Frame.Close) {
      this.remoteClosed = true;
      const reason = payload.toString("utf8");
      if (reason) return void this.destroy(new Error(reason));
      // A clean close (the app closed its connection, e.g. after a
      // `Connection: close` response). Whatever it sent may still be buffered
      // here while the reader is paused, and Node's HTTP client treats 'close'
      // before the body is read as an aborted response, so only go once the
      // reader has had it all.
      if (!this.remoteEnded) {
        this.remoteEnded = true;
        this.push(null);
      }
      if (this.readableEnded) this.destroy();
      else this.once("end", () => this.destroy());
    } else if (type === Frame.Pause) {
      this.remotePaused = true;
    } else if (type === Frame.Resume) {
      this.remotePaused = false;
      const held = this.held;
      this.held = undefined;
      held?.();
    }
  }

  /** @internal The tunnel went away. */
  lost() {
    this.remoteClosed = true;
    // A stream the app already finished cleanly lost nothing.
    this.destroy(
      this.remoteEnded
        ? undefined
        : new Error("The sandbox's preview connection closed"),
    );
  }
}

export class Tunnel {
  private readonly streams = new Map<number, TunnelStream>();
  private readonly pending = new Map<
    number,
    { resolve: () => void; reject: (err: Error) => void; port: number }
  >();
  private nextId = 1;
  private lastSeen = Date.now();
  private readonly pinger: ReturnType<typeof setInterval>;
  closed = false;
  ports: ReadonlyArray<PreviewPort> = [];

  constructor(
    private readonly ws: WebSocket,
    readonly runId: string,
    private readonly events: {
      onPorts: (ports: ReadonlyArray<PreviewPort>) => void;
      onClose: () => void;
    },
  ) {
    ws.on("message", (data, isBinary) => {
      this.lastSeen = Date.now();
      if (isBinary)
        this.receive(
          Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]),
        );
    });
    ws.on("pong", () => (this.lastSeen = Date.now()));
    ws.on("ping", () => (this.lastSeen = Date.now()));
    ws.on("close", () => this.shutdown());
    ws.on("error", () => this.shutdown());
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastSeen > DEAD_MS) return ws.terminate();
      ws.ping();
    }, PING_MS);
    this.pinger.unref();
  }

  /** A connection to `localhost:<port>` inside the sandbox. */
  open(port: number, timeoutMs = 15_000): Promise<TunnelStream> {
    if (this.closed)
      return Promise.reject(
        new Error("The sandbox's preview connection closed"),
      );
    if (this.streams.size >= MAX_STREAMS)
      return Promise.reject(new Error("Too many connections to this sandbox"));
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffff_fff0 ? 1 : this.nextId + 1;
    const stream = new TunnelStream(this, id);
    this.streams.set(id, stream);
    return new Promise<TunnelStream>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        stream.destroy();
        reject(new OpenFailed(port, "timed out"));
      }, timeoutMs);
      this.pending.set(id, {
        port,
        resolve: () => {
          clearTimeout(timer);
          resolve(stream);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      this.send(Frame.Open, id, portBuf);
    });
  }

  close(code = 1000, reason = "") {
    this.ws.close(code, reason);
    this.shutdown();
  }

  /** @internal */
  send(
    type: number,
    stream: number,
    payload?: Buffer,
    cb?: (err?: Error) => void,
  ) {
    if (this.closed)
      return cb?.(new Error("The sandbox's preview connection closed"));
    this.ws.send(
      encodeFrame(type as FrameType, stream, payload),
      { binary: true },
      cb,
    );
  }

  /** @internal */
  forget(id: number) {
    this.streams.delete(id);
  }

  private receive(buf: Buffer) {
    const frame = decodeFrame(buf);
    if (!frame) return;
    const { type, stream: id, payload } = frame;
    if (type === Frame.Ports && id === 0) {
      this.ports = parsePorts(payload);
      this.events.onPorts(this.ports);
      return;
    }
    const pending = this.pending.get(id);
    if (pending && type === Frame.Opened) {
      this.pending.delete(id);
      return pending.resolve();
    }
    if (pending && type === Frame.Close) {
      this.pending.delete(id);
      this.streams.get(id)?.receive(type, Buffer.alloc(0));
      return pending.reject(
        new OpenFailed(pending.port, payload.toString("utf8") || "closed"),
      );
    }
    this.streams.get(id)?.receive(type, payload);
  }

  private shutdown() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    for (const p of this.pending.values())
      p.reject(new Error("The sandbox's preview connection closed"));
    this.pending.clear();
    for (const s of [...this.streams.values()]) s.lost();
    this.streams.clear();
    this.events.onClose();
  }
}

/** The agent's port report, keeping only well-formed entries. */
export function parsePorts(payload: Buffer): ReadonlyArray<PreviewPort> {
  try {
    const raw: unknown = JSON.parse(payload.toString("utf8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (p): p is { port: number; process?: unknown } =>
          typeof p?.port === "number" && p.port >= 1 && p.port <= 65535,
      )
      .slice(0, 100)
      .map((p) =>
        typeof p.process === "string" && p.process
          ? { port: p.port, process: p.process.slice(0, 80) }
          : { port: p.port },
      );
  } catch {
    return [];
  }
}
