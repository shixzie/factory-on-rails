/**
 * Files the runner writes into each sandbox so the agent can talk to the user
 * while it works. Everything lives in FACTORY_DIR, outside the repository.
 *
 * - The user's messages arrive as JSON files in `inbox/` (the runner writes
 *   them as the user sends them). Whoever reads a message first moves it to
 *   `delivered/`, so each one reaches the agent exactly once.
 * - `ask-server.mjs` is a tiny MCP server with one tool, `ask_user`. The
 *   agent calls it with a question; it waits for the next inbox message and
 *   returns it as the answer. The run page sees the call (it is an ordinary
 *   tool call in the agent's stream) and shows the question.
 * - `inbox-hook.mjs` is a Claude Code hook (Codex hooks take the same
 *   output). After every tool call it hands the agent any messages the user
 *   sent meanwhile, and when the agent is about to stop with unread messages
 *   it keeps it going.
 * - `opencode-plugin/` does the same for OpenCode 2, which has plugins
 *   rather than hooks: it adds the user's messages to each tool's result and
 *   the factory's instructions to each request, and records each tool as it
 *   starts in `opencode-tools.jsonl`, which the default OPENCODE_COMMAND
 *   prints beside OpenCode's own JSON (that reports a tool only once it is
 *   done, so a question would not show while it waits). The command also
 *   keeps the agent going while messages are unread.
 * - Claude Code reads the server and hooks from `mcp.json` and
 *   `settings.json`; Codex gets them as `-c` config overrides, one per line
 *   of `codex-config`; OpenCode reads `opencode.json`.
 *
 * The scripts are plain Node (the agent CLI is a Node program, so Node is in
 * the sandbox) with no dependencies.
 */
import type { ResolvedMcpServer } from "@factory/core";
import { FACTORY_DIR } from "./plan.js";

export const INBOX_DIR = `${FACTORY_DIR}/inbox`;

/** How long `ask_user` waits for an answer before telling the agent to carry on. */
export const ASK_TIMEOUT_MS = 30 * 60 * 1000;

const files = (dir: string) => ({
  mcpConfig: `${dir}/mcp.json`,
  settings: `${dir}/settings.json`,
  systemPrompt: `${dir}/system-prompt.md`,
  askServer: `${dir}/ask-server.mjs`,
  inboxHook: `${dir}/inbox-hook.mjs`,
  codexConfig: `${dir}/codex-config`,
  opencodeConfig: `${dir}/opencode.json`,
  opencodePlugin: `${dir}/opencode-plugin`,
  opencodeTools: `${dir}/opencode-tools.jsonl`,
  opencodeReply: `${dir}/opencode-reply.mjs`,
});

/** Shared by both scripts: claims unread messages, oldest first. */
const TAKE_MESSAGES = `
import fs from "node:fs";
import path from "node:path";

const dir = process.env.FACTORY_DIR || ${JSON.stringify(FACTORY_DIR)};
const inbox = path.join(dir, "inbox");
const delivered = path.join(dir, "delivered");

function takeMessages() {
  let names = [];
  try {
    names = fs.readdirSync(inbox).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const to = path.join(delivered, name);
    try {
      fs.mkdirSync(delivered, { recursive: true });
      fs.renameSync(path.join(inbox, name), to);
      out.push(JSON.parse(fs.readFileSync(to, "utf8")).text);
    } catch {
      // Another reader claimed it first, or it was not a message.
    }
  }
  return out.filter((t) => typeof t === "string" && t.trim());
}
`;

export const ASK_SERVER_SCRIPT = `${TAKE_MESSAGES}
import readline from "node:readline";

const timeoutMs = Number(process.env.FACTORY_ASK_TIMEOUT_MS) || ${ASK_TIMEOUT_MS};
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tool = {
  name: "ask_user",
  description:
    "Ask the person who started this run a question and wait for their answer. " +
    "Use it only for decisions you cannot reasonably make yourself: an ambiguous requirement, " +
    "a choice between approaches that changes the result, or something only they know. " +
    "Ask one clear question. The call waits until they answer (up to " + Math.round(timeoutMs / 60000) + " minutes).",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, written for the user." },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Optional short answers the user can pick from. They can always write their own.",
      },
    },
    required: ["question"],
  },
};

async function waitForAnswer() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = takeMessages();
    if (messages.length > 0) return "The user answered:\\n\\n" + messages.join("\\n\\n");
    await sleep(1000);
  }
  return "The user did not answer within " + Math.round(timeoutMs / 60000) +
    " minutes. Continue with your best judgment and say what you assumed in your final summary.";
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "factory", version: "1.0.0" },
      },
    });
  } else if (method === "tools/list") {
    send({ id, result: { tools: [tool] } });
  } else if (method === "tools/call") {
    if (!params || params.name !== tool.name) {
      send({ id, error: { code: -32602, message: "Unknown tool" } });
      return;
    }
    send({ id, result: { content: [{ type: "text", text: await waitForAnswer() }] } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else if (id !== undefined && id !== null) {
    send({ id, error: { code: -32601, message: "Method not found: " + method } });
  }
});
`;

