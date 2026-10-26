import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { CheckCircle2, CircleDot, FolderGit2, FolderPlus, Loader, Rocket } from "lucide-react";
import { api, type ProjectSummary } from "../lib/api.ts";
import { href } from "../lib/router.ts";
import { KIND_STYLE, timeAgo } from "../lib/util.ts";
import { Button, Dot, Empty, Panel } from "./ui.tsx";

export function Overview({ projects, onAdd }: { projects: ProjectSummary[]; onAdd: () => void }) {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const o = overview.data;

  const stats = [
    { label: "Projects", value: o?.projects, icon: <FolderGit2 size={16} />, color: "#a78bfa" },
    { label: "To do", value: o?.counts.todo, icon: <CircleDot size={16} />, color: "#22d3ee" },
    { label: "In progress", value: o?.counts.doing, icon: <Loader size={16} />, color: "#fbbf24" },
    { label: "Completed", value: o?.counts.done, icon: <CheckCircle2 size={16} />, color: "#34d399" },
  ];

  if (projects.length === 0 && !overview.isLoading)
    return (
      <div className="mx-auto max-w-xl p-10">
        <Panel>
          <Empty icon={<Rocket size={20} />} title="No projects on the board yet">
            Add a folder, or import one of the folders you've already used Claude Code in.
            <div className="mt-4">
              <Button variant="primary" onClick={onAdd}>
                <FolderPlus size={14} /> Add project
              </Button>
            </div>
          </Empty>
        </Panel>
      </div>
    );

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <h1 className="glow-text text-2xl font-semibold tracking-tight text-white">Status report</h1>
        <p className="mt-1 text-sm text-slate-400">Everything you left half-built, in one place.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s, i) => (
          <motion.div key={s.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Panel className="relative overflow-hidden p-4">
              <div
                className="absolute -right-6 -top-6 h-20 w-20 rounded-full opacity-20 blur-2xl"
                style={{ background: s.color }}
              />
              <div className="flex items-center justify-between">
                <span className="hud-label">{s.label}</span>
                <span style={{ color: s.color }}>{s.icon}</span>
              </div>
              <div className="mt-2 font-mono text-3xl font-semibold text-white">{s.value ?? "–"}</div>
            </Panel>
          </motion.div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel className="p-4">
          <div className="hud-label mb-3">Next up</div>
          {o?.nextUp.length === 0 && <div className="py-6 text-center text-sm text-slate-500">Nothing open. Suspicious.</div>}
          <ul className="space-y-1">
            {o?.nextUp.map((t) => (
              <li key={`${t.projectId}-${t.id}`}>
                <a
                  href={href({ name: "project", id: t.projectId, tab: "tasks" })}
                  className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-white/[0.04]"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: KIND_STYLE[t.kind].color }}
                    title={KIND_STYLE[t.kind].label}
                  />
                  <span className="flex-1 truncate text-sm text-slate-200">{t.title}</span>
                  {t.status === "doing" && (
                    <span className="rounded bg-amber-400/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">doing</span>
                  )}
                  <span className="shrink-0 font-mono text-[10px]" style={{ color: t.projectColor }}>
                    {t.projectName}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel className="p-4">
          <div className="hud-label mb-3">Recently completed</div>
          {o?.recentlyDone.length === 0 && <div className="py-6 text-center text-sm text-slate-500">No completed tasks yet.</div>}
          <ol className="relative ml-1.5 space-y-3 border-l border-white/10 pl-4">
            {o?.recentlyDone.map((t) => (
              <li key={`${t.projectId}-${t.id}`} className="relative">
                <span
                  className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full"
                  style={{ background: t.projectColor, boxShadow: `0 0 8px ${t.projectColor}` }}
                />
                <div className="truncate text-sm text-slate-300">{t.title}</div>
                <div className="font-mono text-[10px] text-slate-500">
                  {t.projectName} · {timeAgo(t.doneAt ?? t.updatedAt)}
                </div>
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      <div>
        <div className="hud-label mb-3">All projects</div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => {
            const total = p.counts.todo + p.counts.doing + p.counts.done;
            const pct = total ? Math.round((p.counts.done / total) * 100) : 0;
            return (
              <a key={p.id} href={href({ name: "project", id: p.id, tab: "tasks" })} className="group">
                <Panel className="h-full p-4 transition group-hover:border-white/20">
                  <div className="flex items-center gap-2">
                    <Dot color={p.color} />
                    <span className="truncate font-medium text-white">{p.name}</span>
                    <span className="ml-auto font-mono text-[10px] text-slate-500">{timeAgo(p.lastSessionAt ?? p.git.lastCommitAt)}</span>
                  </div>
                  <p className="mt-1 line-clamp-1 min-h-5 text-xs text-slate-500">
                    {p.description || p.git.lastCommitMessage || p.path}
                  </p>
                  <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: p.color, boxShadow: `0 0 10px ${p.color}` }} />
                  </div>
                  <div className="mt-2 flex gap-3 font-mono text-[10px] text-slate-400">
                    <span>{p.counts.todo} todo</span>
                    <span>{p.counts.doing} doing</span>
                    <span>{p.counts.done} done</span>
                    {p.git.branch && <span className="ml-auto truncate text-slate-500">⎇ {p.git.branch}</span>}
                  </div>
                </Panel>
              </a>
            );
          })}
        </div>
      </div>
    </div>
  );
}
