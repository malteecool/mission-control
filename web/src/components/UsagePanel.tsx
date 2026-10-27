import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleDollarSign } from "lucide-react";
import { api, type UsageReport, type UsageTotals } from "../lib/api.ts";
import { href } from "../lib/router.ts";
import { formatUsd, timeAgo } from "../lib/util.ts";
import { Empty, ErrorNote, Panel } from "./ui.tsx";

const DAYS = 30;

/** Cost and turns of finished Claude runs: everywhere, or for one project. */
export function UsagePanel({ projectId }: { projectId?: number }) {
  const usage = useQuery({ queryKey: ["usage", projectId ?? "all"], queryFn: () => api.usage(projectId, DAYS) });
  const u = usage.data;

  if (usage.isError) return <ErrorNote>{usage.error.message}</ErrorNote>;
  if (!u) return <div className="text-sm text-slate-500">Loading…</div>;
  if (u.total.runs === 0)
    return (
      <Panel>
        <Empty icon={<CircleDollarSign size={20} />} title="No usage recorded yet">
          Each chat turn and task session adds its cost and turns here when it finishes.
        </Empty>
      </Panel>
    );

  const tiles: Array<{ label: string; t: UsageTotals }> = [
    { label: "Today", t: u.today },
    { label: `Last ${DAYS} days`, t: u.period },
    { label: "All time", t: u.total },
  ];
  const tasks = projectId === undefined ? u.tasks.slice(0, 8) : u.tasks;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {tiles.map(({ label, t }) => (
          <Panel key={label} className="p-4">
            <div className="hud-label">{label}</div>
            <div className="mt-2 font-mono text-2xl font-semibold text-white">{formatUsd(t.costUsd)}</div>
            <div className="mt-1 font-mono text-[10px] text-slate-500">
              {t.runs} runs · {t.turns} turns
            </div>
          </Panel>
        ))}
      </div>

      <DailyChart days={u.days} />

      <div className={projectId === undefined ? "grid gap-4 lg:grid-cols-2" : ""}>
        {projectId === undefined && (
          <Panel className="p-4">
            <div className="hud-label mb-3">By project</div>
            <RankedList
              items={u.projects.map((p) => ({
                key: String(p.projectId),
                label: p.name,
                color: p.color,
                link: href({ name: "project", id: p.projectId, tab: "usage" }),
                totals: p,
              }))}
            />
          </Panel>
        )}
        <Panel className="p-4">
          <div className="hud-label mb-3">{projectId === undefined ? "Most expensive tasks" : "By task"}</div>
          {tasks.length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-500">No task sessions yet; only chats.</div>
          ) : (
            <RankedList
              items={tasks.map((t) => ({
                key: t.taskId,
                label: t.title,
                color: u.projects.find((p) => p.projectId === t.projectId)?.color ?? "var(--accent)",
                link: href({ name: "project", id: t.projectId, tab: "tasks" }),
                sub: `${t.status === "done" ? "done · " : t.status ? "" : "deleted · "}last run ${timeAgo(t.lastRunAt)}`,
                totals: t,
              }))}
            />
          )}
        </Panel>
      </div>
    </div>
  );
}

function DailyChart({ days }: { days: UsageReport["days"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...days.map((d) => d.costUsd));
  const h = days[hover ?? -1];
  const label = (day: string) =>
    new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <Panel className="p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="hud-label">Spend per day</span>
        <span className="font-mono text-[11px] text-slate-400">
          {h ? `${label(h.day)} · ${formatUsd(h.costUsd)} · ${h.runs} runs · ${h.turns} turns` : `peak ${formatUsd(max)}`}
        </span>
      </div>
      <div className="relative h-32 border-b border-white/10" onMouseLeave={() => setHover(null)}>
        {max > 0 && <div className="absolute inset-x-0 top-0 border-t border-dashed border-white/[0.06]" />}
        <div className="absolute inset-0 flex items-end gap-[2px]">
          {days.map((d, i) => (
            // The hit area is the whole column, so thin or empty days are still easy to hover.
            <div
              key={d.day}
              className="flex h-full flex-1 cursor-default items-end"
              onMouseEnter={() => setHover(i)}
              title={`${label(d.day)}: ${formatUsd(d.costUsd)}`}
            >
              <div
                className="w-full rounded-t-[4px] transition-opacity"
                style={{
                  height: max > 0 && d.costUsd > 0 ? `max(2px, ${(d.costUsd / max) * 100}%)` : 0,
                  background: "var(--accent)",
                  opacity: hover === null || hover === i ? 0.85 : 0.35,
                }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-slate-500">
        <span>{label(days[0].day)}</span>
        <span>today</span>
      </div>
    </Panel>
  );
}

function RankedList({
  items,
}: {
  items: Array<{ key: string; label: string; color: string; link: string; sub?: string; totals: UsageTotals }>;
}) {
  const max = Math.max(...items.map((i) => i.totals.costUsd), 0);
  return (
    <ul className="space-y-1">
      {items.map((i) => (
        <li key={i.key}>
          <a href={i.link} className="block rounded-lg px-2 py-1.5 transition hover:bg-white/[0.04]">
            <div className="flex items-baseline gap-3">
              <span className="h-1.5 w-1.5 shrink-0 self-center rounded-full" style={{ background: i.color }} />
              <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{i.label}</span>
              <span className="shrink-0 font-mono text-xs text-white">{formatUsd(i.totals.costUsd)}</span>
            </div>
            <div className="ml-4 mt-1 h-1 overflow-hidden rounded-full bg-white/[0.04]">
              <div
                className="h-full rounded-full"
                style={{ width: `${max > 0 ? (i.totals.costUsd / max) * 100 : 0}%`, background: i.color }}
              />
            </div>
            <div className="ml-4 mt-1 font-mono text-[10px] text-slate-500">
              {i.totals.runs} runs · {i.totals.turns} turns{i.sub ? ` · ${i.sub}` : ""}
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
