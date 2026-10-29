import { useEffect, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { motion } from "framer-motion";
import { CheckSquare, CircleDollarSign, Smartphone, FolderTree, FolderX, GitBranch, History, MessageSquare, Pin, PinOff, Settings2, TerminalSquare, Trash2 } from "lucide-react";
import { api, type PermissionMode } from "../lib/api.ts";
import { href, navigate, type Route, type Tab } from "../lib/router.ts";
import { activeRuns, useRuns } from "../lib/runs.ts";
import { timeAgo } from "../lib/util.ts";
import { Button, Dot, ErrorNote, IconButton, Modal, ModalHeader } from "./ui.tsx";
import { TaskBoard } from "./TaskBoard.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { UsagePanel } from "./UsagePanel.tsx";
import { DevPanel } from "./DevPanel.tsx";
import { FilesPanel } from "./FilesPanel.tsx";
import { EmulatorPanel } from "./EmulatorPanel.tsx";

const COLORS = ["#22d3ee", "#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#fb7185", "#2dd4bf"];

export function ProjectView({ route }: { route: Extract<Route, { name: "project" }> }) {
  const qc = useQueryClient();
  const project = useQuery({ queryKey: ["project", route.id], queryFn: () => api.project(route.id) });
  const live = activeRuns(useRuns(), route.id);
  const waiting = live.flatMap((r) => r.permissions);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // For the Dev tab's badge; the Dev tab itself follows the server live and refreshes this.
  const dev = useQuery({ queryKey: ["dev", route.id], queryFn: () => api.devServer(route.id), refetchInterval: 15_000 });
  // The Android tab only shows on Android projects (or when opened by its link).
  const android = useQuery({ queryKey: ["android", route.id], queryFn: () => api.androidProject(route.id) });

  const update = useMutation({
    mutationFn: (body: Parameters<typeof api.updateProject>[1]) => api.updateProject(route.id, body),
    onSuccess: (p) => {
      qc.setQueryData(["project", route.id], p);
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  // Record the visit so recently used projects float to the top of the sidebar.
  useEffect(() => {
    api.updateProject(route.id, { touch: true }).catch(() => {});
  }, [route.id]);

  if (project.isError) return <div className="p-6"><ErrorNote>{project.error.message}</ErrorNote></div>;
  const p = project.data;
  if (!p) return <div className="p-6 text-sm text-slate-500">Loading…</div>;

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode; badge?: string | number }> = [
    { id: "tasks", label: "Tasks", icon: <CheckSquare size={14} />, badge: p.counts.todo + p.counts.doing || undefined },
    {
      id: "chat",
      label: "Chat",
      icon: <MessageSquare size={14} />,
      badge: waiting.length
        ? waiting.some((p) => p.toolName === "AskUserQuestion")
          ? "answer"
          : "approve"
        : live.length
          ? "live"
          : undefined,
    },
    { id: "history", label: "History", icon: <History size={14} /> },
    { id: "files", label: "Files", icon: <FolderTree size={14} /> },
    {
      id: "dev",
      label: "Dev",
      icon: <TerminalSquare size={14} />,
      badge: dev.data?.status === "running" ? "on" : dev.data?.status === "crashed" ? "crashed" : undefined,
    },
    ...(android.data?.isAndroid || route.tab === "android"
      ? [{ id: "android" as const, label: "Android", icon: <Smartphone size={14} /> }]
      : []),
    { id: "usage", label: "Usage", icon: <CircleDollarSign size={14} /> },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ "--accent": p.color } as CSSProperties}>
      <div className="shrink-0 px-6 pt-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <Dot color={p.color} />
              <h1 className="glow-text truncate text-2xl font-semibold tracking-tight text-white">{p.name}</h1>
              <IconButton onClick={() => update.mutate({ pinned: !p.pinned })} title={p.pinned ? "Unpin" : "Pin to top"}>
                {p.pinned ? <PinOff size={14} /> : <Pin size={14} />}
              </IconButton>
              <IconButton onClick={() => setSettingsOpen(true)} title="Project settings">
                <Settings2 size={14} />
              </IconButton>
            </div>
            {p.description && <p className="mt-1 text-sm text-slate-400">{p.description}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-slate-500">
              <span className="truncate">{p.path}</span>
              {p.git.isRepo && (
                <span className="flex items-center gap-1">
                  <GitBranch size={11} /> {p.git.branch}
                  {p.git.dirty ? <span className="text-amber-300">· {p.git.dirty} changed</span> : <span className="text-emerald-400">· clean</span>}
                </span>
              )}
              {p.git.lastCommitAt && (
                <span className="truncate" title={p.git.lastCommitMessage}>
                  last commit {timeAgo(p.git.lastCommitAt)} · “{p.git.lastCommitMessage}”
                </span>
              )}
            </div>
          </div>
        </div>
        {!p.exists && (
          <div className="mt-3">
            <ErrorNote>
              <FolderX size={13} className="mr-1 inline" /> This folder no longer exists. Tasks and chat are unavailable.
            </ErrorNote>
          </div>
        )}

        <div className="mt-5 flex gap-1 border-b border-white/[0.06]">
          {tabs.map((t) => (
            <a
              key={t.id}
              href={href({ name: "project", id: p.id, tab: t.id })}
              className={clsx(
                "relative flex items-center gap-2 px-3.5 pb-2.5 pt-1 text-sm transition",
                route.tab === t.id ? "text-white" : "text-slate-400 hover:text-slate-200",
              )}
            >
              {t.icon}
              {t.label}
              {t.badge !== undefined && (
                <span
                  className={clsx(
                    "rounded-full px-1.5 font-mono text-[10px]",
                    t.badge === "crashed"
                      ? "bg-rose-500/80 text-white"
                      : t.badge === "approve" || t.badge === "answer"
                        ? "animate-pulse bg-amber-400 text-slate-950"
                        : t.badge === "live" || t.badge === "on"
                          ? "animate-pulse bg-[var(--accent)] text-slate-950"
                          : "bg-white/10 text-slate-300",
                  )}
                >
                  {t.badge}
                </span>
              )}
              {route.tab === t.id && (
                <motion.div
                  layoutId="tab-underline"
                  className="absolute inset-x-2 -bottom-px h-px bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]"
                />
              )}
            </a>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {p.exists && route.tab === "tasks" && <TaskBoard projectId={p.id} />}
        {p.exists && route.tab === "chat" && <ChatPanel projectId={p.id} />}
        {p.exists && route.tab === "files" && <FilesPanel projectId={p.id} filePath={route.filePath} />}
        {p.exists && route.tab === "dev" && <DevPanel projectId={p.id} />}
        {p.exists && route.tab === "android" && <EmulatorPanel projectId={p.id} />}
        {route.tab === "history" && <HistoryPanel projectId={p.id} sessionId={route.sessionId} />}
        {route.tab === "usage" && (
          <div className="mx-auto max-w-5xl p-6">
            <UsagePanel projectId={p.id} />
          </div>
        )}
      </div>

      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)}>
        <ModalHeader title="Project settings" onClose={() => setSettingsOpen(false)} />
        <form
          className="space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            update.mutate(
              { name: String(f.get("name")), description: String(f.get("description")) },
              { onSuccess: () => setSettingsOpen(false) },
            );
          }}
        >
          <label className="block space-y-1.5">
            <span className="hud-label">Name</span>
            <input name="name" defaultValue={p.name} className="accent-ring h-9 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-white" />
          </label>
          <label className="block space-y-1.5">
            <span className="hud-label">Description</span>
            <textarea
              name="description"
              defaultValue={p.description}
              rows={2}
              className="accent-ring w-full resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
            />
          </label>
          <div className="space-y-1.5">
            <span className="hud-label">Color</span>
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  onClick={() => update.mutate({ color: c })}
                  className={clsx("h-6 w-6 rounded-full transition", p.color === c && "ring-2 ring-white ring-offset-2 ring-offset-slate-900")}
                  style={{ background: c, boxShadow: `0 0 12px ${c}66` }}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>
          <div className="space-y-2 rounded-xl border border-white/10 bg-black/20 p-3">
            <span className="hud-label">Task automation</span>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={p.autoRun}
                onChange={(e) => update.mutate({ autoRun: e.target.checked })}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <span className="text-sm text-slate-200">
                Start a Claude session when a task moves to In progress
                <span className="block text-xs text-slate-500">
                  The card moves to Done when Claude confirms it finished.
                  {p.parallelTasks ? " Tasks run side by side, each in its own worktree." : " One task runs at a time per project; others queue."}
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={p.parallelTasks}
                onChange={(e) => update.mutate({ parallelTasks: e.target.checked })}
                disabled={!p.git.isRepo}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <span className={clsx("text-sm", p.git.isRepo ? "text-slate-200" : "text-slate-500")}>
                Run tasks in parallel, each in its own git worktree and branch
                <span className="block text-xs text-slate-500">
                  {p.git.isRepo
                    ? "Each task gets a checkout under .claude/worktrees/ on a task/… branch, so several can run at once. Reviewing a task means merging its branch."
                    : "Needs the project to be a git repository."}
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={p.featureBranches}
                onChange={(e) => update.mutate({ featureBranches: e.target.checked })}
                disabled={!p.git.isRepo}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <span className={clsx("text-sm", p.git.isRepo ? "text-slate-200" : "text-slate-500")}>
                Give feature tasks their own branch
                <span className="block text-xs text-slate-500">
                  {p.git.isRepo
                    ? "Feature tasks work in their own worktree on a feature/… branch, so your checkout stays where it is. Review them to merge, or to commit, push and open a pull request."
                    : "Needs the project to be a git repository."}
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={p.autoReview}
                onChange={(e) => update.mutate({ autoReview: e.target.checked })}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <span className="text-sm text-slate-200">
                Review finished tasks and suggest what's next
                <span className="block text-xs text-slate-500">
                  When a task reaches Done, a read-only review agent looks over its changes, notes problems on the card,
                  and adds up to 3 follow-up tasks (bugs, loose ends, next improvements) to To do.
                </span>
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              Task sessions run in
              <select
                value={p.autoPermissionMode}
                onChange={(e) => update.mutate({ autoPermissionMode: e.target.value as PermissionMode })}
                className="h-8 rounded-lg border border-white/10 bg-black/30 px-2 text-xs text-slate-200 focus:outline-none"
              >
                <option value="default" className="bg-slate-900">Ask first</option>
                <option value="acceptEdits" className="bg-slate-900">Accept edits</option>
                <option value="plan" className="bg-slate-900">Plan only</option>
                <option value="bypassPermissions" className="bg-slate-900">Full access</option>
              </select>
              mode
            </label>
          </div>
          {update.error && <ErrorNote>{update.error.message}</ErrorNote>}
          <div className="flex items-center justify-between pt-2">
            <Button
              type="button"
              variant="danger"
              onClick={async () => {
                if (!confirm(`Remove "${p.name}" from the dashboard? The folder and its files are not touched.`)) return;
                await api.removeProject(p.id);
                qc.invalidateQueries({ queryKey: ["projects"] });
                qc.invalidateQueries({ queryKey: ["overview"] });
                navigate({ name: "overview" });
              }}
            >
              <Trash2 size={13} /> Remove from dashboard
            </Button>
            <Button type="submit" variant="primary" disabled={update.isPending}>
              Save
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
