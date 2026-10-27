// Cost and usage: every finished run's reported cost is stored, then totalled per day, project and task.
import { db, listProjects } from "../db.ts";
import type { ChatEvent, RunInfo, Task, UsageReport, UsageTotals } from "../types.ts";
import { readTasks } from "./tasks.ts";

interface UsageRow {
  project_id: number;
  task_id: string | null;
  session_id: string | null;
  title: string;
  finished_at: string;
  cost_usd: number;
  num_turns: number;
}

/** Stores a finished run's cost. Runs without a final result (stopped, crashed) report no cost and are skipped. */
export function recordUsage(info: RunInfo, last: ChatEvent | null) {
  if (last?.type !== "done") return;
  db.prepare(
    `INSERT OR REPLACE INTO run_usage
       (run_id, project_id, task_id, session_id, title, model, status, started_at, finished_at, cost_usd, num_turns, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    info.id,
    info.projectId,
    info.taskId ?? null,
    last.sessionId ?? info.sessionId ?? null,
    info.title,
    info.model ?? null,
    info.status,
    info.startedAt,
    info.finishedAt ?? new Date().toISOString(),
    last.costUsd ?? 0,
    last.numTurns ?? 0,
    last.durationMs ?? null,
  );
}

const zero = (): UsageTotals => ({ costUsd: 0, runs: 0, turns: 0 });
function add(t: UsageTotals, r: UsageRow) {
  t.costUsd += r.cost_usd;
  t.runs++;
  t.turns += r.num_turns;
}

/** The server runs on your machine, so its local date is your local date. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Totals for everything, or one project, with a zero-filled series for the last `days` days. */
export async function usageReport(opts: { projectId?: number; days: number }): Promise<UsageReport> {
  const rows = (
    opts.projectId === undefined
      ? db.prepare("SELECT * FROM run_usage").all()
      : db.prepare("SELECT * FROM run_usage WHERE project_id = ?").all(opts.projectId)
  ) as unknown as UsageRow[];

  const projects = listProjects().filter((p) => opts.projectId === undefined || p.id === opts.projectId);
  // Chat turns in a task's session (e.g. replying after Claude said it was blocked) count towards that task.
  const tasks = new Map<string, Task & { projectId: number }>();
  const bySession = new Map<string, string>();
  await Promise.all(
    projects.map(async (p) => {
      for (const t of await readTasks(p.path).catch(() => [] as Task[])) {
        tasks.set(t.id, { ...t, projectId: p.id });
        if (t.sessionId) bySession.set(t.sessionId, t.id);
      }
    }),
  );

  const now = new Date();
  const days = new Map<string, UsageTotals>();
  for (let i = opts.days - 1; i >= 0; i--)
    days.set(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)), zero());
  const today = dayKey(now);

  const total = zero();
  const period = zero();
  const todayTotals = zero();
  const byProject = new Map<number, UsageTotals>();
  const byTask = new Map<string, UsageTotals & { projectId: number; title: string; lastRunAt: string }>();

  for (const r of rows) {
    add(total, r);
    const day = dayKey(new Date(r.finished_at));
    const d = days.get(day);
    if (d) {
      add(d, r);
      add(period, r);
    }
    if (day === today) add(todayTotals, r);

    if (!byProject.has(r.project_id)) byProject.set(r.project_id, zero());
    add(byProject.get(r.project_id)!, r);

    const taskId = r.task_id ?? (r.session_id ? bySession.get(r.session_id) : undefined);
    if (taskId) {
      let t = byTask.get(taskId);
      if (!t) byTask.set(taskId, (t = { ...zero(), projectId: r.project_id, title: "", lastRunAt: r.finished_at }));
      add(t, r);
      // Task runs are titled after the task; that's the best name left once a task is deleted.
      if (r.task_id && !t.title) t.title = r.title;
      if (r.finished_at > t.lastRunAt) t.lastRunAt = r.finished_at;
    }
  }

  const info = new Map(listProjects().map((p) => [p.id, p]));
  return {
    total,
    today: todayTotals,
    period,
    days: [...days].map(([day, t]) => ({ day, ...t })),
    projects: [...byProject]
      .map(([projectId, t]) => ({
        projectId,
        name: info.get(projectId)?.name ?? "Removed project",
        color: info.get(projectId)?.color ?? "#64748b",
        ...t,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    tasks: [...byTask]
      .map(([taskId, t]) => {
        const task = tasks.get(taskId);
        return { ...t, taskId, title: task?.title ?? (t.title || "Deleted task"), status: task?.status };
      })
      .sort((a, b) => b.costUsd - a.costUsd),
  };
}
