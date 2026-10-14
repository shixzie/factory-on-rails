import { execFile, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ResolvedMcpServer } from "@factory/core";
import { agentToolEnv, agentToolFiles, deliverMessageScript, describeToolEnv, SYSTEM_PROMPT } from "../src/agent-tools.js";
import {
  DEFAULT_AGENT_COMMAND,
  DEFAULT_AGENT_DESCRIBE_COMMAND,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_CODEX_DESCRIBE_COMMAND,
  DEFAULT_OPENCODE_COMMAND,
  DEFAULT_OPENCODE_DESCRIBE_COMMAND,
} from "../src/config.js";

/** Writes the agent tools into a temp dir, as the runner does in the sandbox. */
function setup(servers: ReadonlyArray<ResolvedMcpServer> = []) {
  const dir = mkdtempSync(join(tmpdir(), "factory-"));
  for (const [path, content] of agentToolFiles(dir, servers)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  mkdirSync(join(dir, "inbox"));
  const send = (name: string, text: string) => writeFileSync(join(dir, "inbox", `${name}.json`), JSON.stringify({ text }));
  return { dir, send, env: {
    ...process.env, ...agentToolEnv(dir),
    FACTORY_MODEL: "", FACTORY_REASONING_EFFORT: "", FACTORY_CODEX_EFFORT: "",
  } };
}

const run = promisify(execFile);

/** Runs the hook like Claude Code does: hook input on stdin, JSON decision on stdout. */
const hook = (dir: string, env: NodeJS.ProcessEnv, event: string) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn("node", [join(dir, "inbox-hook.mjs"), event], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out));
    child.stdin.end(JSON.stringify({ hook_event_name: event }));
  });

