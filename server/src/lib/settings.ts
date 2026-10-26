// Dashboard-wide settings, stored as one JSON row per key so new settings need no migration.
import fs from "node:fs";
import { db } from "../db.ts";
import type { PermissionMode, Settings } from "../types.ts";

export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
/** Model aliases and full ids, e.g. "opus" or "claude-opus-5-5". */
export const MODEL_RE = /^[a-zA-Z0-9.\-_[\]]{1,64}$/;

export const DEFAULT_SETTINGS: Settings = {
  defaultModel: "",
  defaultPermissionMode: "default",
  taskModel: "",
  taskInstructions: "",
  newProjectAutoRun: true,
  newProjectPermissionMode: "acceptEdits",
  claudePath: "",
};

db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

let cache: Settings | undefined;

export function getSettings(): Settings {
  if (cache) return cache;
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
  const stored: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      stored[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore a corrupt row; the default applies */
    }
  }
  // Only known keys, and only values of the right type, so an old or hand-edited row can't break anything.
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    if (typeof stored[key] === typeof DEFAULT_SETTINGS[key]) (out as Record<string, unknown>)[key] = stored[key];
  }
  return (cache = out);
}

/** Validates a partial update. Returns an error message, or the cleaned patch. */
export function validateSettings(input: unknown): Partial<Settings> | string {
  if (!input || typeof input !== "object") return "Body must be an object";
  const i = input as Record<string, unknown>;
  const out: Partial<Settings> = {};
  for (const key of ["defaultModel", "taskModel"] as const) {
    if (i[key] === undefined) continue;
    if (typeof i[key] !== "string" || (i[key] !== "" && !MODEL_RE.test(i[key] as string))) return `${key}: invalid model name`;
    out[key] = i[key] as string;
  }
  for (const key of ["defaultPermissionMode", "newProjectPermissionMode"] as const) {
    if (i[key] === undefined) continue;
    if (!PERMISSION_MODES.includes(i[key] as PermissionMode)) return `${key} must be one of ${PERMISSION_MODES.join(", ")}`;
    out[key] = i[key] as PermissionMode;
  }
  if (i.newProjectAutoRun !== undefined) {
    if (typeof i.newProjectAutoRun !== "boolean") return "newProjectAutoRun must be true or false";
    out.newProjectAutoRun = i.newProjectAutoRun;
  }
  if (i.taskInstructions !== undefined) {
    if (typeof i.taskInstructions !== "string") return "taskInstructions must be a string";
    out.taskInstructions = i.taskInstructions.slice(0, 4000);
  }
  if (i.claudePath !== undefined) {
    if (typeof i.claudePath !== "string") return "claudePath must be a string";
    const p = i.claudePath.trim().replace(/^"|"$/g, "");
    if (p && !fs.existsSync(p)) return `No file at ${p}`;
    out.claudePath = p;
  }
  return out;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) upsert.run(key, JSON.stringify(value));
  cache = undefined;
  return getSettings();
}
