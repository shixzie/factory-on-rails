/**
 * The run as a flow of work between its actors: you, the main agent, the
 * subagents it starts, the workspace (the repository and its shell), the web,
 * and the pull request. `flowModel` says who exists and what each is doing;
 * `pulsesFor` turns each new event into the packets the flow map animates
 * along its edges. Both are pure, so replaying a run is just feeding events in
 * again.
 */
import type { ApiRunEvent } from "@factory/core/api";
import { ASK_USER_TOOL, isSubagentTool, repoPath, type SubagentStats } from "./activity";

export type FlowNode = "user" | "main" | "workspace" | "web" | "pr" | `sub:${string}`;

export type PulseKind = "message" | "ask" | "answer" | "prompt" | "report" | "edit" | "read" | "run" | "web" | "publish" | "done";

export interface Pulse {
  from: FlowNode;
  to: FlowNode;
  kind: PulseKind;
}

export interface FlowAgent {
  /** The tool call that started it. */
  id: string;
  /** Its place among the run's subagents, which picks its color. */
  lane: number;
  kind: string;
  description: string;
  status: "running" | "done" | "error" | "stopped";
  toolCount: number;
  /** What it is doing now, or did last ("Reading app.ts"). */
  current?: string;
  startedAt: Date;
  doneAt?: Date;
  stats?: SubagentStats;
}

export interface FlowModel {
  agents: FlowAgent[];
  main: { toolCount: number; current?: string; lastAt?: Date };
  /** How many packets crossed each edge, keyed `from>to`. */
  edges: Record<string, number>;
  usesWeb: boolean;
  published: boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const base = (path: string) => repoPath(path).split("/").pop() || repoPath(path);
const clip = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** A tool call as a few words in the present tense, for tickers. */
export function describeCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return str(input.description) || `Running ${clip(str(input.command).split("\n")[0] ?? "", 40)}`;
    case "Read":
      return `Reading ${base(str(input.file_path))}`;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `Editing ${base(str(input.file_path) || str(input.notebook_path))}`;
    case "Write":
      return `Writing ${base(str(input.file_path))}`;
    case "Grep":
      return `Searching for ${clip(str(input.pattern), 32)}`;
    case "Glob":
    case "LS":
      return `Listing ${clip(str(input.pattern) || repoPath(str(input.path)) || "files", 32)}`;
    case "WebFetch":
      return `Fetching ${clip(str(input.url).replace(/^https?:\/\//, ""), 36)}`;
    case "WebSearch":
      return `Searching the web for ${clip(str(input.query), 28)}`;
    case "TodoWrite":
      return "Updating the plan";
    case "Task":
    case "Agent":
      return `Delegating: ${clip(str(input.description), 36)}`;
    case ASK_USER_TOOL:
      return "Asking you a question";
    default:
      return name.startsWith("mcp__") ? `Using ${name.split("__").slice(1).join(" ")}` : `Using ${name}`;
  }
}

interface CallInfo {
  name: string;
  actor: FlowNode;
  /** For a subagent call: the top-level subagent it belongs to (itself, unless a subagent started it). */
  root?: string;
}

/** Remembers tool calls between events, so a result knows what it answers. */
export type FlowContext = Map<string, CallInfo>;

/** The top-level subagent a nested call belongs to; subagents a subagent starts count as part of it. */
export const rootAgent = (calls: FlowContext, parentId: string) => calls.get(parentId)?.root ?? parentId;

const actorOf = (calls: FlowContext, data: Record<string, unknown>): FlowNode => {
  const parent = str(data.parentToolUseId);
  return parent ? `sub:${rootAgent(calls, parent)}` : "main";
};

/** The packets one event sends across the map. */
export function pulsesFor(e: ApiRunEvent, calls: FlowContext): Pulse[] {
  const data = e.data ?? {};
  switch (e.kind) {
    case "user_message":
      return [{ from: "user", to: "main", kind: "message" }];
    case "agent_result":
      return [{ from: "main", to: "user", kind: "done" }];
    case "info":
      return /^Opened https:\/\/github\.com\//.test(e.message) ? [{ from: "workspace", to: "pr", kind: "publish" }] : [];
    case "tool_call": {
      const name = str(data.name) || e.message;
      const actor = actorOf(calls, data);
      const id = str(data.id);
      const parent = str(data.parentToolUseId);
      if (isSubagentTool(name)) {
        calls.set(id, { name, actor, root: parent ? rootAgent(calls, parent) : id });
        return parent ? [] : [{ from: actor, to: `sub:${id}`, kind: "prompt" }];
      }
      calls.set(id, { name, actor });
      if (name === ASK_USER_TOOL) return [{ from: actor, to: "user", kind: "ask" }];
      if (EDIT_TOOLS.has(name)) return [{ from: actor, to: "workspace", kind: "edit" }];
      if (WEB_TOOLS.has(name)) return [{ from: actor, to: "web", kind: "web" }];
      if (READ_TOOLS.has(name) || name === "TodoWrite") return [];
      return [{ from: actor, to: "workspace", kind: "run" }];
    }
    case "tool_result": {
      const call = calls.get(str(data.toolUseId));
      if (!call) return [];
      const id = str(data.toolUseId);
      if (isSubagentTool(call.name)) return call.root === id ? [{ from: `sub:${id}`, to: call.actor, kind: "report" }] : [];
      if (call.name === ASK_USER_TOOL) return [{ from: "user", to: call.actor, kind: "answer" }];
      if (READ_TOOLS.has(call.name)) return [{ from: "workspace", to: call.actor, kind: "read" }];
      if (WEB_TOOLS.has(call.name)) return [{ from: "web", to: call.actor, kind: "read" }];
      if (EDIT_TOOLS.has(call.name) || call.name === "TodoWrite") return [];
      return [{ from: "workspace", to: call.actor, kind: "read" }];
    }
    default:
      return [];
  }
}