describe("agent tools", () => {
  it("passes saved HTTP and stdio MCP servers to both agents without evaluating their values", async () => {
    const token = 'secret-"value"\\path\n$(touch /tmp/factory-mcp-injected)';
    const servers: ReadonlyArray<ResolvedMcpServer> = [
      { name: "docs-api", transport: "http", url: "https://mcp.example.com/tools", headers: { Authorization: `Bearer ${token}`, "X-Region": "us-east" } },
      { name: "local_tools", transport: "stdio", command: "npx", args: ["-y", "example-mcp", "--path", "a path $(echo bad)"], env: { API_KEY: token } },
      { name: "factory", transport: "http", url: "https://invalid.example.com", headers: {} },
    ];
    const { dir, env } = setup(servers);
    const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers["docs-api"]).toEqual({ type: "http", url: servers[0]!.transport === "http" ? servers[0]!.url : "", headers: { Authorization: `Bearer ${token}`, "X-Region": "us-east" } });
    expect(mcp.mcpServers.local_tools).toEqual({ type: "stdio", command: "npx", args: ["-y", "example-mcp", "--path", "a path $(echo bad)"], env: { API_KEY: token } });
    expect(mcp.mcpServers.factory).toEqual({ type: "stdio", command: "node", args: [join(dir, "ask-server.mjs")] });

    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), '#!/usr/bin/env node\nprocess.stdin.resume(); console.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
    const task = join(dir, "task.md");
    writeFileSync(task, "Use saved MCP tools");
    const { stdout } = await run("sh", ["-c", DEFAULT_CODEX_COMMAND], { env: { ...env, PATH: `${bin}:${process.env.PATH}`, FACTORY_TASK_FILE: task } });
    const args = JSON.parse(stdout) as string[];
    const overrides = args.filter((_, index) => args[index - 1] === "-c");
    expect(overrides).toContain(`mcp_servers.docs-api={url="https://mcp.example.com/tools",http_headers={"Authorization"=${JSON.stringify(`Bearer ${token}`)},"X-Region"="us-east"}}`);
    expect(overrides).toContain(`mcp_servers.local_tools={command="npx",args=["-y","example-mcp","--path","a path $(echo bad)"],env={"API_KEY"=${JSON.stringify(token)}}}`);
    expect(overrides.join("\n")).not.toContain("https://invalid.example.com");

    const opencode = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
    const opencodeServers = opencode.mcp.servers;
    expect(opencodeServers["docs-api"]).toEqual({ type: "remote", url: "https://mcp.example.com/tools", headers: { Authorization: `Bearer ${token}`, "X-Region": "us-east" }, oauth: false, codemode: false });
    expect(opencodeServers.local_tools).toEqual({ type: "local", command: ["npx", "-y", "example-mcp", "--path", "a path $(echo bad)"], environment: { API_KEY: token }, codemode: false });
    expect(opencodeServers.factory).toEqual({ type: "local", command: ["node", join(dir, "ask-server.mjs")], codemode: false, timeout: { execution: 1_860_000 } });
  });

  it("gives Codex the MCP server, the hooks and the instructions as one -c override each", async () => {
    const { dir, env } = setup();
    // A stand-in `codex` that prints its arguments and the prompt it got on stdin.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env node\nlet stdin = "";\nprocess.stdin.on("data", (d) => (stdin += d)).on("end", () => console.log(JSON.stringify({ args: process.argv.slice(2), stdin })));\n`,
      { mode: 0o755 },
    );
    const task = join(dir, "TASK.md");
    writeFileSync(task, "- a task that starts with a dash");
    let output: string[] = [];
    const invoke = async (extra: Record<string, string> = {}) => {
      const { stdout } = await run("sh", ["-c", DEFAULT_CODEX_COMMAND], {
        env: { ...env, FACTORY_CONTINUE: "", ...extra, PATH: `${bin}:${process.env.PATH}`, FACTORY_TASK_FILE: task },
      });
      return JSON.parse(stdout) as { args: string[]; stdin: string };
    };

    const first = await invoke();
    expect(first.stdin).toBe("- a task that starts with a dash");
    expect(first.args.slice(0, 5)).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "--skip-git-repo-check",
    ]);
    expect(first.args.at(-1)).toBe("-");
    const overrides = first.args.filter((_, i) => first.args[i - 1] === "-c");
    expect(overrides).toContain('mcp_servers.factory.command="node"');
    expect(overrides).toContain(`mcp_servers.factory.args=[${JSON.stringify(join(dir, "ask-server.mjs"))}]`);
    expect(overrides).toContain("mcp_servers.factory.tool_timeout_sec=1860");
    expect(overrides).toContain(`hooks.Stop=[{hooks=[{type="command",command=${JSON.stringify(`node ${join(dir, "inbox-hook.mjs")} stop`)},timeout=30}]}]`);
    const instructions = overrides.find((o) => o.startsWith("developer_instructions="))!;
    expect(JSON.parse(instructions.slice("developer_instructions=".length))).toBe(SYSTEM_PROMPT);

    const later = await invoke({ FACTORY_CONTINUE: "1" });
    expect(later.args.slice(0, 4)).toEqual(["exec", "resume", "--last", "--json"]);
  });

  it.each([
    ["claude", DEFAULT_AGENT_COMMAND],
    ["codex", DEFAULT_CODEX_COMMAND],
    ["opencode", DEFAULT_OPENCODE_COMMAND],
    ["claude", DEFAULT_AGENT_DESCRIBE_COMMAND],
    ["codex", DEFAULT_CODEX_DESCRIBE_COMMAND],
    ["opencode", DEFAULT_OPENCODE_DESCRIBE_COMMAND],
  ])("passes model and effort as single arguments to %s: %s", async (agent, command) => {
    const { dir, env } = setup();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const capture = join(dir, "args.json");
    writeFileSync(join(bin, agent), `#!/usr/bin/env node
const fs = require("node:fs");
if (!process.argv.includes("--help")) fs.writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));
if (process.argv.includes("-")) process.stdin.resume();
`, { mode: 0o755 });
    const task = join(dir, "task.md");
    writeFileSync(task, "Task");
    for (const continuing of ["", "1"]) {
      for (const model of ["", "custom-model", 'custom $(echo injected) " model']) {
        await run("sh", ["-c", command], { env: {
          ...env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: capture,
          FACTORY_TASK_FILE: task, FACTORY_DESCRIBE_FILE: task, FACTORY_PR_FILE: join(dir, "pr.md"),
          FACTORY_CONTINUE: continuing, FACTORY_MODEL: model,
          FACTORY_REASONING_EFFORT: model ? "high" : "",
          FACTORY_CODEX_EFFORT: model ? 'model_reasoning_effort="high"' : "",
        } });
        const args = JSON.parse(readFileSync(capture, "utf8")) as string[];
        if (model && agent === "opencode") {
          // OpenCode 2 takes the effort as the model's variant.
          expect(args[args.indexOf("--model") + 1]).toBe(`${model}#high`);
        } else if (model) {
          expect(args[args.indexOf("--model") + 1]).toBe(model);
          if (agent === "claude") expect(args[args.indexOf("--effort") + 1]).toBe("high");
          else expect(args.filter((_, i) => args[i - 1] === "-c")).toContain('model_reasoning_effort="high"');
        } else {
          expect(args).not.toContain("--model");
          expect(args).not.toContain("--effort");
          expect(args.some((a) => a.startsWith("model_reasoning_effort="))).toBe(false);
        }
      }
    }
  }, 20_000);

  it("asks each agent for the pull request in its own session, without saving the exchange, and keeps the reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // Stand-ins that reply with their arguments and prompt: Claude Code on
    // stdout, Codex in the file named after -o.
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2) }));\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nlet stdin = "";\nprocess.stdin.on("data", (d) => (stdin += d)).on("end", () => fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify({ args, stdin })));\n`,
      { mode: 0o755 },
    );
    const prompt = join(dir, "describe-prompt.md");
    writeFileSync(prompt, "Write the PR");
    const pr = join(dir, "pull-request.md");
    const describe = async (command: string) => {
      await run("sh", ["-c", command], { env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, FACTORY_DESCRIBE_FILE: prompt, FACTORY_PR_FILE: pr,
        FACTORY_MODEL: "", FACTORY_REASONING_EFFORT: "", FACTORY_CODEX_EFFORT: "",
      } });
      return JSON.parse(readFileSync(pr, "utf8")) as { args: string[]; stdin?: string };
    };

    const claude = await describe(DEFAULT_AGENT_DESCRIBE_COMMAND);
    expect(claude.args).toEqual([
      "--continue",
      "--no-session-persistence",
      "-p",
      "Write the PR",
      "--dangerously-skip-permissions",
      "--tools",
      "Bash,Read,Grep,Glob",
    ]);

    const codex = await describe(DEFAULT_CODEX_DESCRIBE_COMMAND);
    expect(codex.args).toEqual([
      "exec",
      "resume",
      "--last",
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-o",
      pr,
      "-",
    ]);
    expect(codex.stdin).toBe("Write the PR");
  });

  it("runs OpenCode on the task with the factory's config, and continues it while messages are unread", async () => {
    const { dir, send, env } = setup();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const calls = join(dir, "calls.jsonl");
    // A stand-in `opencode` that records each run and, on the first, sends a message as if the user typed it meanwhile.
    writeFileSync(join(bin, "opencode"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.CALLS, JSON.stringify({ args: process.argv.slice(2), prompt: fs.readFileSync(0, "utf8"), config: process.env.OPENCODE_CONFIG }) + "\\n");
// What the factory's plugin records as a tool starts; the command prints it alongside OpenCode's own output.
fs.appendFileSync(process.env.FACTORY_OPENCODE_TOOLS, JSON.stringify({ type: "factory_tool_start", callID: "call_" + Date.now() }) + "\\n");
console.log(JSON.stringify({ type: "step_finish" }));
if (process.env.SEND && fs.readFileSync(process.env.CALLS, "utf8").trim().split("\\n").length === 1) {
  fs.writeFileSync(process.env.SEND, JSON.stringify({ text: "Also update the README" }));
}
`, { mode: 0o755 });
    const task = join(dir, "TASK.md");
    writeFileSync(task, "- a task that starts with a dash");
    let output: string[] = [];
    const invoke = async (extra: Record<string, string> = {}) => {
      writeFileSync(calls, "");
      const { stdout } = await run("sh", ["-c", DEFAULT_OPENCODE_COMMAND], {
        env: { ...env, FACTORY_CONTINUE: "", ...extra, PATH: `${bin}:${process.env.PATH}`, FACTORY_TASK_FILE: task, CALLS: calls },
      });
      output = stdout.trim().split("\n").map((l) => JSON.parse(l).type as string);
      return readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; prompt: string; config: string });
    };

    const [first, ...rest] = await invoke();
    expect(rest).toEqual([]);
    expect(first!.args).toEqual(["run", "--standalone", "--format", "json", "--thinking", "--auto"]);
    expect(first!.prompt).toBe("- a task that starts with a dash");
    expect(first!.config).toBe(join(dir, "opencode.json"));
    expect(output.sort()).toEqual(["factory_tool_start", "factory_turn_end", "step_finish"]);

    const later = await invoke({ FACTORY_CONTINUE: "1" });
    expect(later[0]!.args.at(-1)).toBe("--continue");
    expect(later[0]!.prompt).toBe("- a task that starts with a dash");

    // Unread when the run ends (the stand-in makes no tool calls to hand them over), so the session continues with both.
    send("0005", "Use pnpm");
    const [, ...followUps] = await invoke({ SEND: join(dir, "inbox", "0006.json") });
    expect(followUps).toHaveLength(1);
    expect(followUps[0]!.args.at(-1)).toBe("--continue");
    expect(followUps[0]!.prompt).toBe("The user sent a message while you were working:\n\nUse pnpm\n\nAlso update the README\n\nAddress it before you finish.\n");
  });

  it("gives OpenCode the instructions and the plugin, which records tool starts and hands over messages", async () => {
    const { dir, send } = setup();
    const plugin = join(dir, "opencode-plugin");
    const config = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
    expect(config.plugins).toEqual([`file://${plugin}`]);
    expect(JSON.parse(readFileSync(join(plugin, "package.json"), "utf8")).exports).toBe("./index.js");

    // OpenCode provides @opencode/plugin to the plugins it loads; a stand-in collects the hooks.
    const sdk = join(plugin, "node_modules", "@opencode", "plugin");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@opencode/plugin", type: "module", exports: "./index.js" }));
    writeFileSync(join(sdk, "index.js"), "export const Plugin = { define: (plugin) => plugin };\n");
    const previous = process.env.FACTORY_DIR;
    process.env.FACTORY_DIR = dir;
    try {
      const { default: factory } = await import(`${join(plugin, "index.js")}?${Date.now()}`);
      const hooks: Record<string, (event: never) => void> = {};
      const register = (name: string, hook: (event: never) => void) => void (hooks[name] = hook);
      await factory.setup({ session: { hook: register }, tool: { hook: register } });

      const request = { system: [] as unknown[] };
      hooks.context!(request as never);
      expect(request.system).toEqual([{ type: "text", text: SYSTEM_PROMPT }]);

      hooks["execute.before"]!({ id: "call_1", sessionID: "ses_1", tool: "factory_ask_user", input: { question: "Postgres?" } } as never);
      hooks["execute.before"]!({ id: "call_big", sessionID: "ses_1", tool: "write", input: { content: "x".repeat(10_000) } } as never);
      expect(readFileSync(join(dir, "opencode-tools.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([
        { type: "factory_tool_start", sessionID: "ses_1", callID: "call_1", tool: "factory_ask_user", args: { question: "Postgres?" } },
      ]);

      const quiet = { status: "completed", result: { content: "ok" } };
      hooks["execute.after"]!(quiet as never);
      expect(quiet.result.content).toBe("ok");
      send("0007", "Use pnpm, not npm");
      const failed = { status: "error", result: {} };
      hooks["execute.after"]!(failed as never);
      expect(failed.result).toEqual({});
      const told = { status: "completed", result: { content: [{ type: "text", text: "ok" }] } };
      hooks["execute.after"]!(told as never);
      expect(told.result.content).toEqual([{ type: "text", text: "ok" }, { type: "text", text: "\n\nThe user sent a message while you were working:\n\nUse pnpm, not npm" }]);
      expect(readdirSync(join(dir, "delivered"))).toEqual(["0007.json"]);
    } finally {
      if (previous === undefined) delete process.env.FACTORY_DIR;
      else process.env.FACTORY_DIR = previous;
    }
  });

  it("asks OpenCode for the pull request in a fork of its session, keeps the reply and deletes the fork", async () => {
    const { dir } = setup();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const calls = join(dir, "calls.jsonl");
    writeFileSync(join(bin, "opencode"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({ args, prompt: args[0] === "run" ? fs.readFileSync(0, "utf8") : null, content: process.env.OPENCODE_CONFIG_CONTENT ?? null }) + "\\n");
if (args[0] === "run") {
  const line = (type, part) => console.log(JSON.stringify({ type, sessionID: "ses_fork", part }));
  line("step_start", {});
  line("text", { messageID: "msg_1", text: "Let me look at the diff." });
  line("tool_use", { tool: "shell", id: "c1", state: { status: "completed", input: { command: "git diff" }, output: "" } });
  line("text", { messageID: "msg_2", text: "A title, a blank line, a summary.</think>\\nAdd OpenCode" });
  line("text", { messageID: "msg_2", text: "It runs OpenCode." });
  line("step_finish", { reason: "stop" });
}
`, { mode: 0o755 });
    const prompt = join(dir, "describe-prompt.md");
    writeFileSync(prompt, "Write the PR");
    const pr = join(dir, "pull-request.md");
    await run("sh", ["-c", DEFAULT_OPENCODE_DESCRIBE_COMMAND], { env: {
      ...process.env, ...describeToolEnv(dir), PATH: `${bin}:${process.env.PATH}`, CALLS: calls,
      FACTORY_DESCRIBE_FILE: prompt, FACTORY_PR_FILE: pr, FACTORY_MODEL: "", FACTORY_REASONING_EFFORT: "",
    } });
    const [describe, remove] = readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; prompt: string | null; content: string | null });
    expect(describe!.args).toEqual(["run", "--standalone", "--format", "json", "--thinking", "--auto", "--continue", "--fork"]);
    expect(describe!.prompt).toBe("Write the PR");
    expect(JSON.parse(describe!.content!)).toEqual({ permissions: [{ action: "edit", resource: "*", effect: "deny" }] });
    expect(remove!.args).toEqual(["session", "delete", "--standalone", "ses_fork"]);
    expect(readFileSync(pr, "utf8")).toBe("Add OpenCode\n\nIt runs OpenCode.");
  });

  it("points Claude Code at the MCP server and the hooks", () => {
    const { dir } = setup();
    const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.factory).toEqual({ type: "stdio", command: "node", args: [join(dir, "ask-server.mjs")] });
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe(`node ${join(dir, "inbox-hook.mjs")} post-tool-use`);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(`node ${join(dir, "inbox-hook.mjs")} stop`);
  });

  it("hands new messages to the agent after a tool call, once", async () => {
    const { dir, send, env } = setup();
    expect(await hook(dir, env, "post-tool-use")).toBe("");
    send("0001", "Use pnpm, not npm");
    send("0002", "And keep the API stable");
    const out = JSON.parse(await hook(dir, env, "post-tool-use"));
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain("Use pnpm, not npm\n\nAnd keep the API stable");
    expect(await hook(dir, env, "post-tool-use")).toBe("");
    expect(readdirSync(join(dir, "delivered")).sort()).toEqual(["0001.json", "0002.json"]);
  });

  it("keeps the agent going when a message arrives as it is about to stop", async () => {
    const { dir, send, env } = setup();
    expect(await hook(dir, env, "stop")).toBe("");
    send("0003", "Also update the README");
    const out = JSON.parse(await hook(dir, env, "stop"));
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("Also update the README");
  });

  it("serves ask_user over MCP and answers with the user's next message", async () => {
    const { dir, send, env } = setup();
    const server = spawn("node", [join(dir, "ask-server.mjs")], { env });
    const replies: any[] = [];
    let buffer = "";
    server.stdout.on("data", (d) => {
      buffer += d;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        replies.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
    const rpc = (msg: object) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    const reply = async (id: number) => {
      for (let t = 0; t < 100; t++) {
        const found = replies.find((r) => r.id === id);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no reply to ${id}`);
    };
    try {
      rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
      expect((await reply(1)).result.serverInfo.name).toBe("factory");
      rpc({ method: "notifications/initialized" });
      rpc({ id: 2, method: "tools/list" });
      expect((await reply(2)).result.tools.map((t: { name: string }) => t.name)).toEqual(["ask_user"]);

      rpc({ id: 3, method: "tools/call", params: { name: "ask_user", arguments: { question: "Postgres or SQLite?" } } });
      await new Promise((r) => setTimeout(r, 300));
      expect(replies.find((r) => r.id === 3)).toBeUndefined();
      send("0004", "Postgres");
      expect((await reply(3)).result.content[0].text).toBe("The user answered:\n\nPostgres");

      rpc({ id: 4, method: "nope" });
      expect((await reply(4)).error.code).toBe(-32601);
    } finally {
      server.kill();
    }
  });

  it("delivers a message into the inbox without quoting it into the shell", async () => {
    const { dir, env } = setup();
    const script = deliverMessageScript("0000000000000042").replaceAll("/workspace/.factory", dir);
    const text = `it's "quoted" $(rm -rf /) \`ls\``;
    await run("sh", ["-c", script], { env: { ...env, FACTORY_MESSAGE: JSON.stringify({ text }) } });
    expect(readdirSync(join(dir, "inbox"))).toEqual(["0000000000000042.json"]);
    expect(JSON.parse(readFileSync(join(dir, "inbox", "0000000000000042.json"), "utf8")).text).toBe(text);
  });
});
