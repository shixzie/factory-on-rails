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

/** The first line of a task, which is what lists show as its title. */
export function taskTitle(task: string, max = 80): string {
  const line = task.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "just now", "4m ago", "3h ago". */
export function ago(date: Date, now = Date.now()): string {
  const age = shortAge(date, now);
  return age === "now" ? "just now" : `${age} ago`;
}
