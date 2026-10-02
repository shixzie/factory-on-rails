import { encodeFrame, Frame } from "@factory/core";
import { EventEmitter } from "node:events";
import http from "node:http";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { Tunnel } from "../src/tunnel.js";

/** A stand-in for the agent's WebSocket: frames the gateway sends are recorded; `deliver` plays the agent's. */
const fakeSocket = () => {
  const ws = Object.assign(new EventEmitter(), {
    sent: [] as Buffer[],
    send: (data: Buffer, _opts: unknown, cb?: () => void) => {
      ws.sent.push(data);
      cb?.();
    },
    ping: () => {},
    close: () => {},
    terminate: () => {},
  });
  const deliver = (type: number, stream: number, payload?: Buffer) => ws.emit("message", encodeFrame(type as never, stream, payload), true);
  return { ws, deliver };
};

describe("tunnel streams", () => {
  it("hand over everything the sandbox sent before it closed the connection", async () => {
    const { ws, deliver } = fakeSocket();
    const tunnel = new Tunnel(ws as unknown as WebSocket, "run", { onPorts: () => {}, onClose: () => {} });
    const opening = tunnel.open(5173);
    deliver(Frame.Opened, 1);
    const stream = await opening;
    // The reader is slow (a browser behind a proxy): nothing is read while the sandbox
    // sends a whole response, ends its side and closes, as a server with Connection: close does.
    stream.pause();
    for (let i = 0; i < 10; i++) deliver(Frame.Data, 1, Buffer.alloc(100_000, i));
    deliver(Frame.End, 1);
    deliver(Frame.Close, 1);
    let received = 0;
    const finished = new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
      stream.on("close", () => setTimeout(resolve, 10));
    });
    stream.on("data", (chunk: Buffer) => (received += chunk.length));
    stream.resume();
    await finished;
    expect(received).toBe(1_000_000);
    tunnel.close();
  });

  it("lets Node's HTTP client finish a response the sandbox sent in full before closing", async () => {
    const { ws, deliver } = fakeSocket();
    const tunnel = new Tunnel(ws as unknown as WebSocket, "run", { onPorts: () => {}, onClose: () => {} });
    const size = 1_000_000;
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({
        path: "/dep.js",
        createConnection: (_opts, cb) => {
          tunnel.open(5173).then((s) => cb(null, s), (err: Error) => cb(err, undefined as never));
          return undefined;
        },
      });
      req.on("response", resolve);
      req.on("error", reject);
      req.end();
    });
    await new Promise((r) => setImmediate(r));
    deliver(Frame.Opened, 1);
    await new Promise((r) => setImmediate(r));
    deliver(Frame.Data, 1, Buffer.from(`HTTP/1.1 200 OK\r\ncontent-length: ${size}\r\nconnection: close\r\n\r\n`));
    const res = await response;
    // The browser side is slow, so the proxy stops reading; meanwhile the sandbox
    // sends the rest of the body, ends and closes (the server honoring Connection: close).
    res.pause();
    for (let i = 0; i < 10; i++) deliver(Frame.Data, 1, Buffer.alloc(size / 10, i));
    deliver(Frame.End, 1);
    deliver(Frame.Close, 1);
    let received = 0;
    const outcome = new Promise<string>((resolve) => {
      res.on("end", () => resolve("end"));
      res.on("aborted", () => resolve("aborted"));
      res.on("error", (err) => resolve(`error: ${err.message}`));
    });
    await new Promise((r) => setTimeout(r, 20));
    res.on("data", (chunk: Buffer) => (received += chunk.length));
    res.resume();
    expect(await outcome).toBe("end");
    expect(received).toBe(size);
    tunnel.close();
  });

  it("drops a stream at once when the sandbox resets it", async () => {
    const { ws, deliver } = fakeSocket();
    const tunnel = new Tunnel(ws as unknown as WebSocket, "run", { onPorts: () => {}, onClose: () => {} });
    const opening = tunnel.open(5173);
    deliver(Frame.Opened, 1);
    const stream = await opening;
    stream.pause();
    deliver(Frame.Data, 1, Buffer.alloc(10));
    const failed = new Promise<Error>((resolve) => stream.on("error", resolve));
    deliver(Frame.Close, 1, Buffer.from("ECONNRESET"));
    expect((await failed).message).toBe("ECONNRESET");
    tunnel.close();
  });
});