export const INBOX_HOOK_SCRIPT = `${TAKE_MESSAGES}
const event = process.argv[2];
for await (const _ of process.stdin) {
  // Drain the hook input; the messages are all we need.
}
const messages = takeMessages();
if (messages.length > 0) {
  const text = "The user sent a message while you were working:\\n\\n" + messages.join("\\n\\n");
  if (event === "next") {
    // For an agent without a stop hook: the prompt to continue its session with.
    process.stdout.write(text + "\\n\\nAddress it before you finish.");
  } else if (event === "stop") {
    process.stdout.write(JSON.stringify({ decision: "block", reason: text + "\\n\\nAddress it before you finish." }));
  } else {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
  }
}
`;

/** The line the plugin records when a tool starts; see opencode-stream.ts. */
export const OPENCODE_TOOL_START = "factory_tool_start";
/** The line the default OPENCODE_COMMAND prints after each `opencode run`; see opencode-stream.ts. */
export const OPENCODE_TURN_END = "factory_turn_end";

/**
 * Lines the command prints from `opencode-tools.jsonl` share a pipe with
 * OpenCode's own, so each must be written in one piece: a pipe keeps writes
 * up to 4 KiB whole. A tool whose start doesn't fit shows when it is done.
 */
const MAX_TOOL_START_BYTES = 3500;

/**
 * The factory's OpenCode 2 plugin, on the Promise plugin API (the host
 * provides `@opencode/plugin`). It runs in OpenCode's server process, whose
 * stdio OpenCode uses itself, so it never writes to stdout.
 */
export const OPENCODE_PLUGIN_SCRIPT = `${TAKE_MESSAGES}
import { Plugin } from "@opencode/plugin";

const toolStarts = path.join(dir, "opencode-tools.jsonl");
const systemPrompt = path.join(dir, "system-prompt.md");

export default Plugin.define({
  id: "factory",
  setup: async (ctx) => {
    await ctx.session.hook("context", (request) => {
      const text = fs.readFileSync(systemPrompt, "utf8");
      if (text.trim()) request.system.push({ type: "text", text });
    });
    await ctx.tool.hook("execute.before", (event) => {
      const line = JSON.stringify({
        type: ${JSON.stringify(OPENCODE_TOOL_START)},
        sessionID: event.sessionID,
        callID: event.id,
        tool: event.tool,
        args: event.input,
      }) + "\\n";
      if (Buffer.byteLength(line) <= ${MAX_TOOL_START_BYTES}) fs.appendFileSync(toolStarts, line);
    });
    await ctx.tool.hook("execute.after", (event) => {
      // Only a result with content the model reads can carry the messages; otherwise they wait for the next tool.
      const content = event.status === "completed" ? event.result.content : undefined;
      if (content === undefined) return;
      const messages = takeMessages();
      if (messages.length === 0) return;
      const text = "\\n\\nThe user sent a message while you were working:\\n\\n" + messages.join("\\n\\n");
      event.result = { ...event.result, content: typeof content === "string" ? content + text : [...content, { type: "text", text }] };
    });
  },
});
`;

/**
 * Reads `opencode run --format json` on stdin, writes the last message's text
 * to the file in argv[2] and prints the session's id, for the default
 * OPENCODE_DESCRIBE_COMMAND.
 */
export const OPENCODE_REPLY_SCRIPT = `import fs from "node:fs";
let session = "";
let message = "";
let parts = [];
for (const line of fs.readFileSync(0, "utf8").split("\\n")) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (!session && typeof event.sessionID === "string") session = event.sessionID;
  const part = event.part;
  if (event.type !== "text" || !part || typeof part.text !== "string" || event.sessionID !== session) continue;
  if (part.messageID !== message) {
    message = part.messageID;
    parts = [];
  }
  parts.push(part.text);
}
// Some models leave their reasoning in the reply, ending it with </think>.
if (parts.length > 0) fs.writeFileSync(process.argv[2], parts.join("\\n\\n").replace(/^[\\s\\S]*<\\/think>\\s*/, ""));
process.stdout.write(session);
`;

