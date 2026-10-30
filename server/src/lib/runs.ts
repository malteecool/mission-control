// Tracks Claude runs on the server so they outlive the browser tab that started them.
// Each run keeps its events, so a chat view can attach at any time and replay from the start.
import { randomUUID } from "node:crypto";
import type { ChatEvent, RunInfo } from "../types.ts";
import { launchClaude, stopProcess, type LaunchOptions } from "./claudeRunner.ts";
import { recordUsage } from "./usage.ts";

type Listener = (ev: ChatEvent | null) => void; // null: the run is over

interface Run {
  info: RunInfo;
  launch: LaunchOptions;
  /** Runs sharing a queue key run one at a time, in order (task runs share one per project). */
  queueKey?: string;
  events: ChatEvent[];
  /** Images held by the stored `tool_result` events. */
  images: number;
  listeners: Set<Listener>;
  stopRequested: boolean;
  hooks: RunHooks;
}

export interface RunHooks {
  /** Awaited when the run leaves the queue, before Claude launches (e.g. to snapshot the files first). */
  prepare?: (info: RunInfo) => Promise<void>;
  /** Called when the run actually starts (immediately, or when it leaves the queue). */
  onStart?: (info: RunInfo) => void;
  onSession?: (sessionId: string, info: RunInfo) => void;
  /** Called once with the final `done` or `error` event (or null if it was stopped while queued). */
  onFinish?: (info: RunInfo, last: ChatEvent | null) => void;
}

const runs = new Map<string, Run>();
const KEEP_FINISHED_MS = 15 * 60_000;
const MAX_EVENTS = 5000;
/** Most screenshots a run keeps for replay (the newest), like a transcript loaded from disk. */
const MAX_IMAGES = 40;

const isActive = (r: Run) => r.info.status === "queued" || r.info.status === "running";

export function createRun(opts: {
  projectId: number;
  taskId?: string;
  role?: RunInfo["role"];
  title: string;
  launch: LaunchOptions;
  queueKey?: string;
  hooks?: RunHooks;
}): RunInfo {
  const run: Run = {
    info: {
      id: randomUUID(),
      projectId: opts.projectId,
      taskId: opts.taskId,
      role: opts.role,
      sessionId: opts.launch.sessionId,
      title: opts.title,
      status: "queued",
      startedAt: new Date().toISOString(),
      permissions: [],
      permissionMode: opts.launch.permissionMode,
      model: opts.launch.model,
    },
    launch: opts.launch,
    queueKey: opts.queueKey,
    events: [],
    images: 0,
    listeners: new Set(),
    stopRequested: false,
    hooks: opts.hooks ?? {},
  };
  runs.set(run.info.id, run);
  emit(run, { type: "run", runId: run.info.id });
  emit(run, { type: "item", item: { kind: "user", id: randomUUID(), text: opts.launch.prompt, ts: run.info.startedAt } });
  pump(opts.queueKey);
  if (!opts.queueKey) void start(run);
  return run.info;
}

/** Start the oldest queued run for a key if nothing with that key is running. */
function pump(queueKey?: string) {
  if (!queueKey) return;
  const same = [...runs.values()].filter((r) => r.queueKey === queueKey);
  if (same.some((r) => r.info.status === "running")) return;
  const next = same.find((r) => r.info.status === "queued");
  if (next) void start(next);
}

async function start(run: Run) {
  run.info.status = "running";
  run.info.startedAt = new Date().toISOString();
  if (run.hooks.prepare) {
    try {
      await run.hooks.prepare(run.info);
    } catch (err) {
      console.error("Run prepare hook failed:", err);
    }
    if (run.stopRequested) {
      emit(run, { type: "error", message: "Stopped before it started" });
      return finish(run, null);
    }
  }
  run.hooks.onStart?.(run.info);
  let last: ChatEvent | null = null;
  launchClaude(
    run.info.id,
    run.launch,
    (ev) => {
      if (ev.type === "done" || ev.type === "error") last = ev;
      emit(run, ev);
    },
    () => finish(run, last),
  );
}

