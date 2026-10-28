import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Task, TaskFile, TaskKind, TaskPriority, TaskStatus } from "../types.ts";

// Tasks live inside each project at .dashboard/tasks.json so Claude can read and edit them too.
export const TASK_FILE = path.join(".dashboard", "tasks.json");

export const STATUSES: TaskStatus[] = ["todo", "doing", "done"];
export const KINDS: TaskKind[] = ["feature", "bug", "chore", "idea"];

const locks = new Map<string, Promise<unknown>>();

/** Serialise read-modify-write cycles per project so concurrent edits don't clobber each other. */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

export async function readTasks(projectPath: string): Promise<Task[]> {
  try {
    const raw = await fs.readFile(path.join(projectPath, TASK_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<TaskFile>;
    return Array.isArray(parsed.tasks) ? parsed.tasks.map(normalise).filter((t): t is Task => !!t) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Be lenient with hand- or Claude-edited files: fill defaults, drop entries without a title. */
function normalise(raw: Partial<Task>): Task | null {
  if (!raw || typeof raw.title !== "string" || !raw.title.trim()) return null;
  const now = new Date().toISOString();
  return {
    ...raw,
    id: typeof raw.id === "string" && raw.id ? raw.id : randomUUID(),
    title: raw.title.trim(),
    status: STATUSES.includes(raw.status as TaskStatus) ? (raw.status as TaskStatus) : "todo",
    kind: KINDS.includes(raw.kind as TaskKind) ? (raw.kind as TaskKind) : "feature",
    priority: [1, 2, 3].includes(raw.priority as number) ? (raw.priority as TaskPriority) : 2,
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? raw.createdAt ?? now,
  };
}

async function writeTasks(projectPath: string, tasks: Task[]): Promise<void> {
  const file = path.join(projectPath, TASK_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body: TaskFile = { version: 1, tasks };
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(body, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

export type TaskInput = Partial<
  Pick<
    Task,
    "title" | "notes" | "status" | "kind" | "priority" | "sessionId" | "agentStatus" | "agentNote" | "review" | "planFirst" | "plan" | "planApproved" | "worktree" | "scheduleId" | "reviewer" | "origin"
  >
>;

export function validateTaskInput(input: unknown, requireTitle: boolean): TaskInput | string {
  if (!input || typeof input !== "object") return "Body must be an object";
  const i = input as Record<string, unknown>;
  const out: TaskInput = {};
  if (i.title !== undefined) {
    if (typeof i.title !== "string" || !i.title.trim()) return "title must be a non-empty string";
    out.title = i.title.trim().slice(0, 500);
  } else if (requireTitle) return "title is required";
  if (i.notes !== undefined) {
    if (typeof i.notes !== "string") return "notes must be a string";
    out.notes = i.notes.slice(0, 10_000);
  }
  if (i.status !== undefined) {
    if (!STATUSES.includes(i.status as TaskStatus)) return `status must be one of ${STATUSES.join(", ")}`;
    out.status = i.status as TaskStatus;
  }
  if (i.kind !== undefined) {
    if (!KINDS.includes(i.kind as TaskKind)) return `kind must be one of ${KINDS.join(", ")}`;
    out.kind = i.kind as TaskKind;
  }
  if (i.priority !== undefined) {
    if (![1, 2, 3].includes(i.priority as number)) return "priority must be 1, 2 or 3";
    out.priority = i.priority as TaskPriority;
  }
  if (i.sessionId !== undefined) {
    if (typeof i.sessionId !== "string") return "sessionId must be a string";
    out.sessionId = i.sessionId || undefined;
  }
  if (i.planFirst !== undefined) {
    if (typeof i.planFirst !== "boolean") return "planFirst must be a boolean";
    out.planFirst = i.planFirst || undefined;
  }
  return out;
}

export function createTask(projectPath: string, input: TaskInput): Promise<Task> {
  return withLock(projectPath, async () => {
    const tasks = await readTasks(projectPath);
    const now = new Date().toISOString();
    const status = input.status ?? "todo";
    const task: Task = {
      id: randomUUID(),
      title: input.title!,
      notes: input.notes || undefined,
      status,
      kind: input.kind ?? "feature",
      priority: input.priority ?? 2,
      createdAt: now,
      updatedAt: now,
      doneAt: status === "done" ? now : undefined,
      sessionId: input.sessionId,
      planFirst: input.planFirst,
      scheduleId: input.scheduleId,
      origin: input.origin,
    };
    tasks.push(task);
    await writeTasks(projectPath, tasks);
    return task;
  });
}

export function updateTask(projectPath: string, id: string, patch: TaskInput): Promise<Task | null> {
  return withLock(projectPath, async () => {
    const tasks = await readTasks(projectPath);
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    const now = new Date().toISOString();
    const prev = tasks[idx];
    const next: Task = { ...prev, ...patch, updatedAt: now };
    if (patch.status && patch.status !== prev.status) {
      next.doneAt = patch.status === "done" ? now : undefined;
    }
    tasks[idx] = next;
    await writeTasks(projectPath, tasks);
    return next;
  });
}

/** Adds the tasks whose ids aren't on the board yet, keeping their ids; returns how many were added. */
export function addTasks(projectPath: string, incoming: Task[]): Promise<number> {
  return withLock(projectPath, async () => {
    const tasks = await readTasks(projectPath);
    const known = new Set(tasks.map((t) => t.id));
    const fresh = incoming.filter((t) => !known.has(t.id));
    if (fresh.length) await writeTasks(projectPath, [...tasks, ...fresh]);
    return fresh.length;
  });
}

export async function getTask(projectPath: string, id: string): Promise<Task | undefined> {
  return (await readTasks(projectPath)).find((t) => t.id === id);
}

export function deleteTask(projectPath: string, id: string): Promise<boolean> {
  return withLock(projectPath, async () => {
    const tasks = await readTasks(projectPath);
    const next = tasks.filter((t) => t.id !== id);
    if (next.length === tasks.length) return false;
    await writeTasks(projectPath, next);
    return true;
  });
}
