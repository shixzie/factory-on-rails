"use client";

import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleSlashIcon,
  FolderGit2Icon,
  GitPullRequestIcon,
  GlobeIcon,
  PlayIcon,
  SquareIcon,
  UserRoundIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "@/lib/api";
import {
  compact,
  flowModel,
  KIND_COLOR,
  laneColor,
  pulsesFor,
  type FlowAgent,
  type FlowContext,
  type FlowModel,
  type FlowNode,
  type Pulse,
  type PulseKind,
} from "@/lib/flow";
import { duration } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * The run as a live map. The people and machines taking part are nodes (you,
 * the agent, each subagent, the workspace, the web, the pull request) and
 * every event sends a packet along the lane between two of them: your
 * messages down to the agent, prompts out to subagents and their reports
 * back, reads coming up out of the workspace and edits going into it.
 *
 * Motion, in one place so it stays coherent:
 * - nodes enter with a springy pop, and new subagents fly out of the agent
 *   that started them before settling into their slot (a damped spring, so
 *   the layout never snaps when the graph grows);
 * - lanes draw themselves on, glow in the packet's color after it passes,
 *   and a lane with a subagent still working on it keeps marching;
 * - packets are a bright head with a fading trail, eased in and out;
 * - a node rings when a packet lands, live nodes breathe, and the line under
 *   each one rolls over to what it is doing now.
 * Reduced motion keeps the map and drops the movement.
 */

const NODE_H = 46;
const PAD = 12;

/** Packet colors: the conversation with you is amber, like "Needs input". */
const PULSE_COLOR: Record<Exclude<PulseKind, "prompt" | "report">, string> = {
  message: KIND_COLOR.ask,
  ask: KIND_COLOR.ask,
  answer: KIND_COLOR.ask,
  done: KIND_COLOR.edit,
  edit: KIND_COLOR.edit,
  publish: KIND_COLOR.edit,
  read: KIND_COLOR.read,
  web: KIND_COLOR.web,
  run: KIND_COLOR.run,
};

interface Box {
  x: number;
  y: number;
  w: number;
}

interface Layout {
  nodes: Map<FlowNode, Box>;
  height: number;
  /** Subagents sit between the agent and the workspace, so that lane goes around them. */
  arc: boolean;
  width: number;
}

function computeLayout(model: FlowModel, width: number, showPr: boolean): Layout {
  const W = Math.max(width, 300);
  const cx = W / 2;
  const nodes = new Map<FlowNode, Box>();
  nodes.set("user", { x: cx, y: 32, w: Math.min(176, W - 2 * PAD) });
  nodes.set("main", { x: cx, y: 122, w: Math.min(250, W - 2 * PAD) });

  const n = model.agents.length;
  const cols = n <= 1 ? 1 : n >= 3 && W >= 560 ? 3 : 2;
  const colW = (W - PAD) / cols;
  const subW = Math.min(214, colW - 10);
  model.agents.forEach((agent, i) => {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, n - row * cols);
    const x0 = (W - inRow * colW) / 2 + colW / 2;
    nodes.set(`sub:${agent.id}`, { x: x0 + (i % cols) * colW, y: 228 + row * 86, w: subW });
  });
  const rows = Math.ceil(n / cols);
  const wsY = n ? 228 + (rows - 1) * 86 + 112 : 226;
  const ws: Box = model.usesWeb
    ? { x: W * 0.62, y: wsY, w: Math.min(196, W * 0.5) }
    : { x: cx, y: wsY, w: Math.min(196, W - 2 * PAD) };
  nodes.set("workspace", ws);
  if (model.usesWeb) nodes.set("web", { x: W * 0.2, y: wsY, w: Math.min(124, W * 0.3) });
  if (showPr) nodes.set("pr", { x: ws.x, y: wsY + 92, w: Math.min(176, W - 2 * PAD) });
  const last = Math.max(...[...nodes.values()].map((b) => b.y));
  return { nodes, height: last + NODE_H / 2 + 16, arc: n > 0, width: W };
}

/** Where a node flies in from when it first appears. */
const originOf = (node: FlowNode): FlowNode => (node === "pr" ? "workspace" : node === "main" ? "user" : "main");

interface Point {
  x: number;
  y: number;
}
type Curve = [Point, Point, Point, Point];