function emit(run: Run, ev: ChatEvent) {
  const info = run.info;
  if (ev.type === "init" && ev.sessionId !== info.sessionId) {
    info.sessionId = ev.sessionId;
    run.hooks.onSession?.(ev.sessionId, info);
  } else if (ev.type === "permission") info.permissions = [...info.permissions, ev.request];
  else if (ev.type === "permission_resolved")
    info.permissions = info.permissions.filter((p) => p.requestId !== ev.requestId);

  // Long runs stream a lot of text deltas; past the cap, keep only the events that matter for replay.
  if (ev.type !== "delta" || run.events.length < MAX_EVENTS) run.events.push(ev);
  if (ev.type === "tool_result" && ev.images?.length) {
    run.images += ev.images.length;
    // Drop the oldest results' images so a long run doesn't hold (and replay) every screenshot it took.
    for (let i = 0; run.images > MAX_IMAGES && i < run.events.length - 1; i++) {
      const old = run.events[i];
      if (old.type !== "tool_result" || !old.images) continue;
      run.images -= old.images.length;
      const { images: _, ...rest } = old;
      run.events[i] = rest;
    }
  }
  for (const l of run.listeners) l(ev);
}

function finish(run: Run, last: ChatEvent | null) {
  const info = run.info;
  info.status = run.stopRequested
    ? "stopped"
    : last?.type === "done" && !last.isError
      ? "done"
      : "failed";
  if (last?.type === "error") info.error = last.message;
  else if (last?.type === "done" && last.isError) info.error = last.text;
  info.finishedAt = new Date().toISOString();
  info.permissions = [];
  for (const l of run.listeners) l(null);
  run.listeners.clear();
  try {
    recordUsage(info, last);
  } catch (err) {
    console.error("Recording run usage failed:", err);
  }
  try {
    run.hooks.onFinish?.(info, last);
  } catch (err) {
    console.error("Run finish hook failed:", err);
  }
  setTimeout(() => runs.delete(info.id), KEEP_FINISHED_MS).unref();
  pump(run.queueKey);
}

export function stopRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || !isActive(run)) return false;
  run.stopRequested = true;
  if (run.info.status === "queued") {
    emit(run, { type: "error", message: "Stopped before it started" });
    finish(run, null);
  } else stopProcess(runId);
  return true;
}

export function getRun(runId: string): RunInfo | undefined {
  return runs.get(runId)?.info;
}

/** Active runs plus ones that finished in the last few minutes, newest first. */
export function listRuns(projectId?: number): RunInfo[] {
  return [...runs.values()]
    .map((r) => r.info)
    .filter((i) => projectId === undefined || i.projectId === projectId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** The task's own active run (not the review agent looking it over). */
export function activeRunForTask(taskId: string): RunInfo | undefined {
  return [...runs.values()].find((r) => r.info.taskId === taskId && !r.info.role && isActive(r))?.info;
}

export function activeReviewerRun(taskId: string): RunInfo | undefined {
  return [...runs.values()].find((r) => r.info.taskId === taskId && r.info.role === "reviewer" && isActive(r))?.info;
}

/** Replays the run's events, then streams new ones until it ends; returns an NDJSON stream. */
export function runEventStream(runId: string): ReadableStream<Uint8Array> | null {
  const run = runs.get(runId);
  if (!run) return null;
  const encoder = new TextEncoder();
  let listener: Listener | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (ev: ChatEvent) => controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      for (const ev of run.events) write(ev);
      if (!isActive(run)) return controller.close();
      listener = (ev) => (ev ? write(ev) : controller.close());
      run.listeners.add(listener);
    },
    // The viewer went away; the run itself keeps going.
    cancel() {
      if (listener) run.listeners.delete(listener);
    },
  });
}
