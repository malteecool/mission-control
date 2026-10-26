import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, ListTodo, MessageSquare, Plus, Trash2 } from "lucide-react";
import { api, type Task, type TaskKind, type TaskPriority, type TaskStatus } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { chat } from "../lib/chatStore.ts";
import { KIND_STYLE, timeAgo } from "../lib/util.ts";
import { Empty, ErrorNote, IconButton, Kbd } from "./ui.tsx";

const COLUMNS: Array<{ status: TaskStatus; label: string; color: string }> = [
  { status: "todo", label: "To do", color: "#22d3ee" },
  { status: "doing", label: "In progress", color: "#fbbf24" },
  { status: "done", label: "Done", color: "#34d399" },
];
const KINDS = Object.keys(KIND_STYLE) as TaskKind[];

/** "Fix login #bug !1" → title "Fix login", kind bug, priority 1. */
function parseQuickAdd(raw: string): { title: string; kind?: TaskKind; priority?: TaskPriority } {
  let kind: TaskKind | undefined;
  let priority: TaskPriority | undefined;
  const title = raw
    .replace(/(^|\s)#(feature|bug|chore|idea)\b/gi, (_, sp, k) => {
      kind = k.toLowerCase() as TaskKind;
      return sp;
    })
    .replace(/(^|\s)!([123])\b/g, (_, sp, n) => {
      priority = Number(n) as TaskPriority;
      return sp;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { title, kind, priority };
}

export function TaskBoard({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const key = ["tasks", projectId];
  const tasks = useQuery({ queryKey: key, queryFn: () => api.tasks(projectId), refetchInterval: 15_000 });
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState<TaskKind | "all">("all");
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["projects"] });
    qc.invalidateQueries({ queryKey: ["project", projectId] });
    qc.invalidateQueries({ queryKey: ["overview"] });
  };

  const add = useMutation({ mutationFn: (t: Partial<Task>) => api.addTask(projectId, t), onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, ...patch }: Partial<Task> & { id: string }) => api.updateTask(projectId, id, patch),
    // Optimistic so drag-and-drop feels instant.
    onMutate: async ({ id, ...patch }) => {
      await qc.cancelQueries({ queryKey: key });
      qc.setQueryData<Task[]>(key, (old) => old?.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    },
    onSuccess: (task, variables) => {
      if (task && variables.status === "doing") workOn(task);
      invalidate();
    },
    onError: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteTask(projectId, id), onSuccess: invalidate });

  const byStatus = useMemo(() => {
    const out: Record<TaskStatus, Task[]> = { todo: [], doing: [], done: [] };
    for (const t of tasks.data ?? []) if (filter === "all" || t.kind === filter) out[t.status].push(t);
    out.todo.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
    out.doing.sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt));
    out.done.sort((a, b) => (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt));
    return out;
  }, [tasks.data, filter]);

  const workOn = (t: Task) => {
    chat.setComposer(
      projectId,
      `Let's work on this task from .dashboard/tasks.json (id: ${t.id}):\n\n"${t.title}"${t.notes ? `\n\nNotes: ${t.notes}` : ""}\n\n` +
        `Set its status to "doing" when you start and "done" when it's finished, and add any follow-up tasks to the same file.`,
    );
    navigate({ name: "project", id: projectId, tab: "chat" });
  };

  const submit = () => {
    const parsed = parseQuickAdd(draft);
    if (!parsed.title) return;
    // Clear right away so you can keep typing the next task; restore the text if saving fails.
    const raw = draft;
    setDraft("");
    add.mutate(parsed, { onError: () => setDraft((d) => d || raw) });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <form
          className="accent-ring flex h-10 min-w-[260px] flex-1 items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Plus size={15} className="text-[var(--accent)]" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a task…  use #bug #idea #chore and !1 for priority"
            className="h-full flex-1 bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none"
          />
          <Kbd>Enter</Kbd>
        </form>
        <div className="flex gap-1 rounded-xl border border-white/10 bg-black/20 p-1">
          {(["all", ...KINDS] as const).map((k) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={clsx(
                "rounded-lg px-2.5 py-1 text-xs capitalize transition",
                filter === k ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200",
              )}
            >
              {k === "all" ? "All" : KIND_STYLE[k].label}
            </button>
          ))}
        </div>
      </div>

      {(add.error || update.error || remove.error || tasks.error) && (
        <ErrorNote>{(add.error ?? update.error ?? remove.error ?? tasks.error)!.message}</ErrorNote>
      )}

      {tasks.data?.length === 0 ? (
        <Empty icon={<ListTodo size={20} />} title="No tasks yet">
          Type one above. Tasks are saved in <code className="font-mono text-xs">.dashboard/tasks.json</code> inside the
          project, so Claude can read and update them too.
        </Empty>
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-3">
          {COLUMNS.map((col, ci) => (
            <section
              key={col.status}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(col.status);
              }}
              onDragLeave={() => setDragOver((s) => (s === col.status ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const id = e.dataTransfer.getData("text/task-id");
                const t = tasks.data?.find((x) => x.id === id);
                if (t && t.status !== col.status) update.mutate({ id, status: col.status });
              }}
              className={clsx(
                "glass flex min-h-[200px] flex-col rounded-2xl transition",
                dragOver === col.status && "border-[color-mix(in_srgb,var(--accent)_60%,transparent)]",
              )}
            >
              <header className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: col.color, boxShadow: `0 0 8px ${col.color}` }} />
                <span className="hud-label">{col.label}</span>
                <span className="ml-auto font-mono text-[11px] text-slate-500">{byStatus[col.status].length}</span>
              </header>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                <AnimatePresence initial={false}>
                  {byStatus[col.status].map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      onMove={(dir) => update.mutate({ id: t.id, status: COLUMNS[ci + dir].status })}
                      canLeft={ci > 0}
                      canRight={ci < COLUMNS.length - 1}
                      onRename={(title) => update.mutate({ id: t.id, title })}
                      onKind={(kind) => update.mutate({ id: t.id, kind })}
                      onPriority={(priority) => update.mutate({ id: t.id, priority })}
                      onNotes={(notes) => update.mutate({ id: t.id, notes })}
                      onDelete={() => remove.mutate(t.id)}
                      onWorkOn={() => workOn(t)}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

const PRIORITY_STYLE: Record<TaskPriority, string> = {
  1: "text-rose-300 bg-rose-500/10",
  2: "text-slate-300 bg-white/5",
  3: "text-slate-500 bg-white/[0.03]",
};

function TaskCard({
  task: t,
  onMove,
  canLeft,
  canRight,
  onRename,
  onKind,
  onPriority,
  onNotes,
  onDelete,
  onWorkOn,
}: {
  task: Task;
  onMove: (dir: -1 | 1) => void;
  canLeft: boolean;
  canRight: boolean;
  onRename: (title: string) => void;
  onKind: (k: TaskKind) => void;
  onPriority: (p: TaskPriority) => void;
  onNotes: (notes: string) => void;
  onDelete: () => void;
  onWorkOn: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const kind = KIND_STYLE[t.kind];
  const done = t.status === "done";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
    >
      <div
        draggable={!editing}
        onDragStart={(e) => e.dataTransfer.setData("text/task-id", t.id)}
        className="group relative cursor-grab rounded-xl border border-white/[0.07] bg-white/[0.03] p-3 transition hover:border-white/15 hover:bg-white/[0.05] active:cursor-grabbing"
      >
        <div className="absolute inset-y-3 left-0 w-0.5 rounded-full" style={{ background: kind.color, boxShadow: `0 0 8px ${kind.color}` }} />
        {editing ? (
          <input
            autoFocus
            defaultValue={t.title}
            onBlur={(e) => {
              setEditing(false);
              if (e.target.value.trim() && e.target.value.trim() !== t.title) onRename(e.target.value.trim());
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditing(false);
            }}
            className="w-full rounded bg-black/40 px-1 text-sm text-white focus:outline-none"
          />
        ) : (
          <div
            onDoubleClick={() => setEditing(true)}
            onClick={() => setExpanded((x) => !x)}
            className={clsx("pl-1.5 text-sm leading-snug", done ? "text-slate-500 line-through decoration-slate-600" : "text-slate-100")}
            title="Click for details · double-click to rename"
          >
            {t.title}
          </div>
        )}

        <div className="mt-2 flex items-center gap-1.5 pl-1.5">
          <select
            value={t.kind}
            onChange={(e) => onKind(e.target.value as TaskKind)}
            className="cursor-pointer appearance-none rounded bg-transparent font-mono text-[10px] uppercase tracking-wider focus:outline-none"
            style={{ color: kind.color }}
            title="Kind"
          >
            {KINDS.map((k) => (
              <option key={k} value={k} className="bg-slate-900 text-slate-200">
                {KIND_STYLE[k].label}
              </option>
            ))}
          </select>
          <button
            onClick={() => onPriority((((t.priority % 3) + 1) as TaskPriority))}
            className={clsx("rounded px-1 font-mono text-[10px]", PRIORITY_STYLE[t.priority])}
            title="Priority (click to cycle)"
          >
            P{t.priority}
          </button>
          <span className="font-mono text-[10px] text-slate-600">{timeAgo(done ? t.doneAt : t.updatedAt)}</span>

          <div className="ml-auto flex items-center opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            {!done && (
              <IconButton onClick={onWorkOn} title="Work on this with Claude">
                <MessageSquare size={13} />
              </IconButton>
            )}
            <IconButton onClick={() => onMove(-1)} disabled={!canLeft} title="Move left" className="disabled:opacity-20">
              <ChevronLeft size={14} />
            </IconButton>
            <IconButton onClick={() => onMove(1)} disabled={!canRight} title="Move right" className="disabled:opacity-20">
              <ChevronRight size={14} />
            </IconButton>
            <IconButton onClick={onDelete} title="Delete" className="hover:text-rose-300">
              <Trash2 size={13} />
            </IconButton>
          </div>
        </div>

        {expanded && (
          <textarea
            defaultValue={t.notes ?? ""}
            placeholder="Notes…"
            rows={3}
            onBlur={(e) => e.target.value !== (t.notes ?? "") && onNotes(e.target.value)}
            className="mt-2 w-full resize-y rounded-lg border border-white/10 bg-black/30 p-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none"
          />
        )}
        {!expanded && t.notes && <div className="mt-1.5 line-clamp-2 pl-1.5 text-xs text-slate-500">{t.notes}</div>}
      </div>
    </motion.div>
  );
}