function bezier([p0, p1, p2, p3]: Curve, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

const pathOf = ([p0, p1, p2, p3]: Curve) => `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`;

/** The lane between two nodes, running from `a` to `b`. */
function curveBetween(a: FlowNode, b: FlowNode, at: (n: FlowNode) => Box, layout: Layout): Curve {
  const A = at(a);
  const B = at(b);
  const pair = new Set([a, b]);
  if (layout.arc && pair.has("main") && pair.has("workspace")) {
    // Around the subagents, down the right-hand side.
    const m = at("main");
    const w = at("workspace");
    const edge = layout.width - 4;
    const curve: Curve = [
      { x: m.x + m.w / 2, y: m.y },
      { x: edge, y: m.y },
      { x: edge, y: w.y },
      { x: w.x + w.w / 2, y: w.y },
    ];
    return a === "main" ? curve : (curve.slice().reverse() as Curve);
  }
  const down = A.y <= B.y;
  const top = down ? A : B;
  const bottom = down ? B : A;
  const p0 = { x: top.x, y: top.y + NODE_H / 2 };
  const p3 = { x: bottom.x, y: bottom.y - NODE_H / 2 };
  const dy = Math.max((p3.y - p0.y) / 2, 16);
  const curve: Curve = [p0, { x: p0.x, y: p0.y + dy }, { x: p3.x, y: p3.y - dy }, p3];
  return down ? curve : (curve.slice().reverse() as Curve);
}

const pairKey = (a: FlowNode, b: FlowNode) => (a < b ? `${a}|${b}` : `${b}|${a}`);

interface Flight {
  id: number;
  from: FlowNode;
  to: FlowNode;
  color: string;
  start: number;
  dur: number;
}

interface Spring {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const STIFFNESS = 210;
const DAMPING = 2 * 0.78 * Math.sqrt(STIFFNESS);
const HEAT_MS = 1400;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function useReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(mq.matches);
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}

/**
 * The map's motion: springs that carry each node to its place, packets in
 * flight, how recently each lane carried one, and how many landed on each
 * node. One animation frame loop drives all of it and sleeps when still.
 */
function useFlowMotion(layout: Layout, reduce: boolean) {
  const springs = useRef(new Map<FlowNode, Spring>());
  const flights = useRef<Flight[]>([]);
  const heat = useRef(new Map<string, { at: number; color: string }>());
  const [pings, setPings] = useState<Record<string, number>>({});
  const [, setFrame] = useState(0);
  const raf = useRef<number | undefined>(undefined);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const mounted = useRef(false);

  const lastTick = useRef<number | undefined>(undefined);
  const tick = useCallback(() => {
    raf.current = undefined;
    const now = performance.now();
    const lay = layoutRef.current;
    let busy = false;

    const dt = Math.min((now - (lastTick.current ?? now)) / 1000, 1 / 30);
    lastTick.current = now;
    for (const [node, box] of lay.nodes) {
      const s = springs.current.get(node);
      if (!s) continue;
      for (const axis of ["x", "y"] as const) {
        const v = axis === "x" ? "vx" : "vy";
        const accel = -STIFFNESS * (s[axis] - box[axis]) - DAMPING * s[v];
        s[v] += accel * dt;
        s[axis] += s[v] * dt;
      }
      if (Math.abs(s.x - box.x) > 0.2 || Math.abs(s.y - box.y) > 0.2 || Math.abs(s.vx) + Math.abs(s.vy) > 0.5) busy = true;
      else Object.assign(s, { x: box.x, y: box.y, vx: 0, vy: 0 });
    }

    const landed: FlowNode[] = [];
    flights.current = flights.current.filter((f) => {
      if (now < f.start + f.dur) return (busy = true);
      landed.push(f.to);
      heat.current.set(pairKey(f.from, f.to), { at: now, color: f.color });
      return false;
    });
    if (landed.length) {
      setPings((p) => {
        const next = { ...p };
        for (const node of landed) next[node] = (next[node] ?? 0) + 1;
        return next;
      });
    }
    for (const h of heat.current.values()) if (now - h.at < HEAT_MS) busy = true;

    setFrame((n) => n + 1);
    if (busy) raf.current = requestAnimationFrame(tick);
    else lastTick.current = undefined;
  }, []);

  const wake = useCallback(() => {
    if (raf.current === undefined) raf.current = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => () => void (raf.current !== undefined && cancelAnimationFrame(raf.current)), []);

  // New nodes start where they come from (on first paint, where they belong); moved ones spring over.
  useEffect(() => {
    let moved = false;
    for (const [node, box] of layout.nodes) {
      const s = springs.current.get(node);
      if (!s) {
        const from = mounted.current && !reduce ? springs.current.get(originOf(node)) : undefined;
        springs.current.set(node, { x: from?.x ?? box.x, y: from?.y ?? box.y, vx: 0, vy: 0 });
        moved ||= !!from;
      } else if (reduce) {
        Object.assign(s, { x: box.x, y: box.y, vx: 0, vy: 0 });
      } else if (s.x !== box.x || s.y !== box.y) {
        moved = true;
      }
    }
    for (const node of springs.current.keys()) if (!layout.nodes.has(node)) springs.current.delete(node);
    mounted.current = true;
    if (moved) wake();
    else setFrame((n) => n + 1);
  }, [layout, reduce, wake]);

  const nextId = useRef(0);
  const launch = useCallback(
    (pulses: { pulse: Pulse; color: string }[], stagger: number) => {
      const now = performance.now();
      const lay = layoutRef.current;
      pulses.forEach(({ pulse, color }, i) => {
        if (!lay.nodes.has(pulse.from) || !lay.nodes.has(pulse.to)) return;
        if (reduce) {
          setPings((p) => ({ ...p, [pulse.to]: (p[pulse.to] ?? 0) + 1 }));
          return;
        }
        const a = lay.nodes.get(pulse.from)!;
        const b = lay.nodes.get(pulse.to)!;
        const dist = Math.hypot(a.x - b.x, a.y - b.y) + (lay.arc && pulse.from !== "user" && pulse.to !== "user" ? 60 : 0);
        const dur = Math.min(Math.max(dist / 0.3, 520), 1250);
        flights.current.push({ id: nextId.current++, from: pulse.from, to: pulse.to, color, start: now + i * stagger, dur });
      });
      wake();
    },
    [reduce, wake],
  );

  const at = useCallback(
    (node: FlowNode): Box => {
      const box = layoutRef.current.nodes.get(node)!;
      const s = springs.current.get(node);
      return s ? { x: s.x, y: s.y, w: box.w } : box;
    },
    [],
  );

  return { at, flights: flights.current, heat: heat.current, pings, launch };
}

function pulseColor(pulse: Pulse, lanes: Map<string, number>): string {
  if (pulse.kind === "prompt" || pulse.kind === "report") {
    const sub = [pulse.from, pulse.to].find((n) => n.startsWith("sub:"));
    return laneColor(lanes.get(sub?.slice(4) ?? "") ?? 0);
  }
  return PULSE_COLOR[pulse.kind];
}

function statusOf(agent: FlowAgent, now: number) {
  const took = agent.stats?.durationMs ?? (agent.doneAt ?? new Date(now)).getTime() - agent.startedAt.getTime();
  const parts = [duration(new Date(0), new Date(took))];
  const tools = agent.stats?.toolUses ?? agent.toolCount;
  parts.push(`${tools} ${tools === 1 ? "tool" : "tools"}`);
  if (agent.stats?.tokens) parts.push(`${compact(agent.stats.tokens)} tokens`);
  return parts.join(" · ");
}

/** The line under a node's title, rolling over whenever it changes. */
function Ticker({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn("relative block h-4 overflow-hidden", className)}>
      <span key={text} className="flow-tick block truncate">
        {text}
      </span>
    </span>
  );
}

const NodeCard = memo(function NodeCard({
  icon,
  title,
  subtitle,
  accent,
  live,
  state,
  ping,
  onClick,
  href,
  label,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  accent: string;
  live?: boolean;
  state?: "done" | "error" | "stopped";
  ping: number;
  onClick?: () => void;
  href?: string;
  label: string;
}) {
  const body = (
    <>
      {live ? (
        <span aria-hidden className="flow-breathe pointer-events-none absolute -inset-1 rounded-[14px] border-2" style={{ borderColor: accent }} />
      ) : null}
      {ping ? (
        <span
          key={ping}
          aria-hidden
          className="flow-ring pointer-events-none absolute -inset-px rounded-xl border-2"
          style={{ borderColor: accent }}
        />
      ) : null}
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-lg [&_svg]:size-3.5"
        style={{ background: `color-mix(in oklch, ${accent} 16%, transparent)`, color: accent }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-xs leading-4 font-medium">{title}</span>
        <Ticker text={subtitle} className="text-[10.5px] leading-4 text-muted-foreground" />
      </span>
      {state ? (
        <span
          className={cn(
            "flow-check flex size-4 shrink-0 items-center justify-center rounded-full [&_svg]:size-2.5",
            state === "done" && "bg-success/15 text-success",
            state === "error" && "bg-destructive/15 text-destructive",
            state === "stopped" && "bg-muted text-muted-foreground",
          )}
        >
          {state === "done" ? <CheckIcon strokeWidth={3} /> : state === "error" ? <CircleAlertIcon /> : <CircleSlashIcon />}
        </span>
      ) : null}
    </>
  );
  const className =
    "flow-pop relative flex size-full items-center gap-2 rounded-xl border bg-card px-2 shadow-sm outline-none transition-colors dark:shadow-none focus-visible:ring-2 focus-visible:ring-ring";
  if (href)
    return (
      <a href={href} target="_blank" rel="noreferrer" aria-label={label} className={cn(className, "hover:bg-accent")}>
        {body}
      </a>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} aria-label={label} className={cn(className, "hover:bg-accent")}>
        {body}
      </button>
    );
  return (
    <div className={className} role="img" aria-label={label}>
      {body}
    </div>
  );
});

/**
 * The flow map and, under it, the subagents with what each is doing. `events`
 * drives everything; on a finished run, Replay plays them back.
 */
export function RunFlow({
  events,
  live,
  awaiting,
  pullRequestUrl,
  filesChanged,
  onSelectAgent,
}: {
  events: ReadonlyArray<Api.ApiRunEvent>;
  live: boolean;
  awaiting: boolean;
  pullRequestUrl: string | null;
  filesChanged: number;
  onSelectAgent: (id: string) => void;
}) {
  const reduce = useReducedMotion();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Replay: how many events are shown, or null for all of them.
  const [cursor, setCursor] = useState<number | null>(null);
  const replaying = cursor !== null;
  const shown = useMemo(() => (cursor === null ? events : events.slice(0, cursor)), [events, cursor]);
  const model = useMemo(() => flowModel(shown, live || replaying), [shown, live, replaying]);
  const lanes = useMemo(() => new Map(model.agents.map((a) => [a.id, a.lane])), [model]);
  const showPr = model.published || (!replaying && !!pullRequestUrl);
  const layout = useMemo(() => computeLayout(model, width, showPr), [model, width, showPr]);
  const { at, flights, heat, pings, launch } = useFlowMotion(layout, reduce);

  // Send packets for events as they arrive (not for the history the page opened with).
  const fed = useRef<{ count: number; calls: FlowContext } | null>(null);
  useEffect(() => {
    if (width === 0) return;
    if (!fed.current) {
      const calls: FlowContext = new Map();
      for (const e of shown) pulsesFor(e, calls);
      fed.current = { count: shown.length, calls };
      return;
    }
    // A replay starting over.
    if (shown.length < fed.current.count) fed.current = { count: 0, calls: new Map() };
    const state = fed.current;
    const fresh = shown.slice(state.count);
    state.count = shown.length;
    if (fresh.length === 0) return;
    const pulses = fresh.flatMap((e) => pulsesFor(e, state.calls)).slice(-14);
    launch(
      pulses.map((pulse) => ({ pulse, color: pulseColor(pulse, lanes) })),
      replaying ? 90 : 120,
    );
  }, [shown, width, lanes, launch, replaying]);

  // Replay steps from one packet-sending event to the next.
  useEffect(() => {
    if (cursor === null) return;
    if (cursor >= events.length) {
      const done = setTimeout(() => setCursor(null), 900);
      return () => clearTimeout(done);
    }
    const probe: FlowContext = new Map();
    for (const e of events.slice(0, cursor)) pulsesFor(e, probe);
    let next = cursor;
    while (next < events.length && pulsesFor(events[next]!, probe).length === 0) next++;
    const step = setTimeout(() => setCursor(Math.min(next + 1, events.length)), cursor === 0 ? 150 : 340);
    return () => clearTimeout(step);
  }, [cursor, events]);

  const [now, setNow] = useState(() => Date.now());
  const anyRunning = model.agents.some((a) => a.status === "running");
  useEffect(() => {
    if (!live || !anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live, anyRunning]);

  // Lanes: you and the agent, the agent and each subagent, each of them and the workspace.
  const lanesToDraw = useMemo(() => {
    const list: { a: FlowNode; b: FlowNode; march?: string }[] = [
      { a: "user", b: "main" },
      { a: "main", b: "workspace" },
    ];
    for (const agent of model.agents) {
      const sub: FlowNode = `sub:${agent.id}`;
      list.push({ a: "main", b: sub, march: agent.status === "running" && (live || replaying) ? laneColor(agent.lane) : undefined });
      list.push({ a: sub, b: "workspace" });
      if (model.edges[`${sub}>web`]) list.push({ a: sub, b: "web" });
    }
    if (model.usesWeb && model.edges["main>web"]) list.push({ a: "main", b: "web" });
    if (showPr) list.push({ a: "workspace", b: "pr" });
    return list.filter((l) => layout.nodes.has(l.a) && layout.nodes.has(l.b));
  }, [model, layout, showPr, live, replaying]);

  const frameNow = performance.now();
  const toolCount = model.main.toolCount + model.agents.reduce((n, a) => n + a.toolCount, 0);
  const running = model.agents.filter((a) => a.status === "running").length;
  const prNumber = pullRequestUrl?.match(/\/pull\/(\d+)/)?.[1];

  const node = (id: FlowNode) => {
    const box = at(id);
    const style = { left: box.x - box.w / 2, top: box.y - NODE_H / 2, width: box.w, height: NODE_H };
    const ping = pings[id] ?? 0;
    let card: React.ReactNode;
    if (id === "user") {
      card = (
        <NodeCard
          icon={<UserRoundIcon />}
          title="You"
          subtitle={awaiting && live && !replaying ? "The agent is waiting for you" : "Task and messages"}
          accent="var(--warning)"
          live={awaiting && live && !replaying}
          ping={ping}
          label="You"
        />
      );
    } else if (id === "main") {
      const working = (live || replaying) && !(awaiting && !replaying);
      card = (
        <NodeCard
          icon={<BotIcon />}
          title="Agent"
          subtitle={model.main.current ?? (live || replaying ? "Thinking…" : "Finished")}
          accent="var(--primary)"
          live={working}
          ping={ping}
          label={`Agent: ${model.main.current ?? "idle"}`}
        />
      );
    } else if (id === "workspace") {
      card = (
        <NodeCard
          icon={<FolderGit2Icon />}
          title="Workspace"
          subtitle={filesChanged ? `${filesChanged} ${filesChanged === 1 ? "file" : "files"} changed` : "The repository and its shell"}
          accent="var(--success)"
          ping={ping}
          label="Workspace"
        />
      );
    } else if (id === "web") {
      card = <NodeCard icon={<GlobeIcon />} title="Web" subtitle="Pages and search" accent="var(--info)" ping={ping} label="Web" />;
    } else if (id === "pr") {
      card = (
        <NodeCard
          icon={<GitPullRequestIcon />}
          title="Pull request"
          subtitle={prNumber ? `#${prNumber} on GitHub` : "On GitHub"}
          accent="var(--success)"
          ping={ping}
          href={pullRequestUrl ?? undefined}
          label="Open the pull request"
        />
      );
    } else {
      const agent = model.agents.find((a) => `sub:${a.id}` === id)!;
      const color = laneColor(agent.lane);
      card = (
        <NodeCard
          icon={<BotIcon />}
          title={agent.description}
          subtitle={agent.status === "running" ? (agent.current ?? `Starting ${agent.kind}…`) : statusOf(agent, now)}
          accent={color}
          live={agent.status === "running" && (live || replaying)}
          state={agent.status === "running" ? undefined : agent.status}
          ping={ping}
          onClick={() => onSelectAgent(agent.id)}
          label={`Subagent: ${agent.description}. Show its work.`}
        />
      );
    }
    return (
      <div key={id} className="absolute" style={style}>
        {card}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {model.agents.length ? `${model.agents.length} ${model.agents.length === 1 ? "subagent" : "subagents"}` : "No subagents yet"}
          {running ? ` · ${running} working` : ""}
        </span>
        <span>· {toolCount} tool calls</span>
        {!live && events.length > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => setCursor(replaying ? null : 0)}
            aria-label={replaying ? "Stop the replay" : "Replay the run"}
          >
            {replaying ? <SquareIcon className="fill-current" /> : <PlayIcon />}
            {replaying ? "Stop" : "Replay"}
          </Button>
        ) : null}
      </div>

      <div ref={container} className="relative w-full" style={{ height: width ? layout.height : 360 }}>
        {width ? (
          <>
            <svg className="absolute inset-0 overflow-visible" width={layout.width} height={layout.height} aria-hidden>
              <defs>
                <filter id="flow-glow" x="-100%" y="-100%" width="300%" height="300%">
                  <feGaussianBlur stdDeviation="3" />
                </filter>
              </defs>
              {lanesToDraw.map(({ a, b, march }) => {
                const d = pathOf(curveBetween(a, b, at, layout));
                const h = heat.get(pairKey(a, b));
                const glow = h ? Math.max(0, 1 - (frameNow - h.at) / HEAT_MS) : 0;
                return (
                  <g key={pairKey(a, b)}>
                    <path d={d} pathLength={1} fill="none" className="flow-draw stroke-foreground/15" strokeWidth={1.25} />
                    {march ? <path d={d} fill="none" stroke={march} strokeOpacity={0.7} strokeWidth={1.5} className="flow-march" /> : null}
                    {glow > 0 ? <path d={d} fill="none" stroke={h!.color} strokeOpacity={glow * 0.85} strokeWidth={1.75} /> : null}
                  </g>
                );
              })}
              {flights.map((f) => {
                const t = (frameNow - f.start) / f.dur;
                if (t < 0 || t > 1) return null;
                const curve = curveBetween(f.from, f.to, at, layout);
                const head = easeInOut(t);
                return (
                  <g key={f.id}>
                    {[5, 4, 3, 2, 1].map((k) => {
                      const p = bezier(curve, Math.max(0, head - k * 0.028));
                      return <circle key={k} cx={p.x} cy={p.y} r={3.2 - k * 0.45} fill={f.color} opacity={0.5 - k * 0.08} />;
                    })}
                    {(() => {
                      const p = bezier(curve, head);
                      return (
                        <>
                          <circle cx={p.x} cy={p.y} r={7} fill={f.color} opacity={0.45} filter="url(#flow-glow)" />
                          <circle cx={p.x} cy={p.y} r={3.5} fill={f.color} />
                          <circle cx={p.x} cy={p.y} r={1.4} className="fill-background" opacity={0.9} />
                        </>
                      );
                    })()}
                  </g>
                );
              })}
            </svg>
            {lanesToDraw.map(({ a, b }) => {
              const count = (model.edges[`${a}>${b}`] ?? 0) + (model.edges[`${b}>${a}`] ?? 0);
              if (count < 2) return null;
              const p = bezier(curveBetween(a, b, at, layout), 0.5);
              return (
                <span
                  key={`n-${pairKey(a, b)}`}
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border bg-background px-1.5 font-mono text-[9.5px] leading-4 text-muted-foreground tabular-nums"
                  style={{ left: p.x, top: p.y }}
                >
                  {count}
                </span>
              );
            })}
            {[...layout.nodes.keys()].map(node)}
          </>
        ) : null}
      </div>

      <Legend hasAgents={model.agents.length > 0} />

      {model.agents.length ? (
        <div className="flex flex-col gap-1">
          <div className="px-1 text-[11px] font-medium text-muted-foreground">Subagents</div>
          {model.agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelectAgent(agent.id)}
              className="group flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent"
            >
              <span className="relative flex size-2.5 shrink-0">
                {agent.status === "running" && live ? (
                  <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: laneColor(agent.lane) }} />
                ) : null}
                <span className="relative size-2.5 rounded-full" style={{ background: laneColor(agent.lane) }} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate font-medium">{agent.description}</span>
                  <span className="shrink-0 text-[10.5px] text-muted-foreground">{agent.kind}</span>
                </span>
                <Ticker
                  text={agent.status === "running" ? (agent.current ?? "Starting…") : agent.status === "stopped" ? "Stopped with the run" : statusOf(agent, now)}
                  className="text-[11px] text-muted-foreground"
                />
              </span>
              {agent.status === "running" ? (
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground tabular-nums">{statusOf(agent, now).split(" · ")[0]}</span>
              ) : agent.status === "done" ? (
                <CheckIcon className="size-3.5 shrink-0 text-success" />
              ) : agent.status === "error" ? (
                <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Legend({ hasAgents }: { hasAgents: boolean }) {
  const items: [string, string][] = [
    ["You and the agent", KIND_COLOR.ask],
    ...(hasAgents ? ([["Delegation", laneColor(1)]] as [string, string][]) : []),
    ["Reads", KIND_COLOR.read],
    ["Edits", KIND_COLOR.edit],
    ["Commands", KIND_COLOR.run],
  ];
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-[10.5px] text-muted-foreground">
      {items.map(([label, color]) => (
        <span key={label} className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}