export const SYSTEM_PROMPT = `You are working unattended in a Factory on Rails sandbox, on a fresh branch of the repository in the current directory. When you finish, the factory commits whatever you changed and opens a pull request, so leave your changes in the working tree and do not push or open a pull request yourself.

Run the repository’s relevant tests, lint, type checks and build before handing work back, and fix anything broken or failing, including failures that predate your changes. After committing and opening the PR, the factory waits for CI on the pushed commit and resumes you with any failures. The factory leaves the agent idle once CI passes or the PR is merged, and stops any automatic repair still in progress. Inspect failure logs, fix the causes and validate the fixes; never disable or weaken checks to make CI green. Report concrete external blockers honestly.

The person who started this run is following along and can talk to you:
- If you need a decision only they can make, call the ask_user tool (from the "factory" MCP server) with one clear question and, when it helps, a few short options. It waits for their answer. Decide everything you reasonably can on your own; don't ask for permission or confirmation.
- They may also send you messages while you work. Those arrive as additional context after a tool call. Follow them.

They can also open any server you run in this sandbox from the run's Preview tab (a web app, an API, Storybook): the factory proxies it to them privately. When a running server would help them check your work, start it in the background so it keeps running after you finish, e.g. \`setsid nohup npm run dev > /tmp/dev.log 2>&1 &\`, listening on any interface or localhost, and tell them the port. They reach it on its own https origin, not on localhost, so don't hard-code localhost URLs into what the page loads.

End with a short summary of what you changed and anything they should check.`;

/** TOML for a string; a JSON string is also a valid TOML basic string. */
const tomlString = (value: string) => JSON.stringify(value).replaceAll("\u007f", "\\u007f");
const tomlMap = (values: Readonly<Record<string, string>>) =>
  `{${Object.entries(values).map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`).join(",")}}`;

/** Names are validated on save as well; never let a saved server replace factory. */
const userServers = (servers: ReadonlyArray<ResolvedMcpServer>) =>
  servers.filter((server) => server.name.toLowerCase() !== "factory" && /^[A-Za-z0-9_-]+$/.test(server.name));

/** Claude Code's config includes HTTP auth headers and stdio env as literal values. */
export function claudeMcpConfig(dir = FACTORY_DIR, servers: ReadonlyArray<ResolvedMcpServer> = []): string {
  return JSON.stringify({ mcpServers: Object.fromEntries([
    ...userServers(servers).map((server) => [server.name, server.transport === "http"
      ? { type: "http", url: server.url, headers: server.headers }
      : { type: "stdio", command: server.command, args: server.args, env: server.env }]),
    ["factory", { type: "stdio", command: "node", args: [files(dir).askServer] }],
  ]) }, null, 2);
}

/**
 * Codex's config overrides, one `-c key=value` per line (the default
 * CODEX_COMMAND reads them into its arguments): the ask_user server with a
 * tool timeout long enough to wait for a person, the inbox hooks, and the
 * factory's instructions as developer instructions. The user's own
 * ~/.codex/config.toml and sign-in (from a sandbox snapshot) still apply.
 */
export function codexConfig(dir = FACTORY_DIR, servers: ReadonlyArray<ResolvedMcpServer> = []): string {
  const f = files(dir);
  const hook = (event: string) => `[{hooks=[{type="command",command=${tomlString(`node ${f.inboxHook} ${event}`)},timeout=30}]}]`;
  return [
    `mcp_servers.factory.command="node"`,
    `mcp_servers.factory.args=[${tomlString(f.askServer)}]`,
    `mcp_servers.factory.tool_timeout_sec=${Math.round(ASK_TIMEOUT_MS / 1000) + 60}`,
    ...userServers(servers).map((server) => {
      // Replace the whole server table so changing transports cannot retain
      // an incompatible command or URL from a snapshot's Codex configuration.
      const fields = server.transport === "http"
        ? `url=${tomlString(server.url)},http_headers=${tomlMap(server.headers)}`
        : `command=${tomlString(server.command)},args=[${server.args.map(tomlString).join(",")}],env=${tomlMap(server.env)}`;
      return `mcp_servers.${server.name}={${fields}}`;
    }),
    `hooks.PostToolUse=${hook("post-tool-use")}`,
    `hooks.Stop=${hook("stop")}`,
    `developer_instructions=${tomlString(SYSTEM_PROMPT)}`,
  ].join("\n") + "\n";
}

/**
 * OpenCode 2's config (OPENCODE_CONFIG, merged over the user's own and the
 * repo's): the factory's plugin, the ask_user server with a timeout long
 * enough to wait for a person, and the user's MCP servers. Code Mode is off
 * for them, so each tool is called by its own name and the run page can tell
 * a question from other tools.
 */
export function opencodeConfig(dir = FACTORY_DIR, servers: ReadonlyArray<ResolvedMcpServer> = []): string {
  const f = files(dir);
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    update: "disable",
    plugins: [`file://${f.opencodePlugin}`],
    mcp: {
      servers: Object.fromEntries([
        ...userServers(servers).map((server) => [server.name, server.transport === "http"
          // OAuth tokens arrive resolved, as headers.
          ? { type: "remote", url: server.url, headers: server.headers, oauth: false, codemode: false }
          : { type: "local", command: [server.command, ...server.args], environment: server.env, codemode: false }]),
        ["factory", { type: "local", command: ["node", f.askServer], codemode: false, timeout: { execution: ASK_TIMEOUT_MS + 60_000 } }],
      ]),
    },
  }, null, 2);
}

