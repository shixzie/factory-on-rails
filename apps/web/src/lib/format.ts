/** "now", "4m", "3h", "2d", "5w": the compact ages t3code shows beside threads. */
export function shortAge(date: Date, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 604_800) return `${Math.floor(s / 86_400)}d`;
  return `${Math.floor(s / 604_800)}w`;
}

/** "42s", "3m 12s", "1h 04m". */
export function duration(from: Date, to: Date): string {
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Openings that say nothing about the task: "please", "can you", "we need to". */
const LEAD_IN =
  /^(?:(?:please|pls|hey|hi|ok(?:ay)?)\b[,!\s]*|(?:can|could|would) you\s+|i (?:want|need|would like)(?: you)? to\s+|we (?:need|want|have) to\s+|let'?s\s+)+/i;

/**
 * What lists and the run header call a run: its title (written by a small
 * model from the task, or by the user), or until it has one, the task's first
 * line without its lead-in.
 */
export function runTitle(run: { title: string | null; task: string }, max = 80): string {
  if (run.title) return clip(run.title, max);
  const line = run.task.trim().split("\n")[0]?.trim() ?? "";
  const bare = line.replace(LEAD_IN, "");
  const text = bare ? bare[0]!.toUpperCase() + bare.slice(1) : line;
  return clip(text, max);
}

/** "just now", "4m ago", "3h ago". */
export function ago(date: Date, now = Date.now()): string {
  const age = shortAge(date, now);
  return age === "now" ? "just now" : `${age} ago`;
}