export const edgeKey = (from: FlowNode, to: FlowNode) => `${from}>${to}`;

/** Who took part in the run and what each is doing, after `events`. */
export function flowModel(events: ReadonlyArray<ApiRunEvent>, live: boolean): FlowModel {
  const agents = new Map<string, FlowAgent>();
  const calls: FlowContext = new Map();
  const edges: Record<string, number> = {};
  const main: FlowModel["main"] = { toolCount: 0 };
  let usesWeb = false;
  let published = false;

  for (const e of events) {
    const data = e.data ?? {};
    for (const p of pulsesFor(e, calls)) {
      const key = edgeKey(p.from, p.to);
      edges[key] = (edges[key] ?? 0) + 1;
      if (p.to === "web" || p.from === "web") usesWeb = true;
      if (p.kind === "publish") published = true;
    }
    if (e.kind === "tool_call") {
      const name = str(data.name) || e.message;
      const input = (typeof data.input === "object" && data.input !== null ? data.input : {}) as Record<string, unknown>;
      const parent = str(data.parentToolUseId);
      const owner = parent ? agents.get(rootAgent(calls, parent)) : undefined;
      if (owner) {
        owner.toolCount++;
        owner.current = describeCall(name, input);
      } else if (!parent) {
        main.toolCount++;
        main.current = describeCall(name, input);
        main.lastAt = e.at;
      }
      if (isSubagentTool(name) && !parent) {
        agents.set(str(data.id), {
          id: str(data.id),
          lane: agents.size,
          kind: str(input.subagent_type) || "agent",
          description: str(input.description) || "Subtask",
          status: "running",
          toolCount: 0,
          startedAt: e.at,
        });
      }
    } else if (e.kind === "tool_result") {
      const agent = agents.get(str(data.toolUseId));
      if (agent) {
        agent.status = data.isError === true ? "error" : "done";
        agent.doneAt = e.at;
        agent.current = undefined;
        const stats = typeof data.stats === "object" && data.stats !== null ? (data.stats as Record<string, unknown>) : undefined;
        if (stats) {
          agent.stats = {
            durationMs: typeof stats.durationMs === "number" ? stats.durationMs : undefined,
            tokens: typeof stats.tokens === "number" ? stats.tokens : undefined,
            toolUses: typeof stats.toolUses === "number" ? stats.toolUses : undefined,
          };
        }
      }
    } else if (e.kind === "agent_result") {
      main.current = undefined;
    }
  }

  // A subagent still "running" when the run is over was cut off.
  const list = [...agents.values()];
  if (!live) for (const a of list) if (a.status === "running") a.status = "stopped";
  // While its subagents work, the agent is waiting on them.
  const working = list.filter((a) => a.status === "running").length;
  if (working && main.current?.startsWith("Delegating")) main.current = `Waiting on ${working} ${working === 1 ? "subagent" : "subagents"}`;
  return { agents: list, main, edges, usesWeb, published };
}

/** Each subagent gets a hue of its own, used for it everywhere: the map, its card, its packets. */
const HUES = [205, 295, 30, 150, 345, 85];
export const laneHue = (lane: number) => HUES[lane % HUES.length]!;
export const laneColor = (lane: number, alpha = 1) => `oklch(0.7 0.15 ${laneHue(lane)}${alpha < 1 ? ` / ${alpha}` : ""})`;

/** 18034 → "18k". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export type ToolKind = "read" | "edit" | "run" | "web" | "agent" | "ask" | "plan";

/** What sort of work a tool call is, for coloring it. */
export function toolKind(name: string): ToolKind {
  if (EDIT_TOOLS.has(name)) return "edit";
  if (READ_TOOLS.has(name)) return "read";
  if (WEB_TOOLS.has(name)) return "web";
  if (isSubagentTool(name)) return "agent";
  if (name === ASK_USER_TOOL) return "ask";
  if (name === "TodoWrite") return "plan";
  return "run";
}

/** The color packets and marks of each kind of work use, on the map and in the thread. */
export const KIND_COLOR: Record<ToolKind, string> = {
  read: "var(--info)",
  web: "var(--info)",
  edit: "var(--success)",
  run: "oklch(0.7 0.19 320)",
  ask: "var(--warning)",
  plan: "var(--muted-foreground)",
  agent: "var(--primary)",
};
