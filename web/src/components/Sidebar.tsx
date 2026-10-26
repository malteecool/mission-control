import clsx from "clsx";
import { motion } from "framer-motion";
import { FolderX, LayoutGrid, Pin, Plus, Settings2 } from "lucide-react";
import type { ProjectSummary } from "../lib/api.ts";
import { href, useRoute } from "../lib/router.ts";
import { activeRuns, useRuns } from "../lib/runs.ts";
import { timeAgo } from "../lib/util.ts";
import { Dot } from "./ui.tsx";

export function Sidebar({
  projects,
  loading,
  onAdd,
}: {
  projects: ProjectSummary[];
  loading: boolean;
  onAdd: () => void;
}) {
  const route = useRoute();
  const live = activeRuns(useRuns());
  const running = live.map((r) => r.projectId);
  const awaiting = live.filter((r) => r.permissions.length).map((r) => r.projectId);
  const activeId = route.name === "project" ? route.id : undefined;

  return (
    <aside className="hidden min-h-0 flex-col border-r border-white/[0.06] bg-[#060912]/70 backdrop-blur-xl md:flex">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.06] px-5">
        <div className="relative flex h-7 w-7 items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-400/10">
          <div className="h-2 w-2 rounded-full bg-violet-400 shadow-[0_0_12px_#a78bfa]" />
        </div>
        <div>
          <div className="text-[13px] font-semibold tracking-[0.2em] text-white">MISSION</div>
          <div className="-mt-0.5 font-mono text-[9px] tracking-[0.35em] text-cyan-300/80">CONTROL</div>
        </div>
      </div>

      <nav className="px-3 pt-3">
        <a
          href={href({ name: "overview" })}
          className={clsx(
            "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition",
            route.name === "overview" ? "bg-white/[0.07] text-white" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
          )}
        >
          <LayoutGrid size={15} /> Overview
        </a>
        <a
          href={href({ name: "settings" })}
          className={clsx(
            "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition",
            route.name === "settings" ? "bg-white/[0.07] text-white" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
          )}
        >
          <Settings2 size={15} /> Settings
        </a>
      </nav>

      <div className="flex items-center justify-between px-6 pb-2 pt-5">
        <span className="hud-label">Projects · {projects.length}</span>
        <button
          onClick={onAdd}
          className="rounded-md p-1 text-slate-400 transition hover:bg-white/10 hover:text-white"
          aria-label="Add project"
          title="Add project"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {loading && <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>}
        {!loading && projects.length === 0 && (
          <button
            onClick={onAdd}
            className="w-full rounded-lg border border-dashed border-white/15 px-3 py-4 text-xs text-slate-400 hover:border-cyan-400/40 hover:text-cyan-200"
          >
            + Add your first project
          </button>
        )}
        <ul className="space-y-0.5">
          {projects.map((p) => {
            const active = p.id === activeId;
            const open = p.counts.todo + p.counts.doing;
            return (
              <li key={p.id} className="relative">
                {active && (
                  <motion.div
                    layoutId="sidebar-active"
                    className="absolute inset-0 rounded-lg border border-white/10 bg-white/[0.06]"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                )}
                <a
                  href={href({ name: "project", id: p.id, tab: route.name === "project" ? route.tab : "tasks" })}
                  className={clsx(
                    "relative flex items-center gap-2.5 rounded-lg px-3 py-2 transition",
                    active ? "text-white" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200",
                  )}
                >
                  <Dot color={p.color} pulse={running.includes(p.id)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-sm">
                      <span className="truncate">{p.name}</span>
                      {p.pinned && <Pin size={10} className="shrink-0 text-slate-500" />}
                      {!p.exists && <FolderX size={11} className="shrink-0 text-rose-400" />}
                    </div>
                    <div className="truncate font-mono text-[10px] text-slate-500">
                      {p.git.branch ? `${p.git.branch}${p.git.dirty ? ` · ${p.git.dirty}Δ` : ""} · ` : ""}
                      {timeAgo(p.lastSessionAt ?? p.git.lastCommitAt ?? p.createdAt)}
                    </div>
                  </div>
                  {awaiting.includes(p.id) && (
                    <span
                      className="animate-pulse rounded-full bg-amber-400 px-1.5 py-0.5 font-mono text-[10px] text-slate-950"
                      title="Claude is waiting for your approval or answer"
                    >
                      waiting
                    </span>
                  )}
                  {open > 0 && (
                    <span
                      className="rounded-full px-1.5 py-0.5 font-mono text-[10px]"
                      style={{ background: `${p.color}1f`, color: p.color }}
                    >
                      {open}
                    </span>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
