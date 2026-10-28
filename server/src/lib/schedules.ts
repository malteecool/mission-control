// Recurring tasks, e.g. "Every Monday: update dependencies and run tests". Each time a schedule comes round, a fresh
// task lands on its project's board and, with autoStart, a Claude session starts on it like any other task run.
// Schedules belong to the dashboard rather than the project folder, so they live in the database. The scheduler checks
// every half minute; one that came round while the dashboard was closed runs once when it starts again.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { db, getProject } from "../db.ts";
import type { Schedule, ScheduleRule, Task } from "../types.ts";
import { KINDS, createTask, getTask, updateTask } from "./tasks.ts";
import { startTaskRun } from "./taskRuns.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS schedules (
    id         TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL,
    body       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS schedules_project ON schedules (project_id);
`);

const FREQS: ScheduleRule["freq"][] = ["hourly", "daily", "weekdays", "weekly", "monthly"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const parse = (row: { body: string }) => JSON.parse(row.body) as Schedule;

export function listSchedules(projectId?: number): Schedule[] {
  const rows = (
    projectId === undefined
      ? db.prepare("SELECT body FROM schedules").all()
      : db.prepare("SELECT body FROM schedules WHERE project_id = ?").all(projectId)
  ) as Array<{ body: string }>;
  return rows.map(parse).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getSchedule(id: string): Schedule | undefined {
  const row = db.prepare("SELECT body FROM schedules WHERE id = ?").get(id) as { body: string } | undefined;
  return row ? parse(row) : undefined;
}

function save(s: Schedule): Schedule {
  db.prepare("INSERT OR REPLACE INTO schedules (id, project_id, body) VALUES (?, ?, ?)").run(s.id, s.projectId, JSON.stringify(s));
  return s;
}

export function deleteSchedule(id: string): boolean {
  return db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes > 0;
}

export function deleteProjectSchedules(projectId: number) {
  db.prepare("DELETE FROM schedules WHERE project_id = ?").run(projectId);
}

const lastDayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

function dayMatches(rule: ScheduleRule, d: Date): boolean {
  switch (rule.freq) {
    case "weekdays":
      return d.getDay() >= 1 && d.getDay() <= 5;
    case "weekly":
      return (rule.days ?? []).includes(d.getDay());
    case "monthly":
      return d.getDate() === Math.min(rule.monthDay ?? 1, lastDayOf(d));
    default:
      return true;
  }
}

/** The first time the rule comes round strictly after `after`, in local time. */
export function nextOccurrence(rule: ScheduleRule, after: Date): Date | undefined {
  const [h, m] = rule.time.split(":").map(Number);
  const hours = rule.freq === "hourly" ? [...Array(24).keys()].filter((x) => x % (rule.every ?? 1) === 0) : [h];
  // A year and a bit covers every rule, even a monthly one on the 31st.
  for (let i = 0; i < 400; i++) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i);
    if (!dayMatches(rule, day)) continue;
    for (const hour of hours) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, m);
      if (at > after) return at;
    }
  }
}

export type ScheduleInput = Partial<Pick<Schedule, "title" | "notes" | "kind" | "priority" | "planFirst" | "rule" | "enabled" | "autoStart">>;

export function validateScheduleInput(input: unknown, creating: boolean): ScheduleInput | string {
  if (!input || typeof input !== "object") return "Body must be an object";
  const i = input as Record<string, unknown>;
  const out: ScheduleInput = {};
  if (i.title !== undefined) {
    if (typeof i.title !== "string" || !i.title.trim()) return "title must be a non-empty string";
    out.title = i.title.trim().slice(0, 500);
  } else if (creating) return "title is required";
  if (i.notes !== undefined) {
    if (typeof i.notes !== "string") return "notes must be a string";
    out.notes = i.notes.slice(0, 10_000) || undefined;
  }
  if (i.kind !== undefined) {
    if (!KINDS.includes(i.kind as Schedule["kind"])) return `kind must be one of ${KINDS.join(", ")}`;
    out.kind = i.kind as Schedule["kind"];
  }
  if (i.priority !== undefined) {
    if (![1, 2, 3].includes(i.priority as number)) return "priority must be 1, 2 or 3";
    out.priority = i.priority as Schedule["priority"];
  }
  for (const k of ["planFirst", "enabled", "autoStart"] as const) {
    if (i[k] === undefined) continue;
    if (typeof i[k] !== "boolean") return `${k} must be a boolean`;
    out[k] = i[k] as boolean;
  }
  if (out.planFirst === false) out.planFirst = undefined;
  if (i.rule !== undefined) {
    const rule = validateRule(i.rule);
    if (typeof rule === "string") return rule;
    out.rule = rule;
  } else if (creating) return "rule is required";
  return out;
}

function validateRule(raw: unknown): ScheduleRule | string {
  if (!raw || typeof raw !== "object") return "rule must be an object";
  const r = raw as Record<string, unknown>;
  if (!FREQS.includes(r.freq as ScheduleRule["freq"])) return `rule.freq must be one of ${FREQS.join(", ")}`;
  if (typeof r.time !== "string" || !TIME_RE.test(r.time)) return "rule.time must be HH:MM";
  const rule: ScheduleRule = { freq: r.freq as ScheduleRule["freq"], time: r.time };
  if (rule.freq === "weekly") {
    const days = r.days;
    if (!Array.isArray(days) || !days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
      return "rule.days must list at least one day, 0 (Sunday) to 6";
    rule.days = [...new Set(days as number[])].sort();
  }
  if (rule.freq === "monthly") {
    if (!Number.isInteger(r.monthDay) || (r.monthDay as number) < 1 || (r.monthDay as number) > 31)
      return "rule.monthDay must be 1 to 31";
    rule.monthDay = r.monthDay as number;
  }
  if (rule.freq === "hourly") {
    if (![1, 2, 3, 4, 6, 8, 12].includes(r.every as number)) return "rule.every must be 1, 2, 3, 4, 6, 8 or 12";
    rule.every = r.every as number;
  }
  return rule;
}

export function createSchedule(projectId: number, input: ScheduleInput): Schedule {
  const s: Schedule = {
    id: randomUUID(),
    projectId,
    title: input.title!,
    notes: input.notes,
    kind: input.kind ?? "chore",
    priority: input.priority ?? 2,
    planFirst: input.planFirst,
    rule: input.rule!,
    enabled: input.enabled ?? true,
    autoStart: input.autoStart ?? true,
    createdAt: new Date().toISOString(),
  };
  return save(withNextRun(s));
}

export function updateSchedule(id: string, patch: ScheduleInput): Schedule | undefined {
  const prev = getSchedule(id);
  if (!prev) return undefined;
  const next = { ...prev, ...patch };
  // A new rule, or switching it back on, counts from now; anything else keeps the time it was due.
  const retime = patch.rule !== undefined || (patch.enabled !== undefined && patch.enabled !== prev.enabled);
  return save(retime ? withNextRun(next) : next);
}

function withNextRun(s: Schedule, from = new Date()): Schedule {
  return { ...s, nextRunAt: s.enabled ? nextOccurrence(s.rule, from)?.toISOString() : undefined };
}

/**
 * Puts a copy of the schedule's task on the board, starting it with autoStart. When it came round by itself (not
 * "Run now") and the task from last time is still open, skips this time rather than piling up copies.
 */
export async function fireSchedule(id: string, manual = false): Promise<Task | undefined> {
  const s = getSchedule(id);
  if (!s) return undefined;
  const now = new Date();
  const project = getProject(s.projectId);
  const finish = (note?: string, task?: Task) => {
    const latest = getSchedule(id);
    if (!latest) return;
    save({
      ...withNextRun(latest, now),
      lastNote: note,
      ...(task ? { lastRunAt: now.toISOString(), lastTaskId: task.id } : {}),
    });
  };
  if (!project || !fs.existsSync(project.path)) {
    finish("Skipped: the project folder wasn't found.");
    return undefined;
  }
  if (!manual && s.lastTaskId) {
    const prev = await getTask(project.path, s.lastTaskId).catch(() => undefined);
    if (prev && prev.status !== "done") {
      finish(`Skipped ${now.toLocaleString()}: the task from last time isn't done yet.`);
      return undefined;
    }
  }
  let task = await createTask(project.path, {
    title: s.title,
    notes: s.notes,
    kind: s.kind,
    priority: s.priority,
    planFirst: s.planFirst,
    scheduleId: s.id,
  });
  let note: string | undefined;
  if (s.autoStart) {
    task = (await updateTask(project.path, task.id, { status: "doing" })) ?? task;
    await startTaskRun(project, task).catch((err) => {
      note = `Couldn't start Claude: ${(err as Error).message}`;
    });
  }
  finish(note, task);
  return task;
}

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const s of listSchedules()) {
      if (!s.enabled || !s.nextRunAt || Date.parse(s.nextRunAt) > now) continue;
      await fireSchedule(s.id).catch((err) => console.error(`Schedule "${s.title}":`, err));
    }
  } finally {
    ticking = false;
  }
}

/** Starts checking for schedules that have come round. */
export function startScheduler() {
  // Give the server a moment to come up before catching up on anything missed.
  setTimeout(() => void tick(), 5_000);
  setInterval(() => void tick(), 30_000).unref();
}