/** What the runner writes into the sandbox before the agent starts, as [path, content] pairs. */
export function agentToolFiles(dir = FACTORY_DIR, servers: ReadonlyArray<ResolvedMcpServer> = []): ReadonlyArray<readonly [string, string]> {
  const f = files(dir);
  const hook = (event: string) => ({ type: "command", command: `node ${f.inboxHook} ${event}` });
  return [
    [f.askServer, ASK_SERVER_SCRIPT],
    [f.inboxHook, INBOX_HOOK_SCRIPT],
    [f.systemPrompt, SYSTEM_PROMPT],
    [f.codexConfig, codexConfig(dir, servers)],
    // OpenCode 2 loads a local plugin from a directory.
    [`${f.opencodePlugin}/package.json`, JSON.stringify({ name: "factory-opencode-plugin", private: true, type: "module", exports: "./index.js" }, null, 2)],
    [`${f.opencodePlugin}/index.js`, OPENCODE_PLUGIN_SCRIPT],
    [f.opencodeReply, OPENCODE_REPLY_SCRIPT],
    [f.opencodeConfig, opencodeConfig(dir, servers)],
    [f.mcpConfig, claudeMcpConfig(dir, servers)],
    [
      f.settings,
      JSON.stringify(
        {
          hooks: {
            PostToolUse: [{ matcher: "*", hooks: [hook("post-tool-use")] }],
            Stop: [{ hooks: [hook("stop")] }],
          },
        },
        null,
        2,
      ),
    ],
  ];
}

/** Env for the agent command, so AGENT_COMMAND can point at these files. */
export function agentToolEnv(dir = FACTORY_DIR): Record<string, string> {
  const f = files(dir);
  return {
    FACTORY_DIR: dir,
    FACTORY_MCP_CONFIG: f.mcpConfig,
    FACTORY_SETTINGS_FILE: f.settings,
    FACTORY_SYSTEM_PROMPT_FILE: f.systemPrompt,
    FACTORY_CODEX_CONFIG: f.codexConfig,
    FACTORY_OPENCODE_CONFIG: f.opencodeConfig,
    FACTORY_OPENCODE_TOOLS: f.opencodeTools,
    FACTORY_OPENCODE_REPLY: f.opencodeReply,
    FACTORY_INBOX_HOOK: f.inboxHook,
    // Claude Code gives up on an MCP tool call after this long; ask_user waits for a person.
    MCP_TOOL_TIMEOUT: String(ASK_TIMEOUT_MS + 60_000),
  };
}

/** Env for the describe command: what the default OPENCODE_DESCRIBE_COMMAND reads its reply with. */
export function describeToolEnv(dir = FACTORY_DIR): Record<string, string> {
  return { FACTORY_DIR: dir, FACTORY_OPENCODE_REPLY: files(dir).opencodeReply };
}

/**
 * Drops one user message into the inbox. The text travels in an env var, so
 * it is never quoted into the shell, and the write-then-rename means readers
 * never see a half-written file.
 */
export function deliverMessageScript(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "");
  return [
    "set -eu",
    `mkdir -p ${INBOX_DIR}`,
    `printf '%s' "$FACTORY_MESSAGE" > ${INBOX_DIR}/.${safe}.tmp`,
    `mv ${INBOX_DIR}/.${safe}.tmp ${INBOX_DIR}/${safe}.json`,
  ].join("\n");
}
