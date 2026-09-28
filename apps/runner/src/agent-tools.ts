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
 * - `inbox-hook.mjs` is a Claude Code hook. After every tool call it hands
 *   the agent any messages the user sent meanwhile, and when the agent is
 *   about to stop with unread messages it keeps it going.
 *
 * The scripts are plain Node (the agent CLI is a Node program, so Node is in
 * the sandbox) with no dependencies.
 */
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
  if (event === "stop") {
    process.stdout.write(JSON.stringify({ decision: "block", reason: text + "\\n\\nAddress it before you finish." }));
  } else {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
  }
}
`;

export const SYSTEM_PROMPT = `You are working unattended in a Factory on Rails sandbox, on a fresh branch of the repository in the current directory. When you finish, the factory commits whatever you changed and opens a pull request, so leave your changes in the working tree and do not push or open a pull request yourself.

The person who started this run is following along and can talk to you:
- If you need a decision only they can make, call the ask_user tool (mcp__factory__ask_user) with one clear question and, when it helps, a few short options. It waits for their answer. Decide everything you reasonably can on your own; don't ask for permission or confirmation.
- They may also send you messages while you work. Those arrive as additional context after a tool call. Follow them.

They can also open any server you run in this sandbox from the run's Preview tab (a web app, an API, Storybook): the factory proxies it to them privately. When a running server would help them check your work, start it in the background so it keeps running after you finish, e.g. \`setsid nohup npm run dev > /tmp/dev.log 2>&1 &\`, listening on any interface or localhost, and tell them the port. They reach it on its own https origin, not on localhost, so don't hard-code localhost URLs into what the page loads.

End with a short summary of what you changed and anything they should check.`;

/** What the runner writes into the sandbox before the agent starts, as [path, content] pairs. */
export function agentToolFiles(dir = FACTORY_DIR): ReadonlyArray<readonly [string, string]> {
  const f = files(dir);
  const hook = (event: string) => ({ type: "command", command: `node ${f.inboxHook} ${event}` });
  return [
    [f.askServer, ASK_SERVER_SCRIPT],
    [f.inboxHook, INBOX_HOOK_SCRIPT],
    [f.systemPrompt, SYSTEM_PROMPT],
    [f.mcpConfig, JSON.stringify({ mcpServers: { factory: { type: "stdio", command: "node", args: [f.askServer] } } }, null, 2)],
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
    // Claude Code gives up on an MCP tool call after this long; ask_user waits for a person.
    MCP_TOOL_TIMEOUT: String(ASK_TIMEOUT_MS + 60_000),
  };
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
