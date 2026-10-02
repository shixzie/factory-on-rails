/**
 * The preview agent: a dependency-free Node script the runner starts in every
 * sandbox (see preview.ts for the whole picture). It dials out to the preview
 * gateway over one WebSocket, opens a connection to `localhost:<port>` for
 * each stream the gateway asks for, and reports which ports are listening.
 *
 * It speaks WebSocket itself, over node:tls, so it works on whichever Node the
 * sandbox has (the global WebSocket needs Node 22). It reconnects with backoff
 * forever, re-reading its token each time (the runner rewrites it every turn),
 * and a newer copy replaces an older one, so each turn runs the current script.
 * Running processes don't count as sandbox activity, so it never keeps an idle
 * sandbox alive by itself.
 *
 * Kept as a string (like agent-tools.ts) so the runner can write it into the
 * sandbox; tests run it with node against the real gateway.
 */
export const PREVIEW_AGENT_SCRIPT = String.raw`
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";

const url = new URL(process.env.FACTORY_PREVIEW_URL);
const tokenFile = process.env.FACTORY_PREVIEW_TOKEN_FILE;
const pidFile = process.env.FACTORY_PREVIEW_PID_FILE;
const scanMs = Number(process.env.FACTORY_PREVIEW_SCAN_MS) || 2000;
const reportMs = Number(process.env.FACTORY_PREVIEW_REPORT_MS) || 30000;
// Dial this host:port instead of the URL's own (tests and local development).
const dial = process.env.FACTORY_PREVIEW_CONNECT ? new URL("tcp://" + process.env.FACTORY_PREVIEW_CONNECT) : url;

const OPEN = 1, DATA = 2, END = 3, CLOSE = 4, OPENED = 5, PORTS = 6, PAUSE = 7, RESUME = 8;
const log = (msg) => process.stderr.write(new Date().toISOString() + " " + msg + "\n");

// One agent per sandbox: the newest replaces the one before it.
if (pidFile) {
  try {
    const old = Number(fs.readFileSync(pidFile, "utf8"));
    if (old && old !== process.pid && fs.readFileSync("/proc/" + old + "/cmdline", "utf8").includes("preview-agent")) {
      process.kill(old, "SIGTERM");
    }
  } catch {}
  fs.writeFileSync(pidFile, String(process.pid));
}

// ---- listening ports, from /proc ------------------------------------------------

function listeningSockets() {
  const out = new Map();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== "0A") continue;
      const port = parseInt(cols[1].split(":")[1], 16);
      if (port && !out.has(port)) out.set(port, cols[9]);
    }
  }
  return out;
}

/** Which process owns each listening socket, by inode (best effort). */
function processNames(inodes) {
  const names = new Map();
  if (inodes.size === 0) return names;
  let pids = [];
  try {
    pids = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return names;
  }
  for (const pid of pids) {
    let fds = [];
    try {
      fds = fs.readdirSync("/proc/" + pid + "/fd");
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link = "";
      try {
        link = fs.readlinkSync("/proc/" + pid + "/fd/" + fd);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes.has(m[1]) && !names.has(m[1])) names.set(m[1], describe(pid));
    }
  }
  return names;
}

function describe(pid) {
  try {
    const args = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0").filter(Boolean);
    const base = (s) => s.split("/").pop();
    const bin = base(args[0] || "");
    // "node .../vite/bin/vite.js" reads better as "vite".
    const script = args.slice(1).find((a) => !a.startsWith("-"));
    if (/^(node|bun|deno|python\d*(\.\d+)?|ruby)$/.test(bin) && script) {
      const parts = script.split("/");
      const pkg = parts.lastIndexOf("node_modules");
      const name = pkg >= 0 ? parts.slice(pkg + 1).filter((p) => p !== ".bin") : [];
      if (name[0]) return name[0].startsWith("@") && name[1] ? name[0] + "/" + name[1] : name[0];
      return bin + " " + base(script);
    }
    return bin || fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim();
  } catch {
    return undefined;
  }
}

let lastPorts = "";
let lastReportAt = 0;
function scanPorts(force) {
  const sockets = listeningSockets();
  const key = [...sockets.keys()].sort((a, b) => a - b).join(",");
  // An older gateway can finish clearing metadata after our new connection
  // reports its ports. Periodic reports repair that rolling-deploy race.
  if (key === lastPorts && !force && Date.now() - lastReportAt < reportMs) return;
  lastPorts = key;
  lastReportAt = Date.now();
  const names = processNames(new Set(sockets.values()));
  const ports = [...sockets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([port, inode]) => (names.get(inode) ? { port, process: names.get(inode) } : { port }));
  send(PORTS, 0, Buffer.from(JSON.stringify(ports)));
}

// ---- WebSocket client -------------------------------------------------------------

let sock = null;
let open = false;
let backoff = 1000;
let lastSeen = 0;
const streams = new Map();

function frame(type, stream, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(stream, 1);
  return payload && payload.length ? Buffer.concat([head, payload]) : head;
}

function wsWrite(op, data) {
  if (!sock || !open) return false;
  const len = data.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(6);
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head = Buffer.alloc(8);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(14);
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | op;
  const mask = crypto.randomBytes(4);
  mask.copy(head, head.length - 4);
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = data[i] ^ mask[i & 3];
  sock.write(head);
  return sock.write(body);
}

// While the tunnel's socket is full, stop reading every local connection.
let choked = false;
function send(type, stream, payload) {
  const ok = wsWrite(2, frame(type, stream, payload));
  if (!ok && open && !choked) {
    choked = true;
    for (const s of streams.values()) s.socket.pause();
    sock.once("drain", () => {
      choked = false;
      for (const s of streams.values()) if (!s.remotePaused) s.socket.resume();
    });
  }
}

function openStream(id, port) {
  const s = { socket: null, remotePaused: false, closed: false };
  streams.set(id, s);
  // Tries IPv4 then IPv6; a failure reports the first error (usually ECONNREFUSED).
  let firstError = null;
  const attach = (host, fallback) => {
    const socket = net.connect({ host, port });
    s.socket = socket;
    let connected = false;
    socket.on("connect", () => {
      connected = true;
      send(OPENED, id);
      if (choked) socket.pause();
    });
    socket.on("data", (chunk) => send(DATA, id, chunk));
    socket.on("end", () => send(END, id));
    socket.on("drain", () => send(RESUME, id));
    socket.on("error", (err) => {
      if (!connected && fallback) {
        firstError = err;
        return attach(fallback, null);
      }
      if (!s.closed) {
        const reported = (!connected && firstError) || err;
        s.closed = true;
        streams.delete(id);
        send(CLOSE, id, Buffer.from(reported.code || reported.message || "error"));
      }
    });
    socket.on("close", () => {
      if (s.socket !== socket || s.closed) return;
      s.closed = true;
      streams.delete(id);
      send(CLOSE, id);
    });
  };
  attach("127.0.0.1", "::1");
}

function onMessage(buf) {
  if (buf.length < 5) return;
  const type = buf.readUInt8(0);
  const id = buf.readUInt32BE(1);
  const payload = buf.subarray(5);
  if (type === OPEN) return openStream(id, payload.readUInt16BE(0));
  const s = streams.get(id);
  if (!s || !s.socket) return;
  if (type === DATA) {
    if (!s.socket.write(payload)) send(PAUSE, id);
  } else if (type === END) s.socket.end();
  else if (type === CLOSE) {
    s.closed = true;
    streams.delete(id);
    s.socket.destroy();
  } else if (type === PAUSE) {
    s.remotePaused = true;
    s.socket.pause();
  } else if (type === RESUME) {
    s.remotePaused = false;
    if (!choked) s.socket.resume();
  }
}

function dropAll() {
  for (const s of streams.values()) {
    s.closed = true;
    if (s.socket) s.socket.destroy();
  }
  streams.clear();
}

function connect() {
  let token = "";
  try {
    token = fs.readFileSync(tokenFile, "utf8").trim();
  } catch {}
  const secure = url.protocol === "wss:" || url.protocol === "https:";
  const port = Number(dial.port) || Number(url.port) || (secure ? 443 : 80);
  const key = crypto.randomBytes(16).toString("base64");
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  const s = secure
    ? tls.connect({ host: dial.hostname, port, servername: url.hostname, ALPNProtocols: ["http/1.1"] })
    : net.connect({ host: dial.hostname, port });
  sock = s;
  open = false;
  choked = false;
  let buf = Buffer.alloc(0);
  let fragments = [];
  let status = 0;
  s.once(secure ? "secureConnect" : "connect", () => {
    s.write(
      "GET " + url.pathname + url.search + " HTTP/1.1\r\n" +
        "Host: " + url.host + "\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n" +
        "Authorization: Bearer " + token + "\r\n" +
        "User-Agent: factory-preview-agent\r\n\r\n",
    );
  });
  s.on("data", (chunk) => {
    lastSeen = Date.now();
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!open) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 16384) s.destroy();
        return;
      }
      const head = buf.subarray(0, end).toString("latin1");
      buf = buf.subarray(end + 4);
      status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(head) || [])[1]);
      const accepted = head.split("\r\n").some((l) => /^sec-websocket-accept:/i.test(l) && l.slice(l.indexOf(":") + 1).trim() === accept);
      if (status !== 101 || !accepted) {
        log("The gateway refused the tunnel: " + head.split("\r\n")[0]);
        return s.destroy();
      }
      open = true;
      backoff = 1000;
      log("Connected to " + url.host);
      scanPorts(true);
    }
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80;
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let data = buf.subarray(off, off + len);
      if (masked) {
        const mask = buf.subarray(off - 4, off);
        data = Buffer.from(data.map((b, i) => b ^ mask[i & 3]));
      }
      buf = buf.subarray(off + len);
      if (op === 0x0) {
        fragments.push(data);
        if (fin) {
          onMessage(Buffer.concat(fragments));
          fragments = [];
        }
      } else if (op === 0x1 || op === 0x2) {
        if (fin) onMessage(data);
        else fragments = [data];
      } else if (op === 0x8) {
        wsWrite(0x8, Buffer.alloc(0));
        return s.end();
      } else if (op === 0x9) wsWrite(0xa, data);
    }
  });
  s.on("error", (err) => log("Tunnel error: " + err.message));
  s.on("close", () => {
    if (sock !== s) return;
    const wasOpen = open;
    open = false;
    sock = null;
    dropAll();
    // A refused token waits for the next turn to write a fresh one.
    const wait = status === 401 || status === 403 ? 60000 : backoff;
    backoff = Math.min(backoff * 2, 30000);
    if (wasOpen) log("Disconnected; reconnecting");
    setTimeout(connect, wait);
  });
}

// Pings keep idle proxies from cutting the tunnel; silence means it is dead.
setInterval(() => {
  if (!open) return;
  if (Date.now() - lastSeen > 75000) return sock.destroy();
  wsWrite(0x9, Buffer.alloc(0));
}, 25000);
setInterval(() => open && scanPorts(false), scanMs);
process.on("SIGTERM", () => process.exit(0));
connect();
`;
