import type { ScheduleRule, TaskKind } from "./api.ts";

export function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

/** "in 5m", "in 3h", "in 2d"; "now" once it's due. */
export function timeUntil(iso?: string): string {
  if (!iso) return "—";
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** "Every Monday and Thursday at 09:00", "Every 6 hours at :30". */
export function describeRule(r: ScheduleRule): string {
  switch (r.freq) {
    case "hourly":
      return r.every && r.every > 1 ? `Every ${r.every} hours at :${r.time.slice(3)}` : `Every hour at :${r.time.slice(3)}`;
    case "daily":
      return `Every day at ${r.time}`;
    case "weekdays":
      return `Weekdays at ${r.time}`;
    case "weekly": {
      const names = (r.days ?? []).map((d) => WEEKDAYS[d]);
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
      return `Every ${list} at ${r.time}`;
    }
    case "monthly":
      return `Monthly on the ${ordinal(r.monthDay ?? 1)} at ${r.time}`;
  }
}

/** "$0.0042" for small amounts, "$1.23" otherwise. */
export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export const KIND_STYLE: Record<TaskKind, { label: string; color: string }> = {
  feature: { label: "Feature", color: "#22d3ee" },
  bug: { label: "Bug", color: "#fb7185" },
  chore: { label: "Chore", color: "#94a3b8" },
  idea: { label: "Idea", color: "#fbbf24" },
};

/** Subsequence match score for the command palette; -1 when it doesn't match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct !== -1) return 1000 - direct;
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    score += found === ti ? 3 : 1;
    ti = found + 1;
  }
  return score;
}
