import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { PermissionMode, Project } from "./types.ts";

export const dataDir = path.resolve(import.meta.dirname, "../data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "dashboard.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS projects (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    path           TEXT NOT NULL UNIQUE,
    color          TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    pinned         INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    last_opened_at TEXT
  );
  -- One row per finished Claude run that reported its cost; kept after the run itself is forgotten.
  CREATE TABLE IF NOT EXISTS run_usage (
    run_id      TEXT PRIMARY KEY,
    project_id  INTEGER NOT NULL,
    task_id     TEXT,
    session_id  TEXT,
    title       TEXT NOT NULL,
    model       TEXT,
    status      TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    cost_usd    REAL NOT NULL DEFAULT 0,
    num_turns   INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS run_usage_project ON run_usage (project_id, finished_at);
`);

// Columns added after the first release; ALTER TABLE for databases created before them.
const columns = new Set(
  (db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((c) => c.name),
);
if (!columns.has("auto_run")) db.exec("ALTER TABLE projects ADD COLUMN auto_run INTEGER NOT NULL DEFAULT 1");
if (!columns.has("auto_permission_mode"))
  db.exec("ALTER TABLE projects ADD COLUMN auto_permission_mode TEXT NOT NULL DEFAULT 'acceptEdits'");
if (!columns.has("parallel_tasks")) db.exec("ALTER TABLE projects ADD COLUMN parallel_tasks INTEGER NOT NULL DEFAULT 0");
if (!columns.has("auto_review")) db.exec("ALTER TABLE projects ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 0");

interface ProjectRow {
  id: number;
  name: string;
  path: string;
  color: string;
  description: string;
  pinned: number;
  created_at: string;
  last_opened_at: string | null;
  auto_run: number;
  auto_permission_mode: PermissionMode;
  parallel_tasks: number;
  auto_review: number;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    color: row.color,
    description: row.description,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at ?? undefined,
    autoRun: row.auto_run === 1,
    autoPermissionMode: row.auto_permission_mode,
    parallelTasks: row.parallel_tasks === 1,
    autoReview: row.auto_review === 1,
  };
}

export const COLORS = ["#22d3ee", "#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#fb7185", "#2dd4bf"];

export function listProjects(): Project[] {
  const rows = db
    .prepare("SELECT * FROM projects ORDER BY pinned DESC, COALESCE(last_opened_at, created_at) DESC")
    .all() as unknown as ProjectRow[];
  return rows.map(toProject);
}

export function getProject(id: number): Project | undefined {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow | undefined;
  return row ? toProject(row) : undefined;
}

export function findProjectByPath(p: string): Project | undefined {
  const row = db
    .prepare("SELECT * FROM projects WHERE lower(path) = lower(?)")
    .get(p) as unknown as ProjectRow | undefined;
  return row ? toProject(row) : undefined;
}

export function createProject(input: {
  name: string;
  path: string;
  color?: string;
  description?: string;
  autoRun?: boolean;
  autoPermissionMode?: PermissionMode;
}): Project {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number }).n;
  const color = input.color ?? COLORS[count % COLORS.length];
  const result = db
    .prepare(
      "INSERT INTO projects (name, path, color, description, created_at, auto_run, auto_permission_mode) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.name,
      input.path,
      color,
      input.description ?? "",
      new Date().toISOString(),
      input.autoRun === false ? 0 : 1,
      input.autoPermissionMode ?? "acceptEdits",
    );
  return getProject(Number(result.lastInsertRowid))!;
}

export function updateProject(
  id: number,
  patch: Partial<Pick<Project, "name" | "color" | "description" | "pinned" | "autoRun" | "autoPermissionMode" | "parallelTasks" | "autoReview">> & {
    touch?: boolean;
  },
): Project | undefined {
  const current = getProject(id);
  if (!current) return undefined;
  // Only apply fields that were actually provided; undefined must not clobber stored values.
  const provided = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next = { ...current, ...provided };
  db.prepare(
    "UPDATE projects SET name = ?, color = ?, description = ?, pinned = ?, auto_run = ?, auto_permission_mode = ?, parallel_tasks = ?, auto_review = ?, last_opened_at = ? WHERE id = ?",
  ).run(
    next.name,
    next.color,
    next.description,
    next.pinned ? 1 : 0,
    next.autoRun ? 1 : 0,
    next.autoPermissionMode,
    next.parallelTasks ? 1 : 0,
    next.autoReview ? 1 : 0,
    patch.touch ? new Date().toISOString() : (current.lastOpenedAt ?? null),
    id,
  );
  return getProject(id);
}

export function deleteProject(id: number): boolean {
  return db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes > 0;
}
