import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Hono } from "hono";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  createProject,
  deleteProject,
  findProjectByPath,
  getProject,
  listProjects,
  updateProject,
  COLORS,
} from "./db.ts";
import { getGitHealth, getGitInfo } from "./lib/git.ts";
import { createTask, deleteTask, getTask, readTasks, updateTask, validateTaskInput } from "./lib/tasks.ts";
import {
  discoverProjects,
  lastSessionAt,
  lastTestRun,
  listSessions,
  locateSession,
  readTranscript,
  searchSessions,
} from "./lib/claudeSessions.ts";
import { PERMISSION_MODES, answerPermission, claudeInfo } from "./lib/claudeRunner.ts";
import { getSettings, MODEL_RE, updateSettings, validateSettings } from "./lib/settings.ts";
import { activeRunForTask, createRun, getRun, listRuns, runEventStream, stopRun } from "./lib/runs.ts";
import { finishTaskTurn, startTaskRun, stopTaskRun, taskForSession } from "./lib/taskRuns.ts";
import { recoverReviewers, reviewIfEnabled, startReviewer } from "./lib/reviewer.ts";
import {
  ReviewError,
  changeSummaries,
  commitBranch,
  commitChanges,
  discardTask,
  dismissReview,
  mergeTask,
  openPullRequest,
  pushBranch,
  revertChanges,
  taskChanges,
} from "./lib/review.ts";
import { shelveWorktree } from "./lib/worktrees.ts";
import { watchTasksStream } from "./lib/taskWatcher.ts";
import {
  createSchedule,
  deleteProjectSchedules,
  deleteSchedule,
  fireSchedule,
  getSchedule,
  listSchedules,
  startScheduler,
  updateSchedule,
  validateScheduleInput,
} from "./lib/schedules.ts";
import { usageReport } from "./lib/usage.ts";
import { FileError, listDir, readFileContent, readImage } from "./lib/files.ts";
import {
  AVD_NAME,
  EmulatorError,
  androidProject,
  emulatorOverview,
  installApk,
  logcatStream,
  openScreen,
  rotate,
  screenshot,
  startEmulator,
  stopEmulator,
  type ScreenInput,
} from "./lib/emulator.ts";
import { clearDevLogs, devLogStream, devServerInfo, listDevServers, startDevServer, stopAllDevServers, stopDevServer } from "./lib/devServers.ts";
import type {
  ChatRequest,
  DesktopStatus,
  Overview,
  PermissionReply,
  Project,
  ProjectHealth,
  ProjectSummary,
  Task,
  TaskStatus,
} from "./types.ts";

// Not plain PORT: dev tools often set that for the web app, which would make both servers fight over one port.
const PORT = Number(process.env.DASHBOARD_API_PORT ?? 4317);
const app = new Hono();

// This server can run Claude with file-write permissions, so only accept requests that clearly come from
// our own UI: the Host must be local (blocks DNS rebinding) and mutating calls need a custom header,
// which a cross-site page can't send without a CORS preflight we never approve.
app.use("/api/*", async (c, next) => {
  const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return c.json({ error: "Forbidden host" }, 403);
  if (c.req.method !== "GET" && c.req.header("x-dashboard") !== "1") return c.json({ error: "Missing header" }, 403);
  await next();
  // Always live data: never let the browser reuse an answer (it once kept index.html for an API path).
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
});

const emptyCounts = (): Record<TaskStatus, number> => ({ todo: 0, doing: 0, done: 0 });

async function summarise(p: Project): Promise<ProjectSummary> {
  const exists = fs.existsSync(p.path);
  const [git, tasks, last] = exists
    ? await Promise.all([getGitInfo(p.path), readTasks(p.path).catch(() => [] as Task[]), lastSessionAt(p.path)])
    : [{ isRepo: false }, [] as Task[], undefined];
  const counts = emptyCounts();
  for (const t of tasks) counts[t.status]++;
  return { ...p, exists, git, counts, lastSessionAt: last };
}

function projectOr404(id: string) {
  const p = getProject(Number(id));
  if (!p) throw new HttpError(404, "Project not found");
  return p;
}

class HttpError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
app.onError((err, c) => {
  if (err instanceof HttpError || err instanceof ReviewError || err instanceof FileError || err instanceof EmulatorError) return c.json({ error: err.message }, err.status);
  if (err instanceof SyntaxError) return c.json({ error: "Invalid JSON body" }, 400);
  console.error(err);
  return c.json({ error: err.message }, 500);
});

// ── Projects ────────────────────────────────────────────────────────────────

app.get("/api/projects", async (c) => c.json(await Promise.all(listProjects().map(summarise))));

app.get("/api/projects/discover", async (c) => {
  const registered = new Set(listProjects().map((p) => p.path.toLowerCase()));
  return c.json((await discoverProjects()).filter((d) => !registered.has(d.path.toLowerCase())));
});

app.post("/api/projects", async (c) => {
  const body = await c.req.json<{ path?: string; name?: string; description?: string; color?: string }>();
  if (typeof body.path !== "string" || !body.path.trim()) throw new HttpError(400, "path is required");
  const abs = path.resolve(body.path.trim().replace(/^"|"$/g, ""));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new HttpError(400, `Not a folder: ${abs}`);
  if (findProjectByPath(abs)) throw new HttpError(409, "That folder is already a project");
  if (body.color && !COLORS.includes(body.color)) throw new HttpError(400, "Unknown color");
  const p = createProject({
    path: abs,
    name: body.name?.trim() || path.basename(abs),
    description: body.description?.trim(),
    color: body.color,
    autoRun: getSettings().newProjectAutoRun,
    autoPermissionMode: getSettings().newProjectPermissionMode,
  });
  return c.json(await summarise(p), 201);
});

app.get("/api/projects/:id", async (c) => {
  const p = projectOr404(c.req.param("id"));
  const summary = await summarise(p);
  summary.git = summary.exists ? await getGitInfo(p.path, true) : summary.git;
  return c.json(summary);
});

app.patch("/api/projects/:id", async (c) => {
  const p = projectOr404(c.req.param("id"));
  const body = await c.req.json<Partial<Project> & { touch?: boolean }>();
  if (body.color !== undefined && !COLORS.includes(body.color)) throw new HttpError(400, "Unknown color");
  if (body.autoPermissionMode !== undefined && !PERMISSION_MODES.includes(body.autoPermissionMode))
    throw new HttpError(400, "Unknown permission mode");
  const updated = updateProject(p.id, {
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    color: body.color,
    pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
    autoRun: typeof body.autoRun === "boolean" ? body.autoRun : undefined,
    autoPermissionMode: body.autoPermissionMode,
    parallelTasks: typeof body.parallelTasks === "boolean" ? body.parallelTasks : undefined,
    autoReview: typeof body.autoReview === "boolean" ? body.autoReview : undefined,
    featureBranches: typeof body.featureBranches === "boolean" ? body.featureBranches : undefined,
    touch: body.touch === true,
  });
  return c.json(await summarise(updated!));
});

// Unregisters only; never touches the folder.
app.delete("/api/projects/:id", (c) => {
  const p = projectOr404(c.req.param("id"));
  deleteProject(p.id);
  deleteProjectSchedules(p.id);
  return c.body(null, 204);
});

// Opens the project folder in the file manager or VS Code (the sidebar's right-click menu). Only the project's own
// path is passed, never anything from the request.
app.post("/api/projects/:id/open", async (c) => {
  const p = projectOr404(c.req.param("id"));
  const body = await c.req.json<{ app?: string }>().catch(() => ({ app: undefined }));
  if (body.app !== "folder" && body.app !== "editor") throw new HttpError(400, "app must be folder or editor");
  if (!fs.existsSync(p.path)) throw new HttpError(400, `Project folder not found: ${p.path}`);
  const editor = body.app === "editor";
  // `code` is a .cmd script on Windows, so it needs a shell (and a quoted path).
  const [command, args, shell]: [string, string[], boolean] = editor
    ? ["code", [`"${p.path}"`], true]
    : process.platform === "win32"
      ? ["explorer.exe", [p.path], false]
      : [process.platform === "darwin" ? "open" : "xdg-open", [p.path], false];
  await new Promise<void>((resolve, reject) => {
    const fail = () =>
      reject(new HttpError(400, editor ? "Couldn't run `code`. Is VS Code's command on your PATH?" : `Couldn't open ${p.path}`));
    const child = spawn(command, args, { shell, detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", fail);
    if (editor) {
      // Through a shell a missing command doesn't fail to spawn; it exits non-zero. `code` itself returns at once.
      child.once("exit", (code) => (code === 0 ? resolve() : fail()));
      setTimeout(resolve, 5000).unref();
    } else {
      // explorer.exe exits with 1 even when it worked, so only a failed spawn counts.
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    }
  });
  return c.body(null, 204);
});

// ── Dev server ──────────────────────────────────────────────────────────────

app.get("/api/dev", (c) => c.json(listDevServers()));

// Stops every running dev server (they otherwise outlive the dashboard, see devServers.ts).
app.post("/api/dev/stop-all", async (c) => c.json({ stopped: await stopAllDevServers() }));

app.get("/api/projects/:id/dev", (c) => {
  const p = projectOr404(c.req.param("id"));
  return c.json(devServerInfo(p.id, p.path));
});

// Status, then the kept output and each new line, as NDJSON.
app.get("/api/projects/:id/dev/logs", (c) => {
  const stream = devLogStream(projectOr404(c.req.param("id")).id);
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" },
  });
});

// `{ "script": "dev" }`: must be one of the project's package.json scripts.
app.post("/api/projects/:id/dev/start", async (c) => {
  const p = projectOr404(c.req.param("id"));
  if (!fs.existsSync(p.path)) throw new HttpError(400, `Project folder not found: ${p.path}`);
  const body = (await c.req.json().catch(() => ({}))) as { script?: unknown };
  if (typeof body.script !== "string" || !body.script) throw new HttpError(400, "script is required");
  try {
    return c.json(await startDevServer(p.id, p.path, body.script), 201);
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
});

app.post("/api/projects/:id/dev/stop", async (c) => c.json({ stopped: await stopDevServer(projectOr404(c.req.param("id")).id) }));

app.delete("/api/projects/:id/dev/logs", (c) => {
  clearDevLogs(projectOr404(c.req.param("id")).id);
  return c.body(null, 204);
});

// Opens the URL the dev server printed in the default browser (the desktop window doesn't open new tabs itself).
// Only that detected localhost URL is opened, never anything from the request.
app.post("/api/projects/:id/dev/open", (c) => {
  const p = projectOr404(c.req.param("id"));
  const url = devServerInfo(p.id, p.path).url;
  if (!url) throw new HttpError(409, "The dev server hasn't printed a URL yet");
  const [command, args]: [string, string[]] =
    process.platform === "win32" ? ["explorer.exe", [url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  return c.body(null, 204);
});

// ── Settings ────────────────────────────────────────────────────────────────

app.get("/api/settings", (c) => c.json(getSettings()));

app.patch("/api/settings", async (c) => {
  const patch = validateSettings(await c.req.json().catch(() => null));
  if (typeof patch === "string") throw new HttpError(400, patch);
  return c.json(updateSettings(patch));
});

// Runs `claude --version`, so it's a separate call the settings page makes when it opens.
app.get("/api/settings/claude", (c) => c.json(claudeInfo()));

// Quits the server for good, as opposed to a restart: `{ "stopDevServers": true }` stops the dev servers first, which a
// restart leaves running. Claude processes are stopped on exit as always (claudeRunner.ts).
app.post("/api/shutdown", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { stopDevServers?: unknown };
  const devServersStopped = body.stopDevServers === true ? await stopAllDevServers() : 0;
  setTimeout(() => process.exit(0), 100); // After the response has gone out.
  return c.json({ devServersStopped });
});

// The desktop app (desktop/src-tauri/src/hotkey.rs) reports whether it could register the shortcut, every few seconds
// while it runs, so the settings page can say so. Kept in memory: a restart just waits for the next report.
let desktop: { hotkey?: string; error?: string; at: number } | undefined;

app.get("/api/desktop", (c) => {
  const running = !!desktop && Date.now() - desktop.at < 60_000;
  return c.json<DesktopStatus>(running ? { running, hotkey: desktop!.hotkey, error: desktop!.error } : { running });
});

app.put("/api/desktop", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { hotkey?: unknown; error?: unknown } | null;
  const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 200) : undefined);
  desktop = { hotkey: str(body?.hotkey), error: str(body?.error), at: Date.now() };
  return c.body(null, 204);
});

// ── Tasks ───────────────────────────────────────────────────────────────────

app.get("/api/projects/:id/tasks", async (c) => c.json(await readTasks(projectOr404(c.req.param("id")).path)));

// Live change pings for open task boards.
app.get("/api/projects/:id/tasks/watch", (c) => {
  const stream = watchTasksStream(projectOr404(c.req.param("id")).path);
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" },
  });
});

app.post("/api/projects/:id/tasks", async (c) => {
  const p = projectOr404(c.req.param("id"));
  const input = validateTaskInput(await c.req.json(), true);
  if (typeof input === "string") throw new HttpError(400, input);
  return c.json(await createTask(p.path, input), 201);
});

app.patch("/api/projects/:id/tasks/:taskId", async (c) => {
  const p = projectOr404(c.req.param("id"));
  const input = validateTaskInput(await c.req.json(), false);
  if (typeof input === "string") throw new HttpError(400, input);
  const taskId = c.req.param("taskId");
  const before = await getTask(p.path, taskId);
  if (!before) throw new HttpError(404, "Task not found");

  const entering = input.status === "doing" && before.status !== "doing";
  const leaving = input.status !== undefined && input.status !== "doing" && before.status === "doing";
  // Claude's notes about its last attempt only make sense while the card is in progress.
  if (leaving) Object.assign(input, { agentStatus: undefined, agentNote: undefined });
  // Turning plan-first on or off starts the planning over.
  if ("planFirst" in input && !input.planFirst !== !before.planFirst) Object.assign(input, { plan: undefined, planApproved: undefined });

  const task = await updateTask(p.path, taskId, input);
  if (!task) throw new HttpError(404, "Task not found");
  if (leaving) stopTaskRun(taskId);
  if (entering && p.autoRun && fs.existsSync(p.path)) await startTaskRun(p, task);
  if (input.status === "done" && before.status !== "done" && fs.existsSync(p.path)) reviewIfEnabled(p, task);
  return c.json(task);
});

// Run the review agent on a finished task now (again, if it already reviewed it).
app.post("/api/projects/:id/tasks/:taskId/reviewer", async (c) => {
  const p = projectOr404(c.req.param("id"));
  if (!fs.existsSync(p.path)) throw new HttpError(400, `Project folder not found: ${p.path}`);
  const task = await getTask(p.path, c.req.param("taskId"));
  if (!task) throw new HttpError(404, "Task not found");
  if (task.status !== "done") throw new HttpError(409, "The review agent looks at finished tasks; move this one to Done first");
  return c.json(await startReviewer(p, task), 201);
});

// Start (or retry) a Claude session for a task by hand; moves it to "In progress" if needed.
// `{ "resume": true }` continues the task's last session, e.g. one cut off by a restart.
// `{ "feedback": "…" }` asks for changes after reviewing what the task did, in its session if it has one.
app.post("/api/projects/:id/tasks/:taskId/run", async (c) => {
  const p = projectOr404(c.req.param("id"));
  if (!fs.existsSync(p.path)) throw new HttpError(400, `Project folder not found: ${p.path}`);
  const body = (await c.req.json().catch(() => ({}))) as { resume?: unknown; feedback?: unknown };
  if (body.feedback !== undefined && (typeof body.feedback !== "string" || !body.feedback.trim()))
    throw new HttpError(400, "feedback must be a non-empty string");
  const feedback = typeof body.feedback === "string" ? body.feedback.trim().slice(0, 10_000) : undefined;
  let task = await getTask(p.path, c.req.param("taskId"));
  if (!task) throw new HttpError(404, "Task not found");
  if (body.resume === true && !task.sessionId) throw new HttpError(400, "This task has no Claude session to resume");
  if (task.status !== "doing") task = (await updateTask(p.path, task.id, { status: "doing" }))!;
  return c.json(await startTaskRun(p, task, { resume: body.resume === true, feedback }), 201);
});

// Answer a plan-first task's plan. `{ "approve": true, "note"?: "…" }` continues its session in the project's task
// mode to build the plan; `{ "approve": false, "feedback": "…" }` sends it back to plan mode to revise.
app.post("/api/projects/:id/tasks/:taskId/plan", async (c) => {
  const p = projectOr404(c.req.param("id"));
  if (!fs.existsSync(p.path)) throw new HttpError(400, `Project folder not found: ${p.path}`);
  const body = (await c.req.json().catch(() => ({}))) as { approve?: unknown; note?: unknown; feedback?: unknown };
  if (typeof body.approve !== "boolean") throw new HttpError(400, "approve must be true or false");
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 10_000) : undefined);
  const feedback = text(body.feedback);
  if (!body.approve && !feedback) throw new HttpError(400, "Say what to change in the plan");
  let task = await getTask(p.path, c.req.param("taskId"));
  if (!task) throw new HttpError(404, "Task not found");
  if (!task.planFirst || !task.plan || task.planApproved) throw new HttpError(409, "This task has no plan waiting for approval");
  if (activeRunForTask(task.id)) throw new HttpError(409, "Claude is still working on this task");
  task = (await updateTask(p.path, task.id, { status: "doing", ...(body.approve ? { planApproved: true } : {}) }))!;
  const planReply = body.approve ? { approve: true as const, note: text(body.note) } : { approve: false as const, feedback: feedback! };
  return c.json(await startTaskRun(p, task, { planReply }), 201);
});

// ── Recurring tasks ─────────────────────────────────────────────────────────

app.get("/api/projects/:id/schedules", (c) => c.json(listSchedules(projectOr404(c.req.param("id")).id)));

app.post("/api/projects/:id/schedules", async (c) => {
  const p = projectOr404(c.req.param("id"));
  const input = validateScheduleInput(await c.req.json(), true);
  if (typeof input === "string") throw new HttpError(400, input);
  return c.json(createSchedule(p.id, input), 201);
});

function scheduleOr404(projectId: string, id: string) {
  const p = projectOr404(projectId);
  const s = getSchedule(id);
  if (!s || s.projectId !== p.id) throw new HttpError(404, "Schedule not found");
  return { p, s };
}

app.patch("/api/projects/:id/schedules/:sid", async (c) => {
  const { s } = scheduleOr404(c.req.param("id"), c.req.param("sid"));
  const input = validateScheduleInput(await c.req.json(), false);
  if (typeof input === "string") throw new HttpError(400, input);
  return c.json(updateSchedule(s.id, input));
});

app.delete("/api/projects/:id/schedules/:sid", (c) => {
  const { s } = scheduleOr404(c.req.param("id"), c.req.param("sid"));
  deleteSchedule(s.id);
  return c.body(null, 204);
});

// Puts the schedule's task on the board now (and starts it, if the schedule does), without waiting for its time.
app.post("/api/projects/:id/schedules/:sid/run", async (c) => {
  const { p, s } = scheduleOr404(c.req.param("id"), c.req.param("sid"));
  if (!fs.existsSync(p.path)) throw new HttpError(400, `Project folder not found: ${p.path}`);
  const task = await fireSchedule(s.id, true);
  if (!task) throw new HttpError(409, getSchedule(s.id)?.lastNote ?? "Couldn't run the schedule");
  return c.json(task, 201);
});

// ── Reviewing what a task changed ───────────────────────────────────────────

// Which tasks on the board have changes waiting for review.
app.get("/api/projects/:id/changes", async (c) => {
  const p = projectOr404(c.req.param("id"));
  return c.json(fs.existsSync(p.path) ? await changeSummaries(p) : []);
});

app.get("/api/projects/:id/tasks/:taskId/changes", async (c) =>
  c.json(await taskChanges(projectOr404(c.req.param("id")), c.req.param("taskId"))),
);

// Commit and Revert take `paths` (default: every changed file), and wait until Claude has stopped working on the task.
async function reviewRequest(projectId: string, taskId: string, raw: unknown) {
  const p = projectOr404(projectId);
  if (activeRunForTask(taskId)) throw new HttpError(409, "Claude is still working on this task");
  const body = (raw ?? {}) as { paths?: unknown; message?: unknown };
  if (body.paths !== undefined && (!Array.isArray(body.paths) || body.paths.some((x) => typeof x !== "string")))
    throw new HttpError(400, "paths must be a list of file paths");
  return { p, body, paths: body.paths as string[] | undefined };
}

app.post("/api/projects/:id/tasks/:taskId/changes/commit", async (c) => {
  const taskId = c.req.param("taskId");
  const { p, body, paths } = await reviewRequest(c.req.param("id"), taskId, await c.req.json().catch(() => null));
  if (typeof body.message !== "string" || !body.message.trim()) throw new HttpError(400, "A commit message is required");
  const message = body.message.trim().slice(0, 5000);
  // A task on its own branch commits there, keeping its worktree; others commit into your checkout.
  if ((await getTask(p.path, taskId))?.worktree) return c.json({ ...(await commitBranch(p, taskId, message)), files: 0 });
  return c.json(await commitChanges(p, taskId, message, paths));
});

// Commit what the task's branch has uncommitted, then push it (worktree tasks).
app.post("/api/projects/:id/tasks/:taskId/changes/push", async (c) => {
  const taskId = c.req.param("taskId");
  const { p, body } = await reviewRequest(c.req.param("id"), taskId, await c.req.json().catch(() => null));
  if (typeof body.message !== "string" || !body.message.trim()) throw new HttpError(400, "A commit message is required");
  return c.json(await pushBranch(p, taskId, body.message.trim().slice(0, 5000)));
});

// Commit, push, and open a pull request for the task's branch with the gh CLI; `title` defaults to the task's.
app.post("/api/projects/:id/tasks/:taskId/changes/pr", async (c) => {
  const taskId = c.req.param("taskId");
  const raw = (await c.req.json().catch(() => null)) as { title?: unknown } | null;
  const { p, body } = await reviewRequest(c.req.param("id"), taskId, raw);
  if (typeof body.message !== "string" || !body.message.trim()) throw new HttpError(400, "A commit message is required");
  const title = typeof raw?.title === "string" && raw.title.trim() ? raw.title.trim() : undefined;
  return c.json(await openPullRequest(p, taskId, body.message.trim().slice(0, 5000), title), 201);
});

// Opens the task's pull request in your browser.
app.post("/api/projects/:id/tasks/:taskId/pr/open", async (c) => {
  const p = projectOr404(c.req.param("id"));
  const url = (await getTask(p.path, c.req.param("taskId")))?.pr?.url;
  if (!url || !/^https:\/\//.test(url)) throw new HttpError(404, "This task has no pull request");
  const [command, args]: [string, string[]] =
    process.platform === "win32" ? ["explorer.exe", [url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  return c.body(null, 204);
});

app.post("/api/projects/:id/tasks/:taskId/changes/revert", async (c) => {
  const taskId = c.req.param("taskId");
  const { p, paths } = await reviewRequest(c.req.param("id"), taskId, await c.req.json().catch(() => null));
  return c.json(await revertChanges(p, taskId, paths));
});

// A task in its own worktree: merge its branch into the main checkout's branch (`{ "message": "…" }` commits what the
// worktree hasn't committed yet first), or throw the branch away.
app.post("/api/projects/:id/tasks/:taskId/changes/merge", async (c) => {
  const taskId = c.req.param("taskId");
  const { p, body } = await reviewRequest(c.req.param("id"), taskId, await c.req.json().catch(() => null));
  if (typeof body.message !== "string" || !body.message.trim()) throw new HttpError(400, "A commit message is required");
  return c.json(await mergeTask(p, taskId, body.message.trim().slice(0, 5000)));
});

app.post("/api/projects/:id/tasks/:taskId/changes/discard", async (c) => {
  const taskId = c.req.param("taskId");
  const { p } = await reviewRequest(c.req.param("id"), taskId, null);
  await discardTask(p, taskId);
  return c.body(null, 204);
});

// Done reviewing: forgets the snapshots and leaves the files as they are.
app.delete("/api/projects/:id/tasks/:taskId/changes", async (c) => {
  await dismissReview(projectOr404(c.req.param("id")), c.req.param("taskId"));
  return c.body(null, 204);
});

app.delete("/api/projects/:id/tasks/:taskId", async (c) => {
  const p = projectOr404(c.req.param("id"));
  const task = await getTask(p.path, c.req.param("taskId"));
  if (!task || !(await deleteTask(p.path, task.id))) throw new HttpError(404, "Task not found");
  // A worktree's work goes onto its branch and the folder goes away; not while a run might still be writing to it.
  if (!stopTaskRun(task.id) && task.worktree) await shelveWorktree(p, task).catch((err) => console.error("Shelving worktree:", err));
  return c.body(null, 204);
});

// ── Claude sessions & chat ──────────────────────────────────────────────────

app.get("/api/projects/:id/sessions", async (c) => c.json(await listSessions(projectOr404(c.req.param("id")).path)));

// Registered before /sessions/:sid so "search" isn't taken for a session id.
app.get("/api/projects/:id/sessions/search", async (c) =>
  c.json(await searchSessions(projectOr404(c.req.param("id")).path, (c.req.query("q") ?? "").slice(0, 200))),
);

app.get("/api/projects/:id/sessions/:sid", async (c) => {
  const t = await readTranscript(projectOr404(c.req.param("id")).path, c.req.param("sid"));
  if (!t) throw new HttpError(404, "Session not found");
  return c.json(t);
});

// ── Files ───────────────────────────────────────────────────────────────────

app.get("/api/projects/:id/files", async (c) => c.json(await listDir(projectOr404(c.req.param("id")).path, c.req.query("path") ?? "")));

app.get("/api/projects/:id/files/content", async (c) =>
  c.json(await readFileContent(projectOr404(c.req.param("id")).path, c.req.query("path") ?? "")),
);

app.get("/api/projects/:id/files/raw", async (c) => {
  const { data, type } = await readImage(projectOr404(c.req.param("id")).path, c.req.query("path") ?? "");
  return c.body(new Uint8Array(data), 200, { "Content-Type": type, "X-Content-Type-Options": "nosniff" });
});

app.post("/api/projects/:id/chat", async (c) => {
  const p = projectOr404(c.req.param("id"));
  const body = await c.req.json<ChatRequest>();
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new HttpError(400, "prompt is required");
  const permissionMode = body.permissionMode ?? "default";
  if (!PERMISSION_MODES.includes(permissionMode)) throw new HttpError(400, "Unknown permission mode");
  if (body.model !== undefined && body.model !== "" && !MODEL_RE.test(body.model))
    throw new HttpError(400, "Invalid model name");

  let cwd = p.path;
  if (body.sessionId) {
    const loc = await locateSession(p.path, body.sessionId);
    if (!loc) throw new HttpError(404, "Session not found for this project");
    if (!fs.existsSync(loc.cwd)) throw new HttpError(400, `The session's folder no longer exists: ${loc.cwd}`);
    cwd = loc.cwd;
  }
  if (!fs.existsSync(cwd)) throw new HttpError(400, `Project folder not found: ${cwd}`);

  const run = createRun({
    projectId: p.id,
    title: body.prompt.trim().slice(0, 80),
    launch: { cwd, prompt: body.prompt, sessionId: body.sessionId, model: body.model || undefined, permissionMode },
    hooks: {
      // Replying in a task's session (e.g. after Claude said it was blocked) is work on that task.
      onFinish: (info, last) => {
        if (!info.sessionId) return;
        taskForSession(p, info.sessionId)
          .then((t) => t && finishTaskTurn(p, t.id, info, last))
          .catch((err) => console.error("Task automation:", err));
      },
    },
  });
  return c.json(run, 201);
});

// ── Runs ────────────────────────────────────────────────────────────────────

app.get("/api/runs", (c) => {
  const projectId = c.req.query("projectId");
  return c.json(listRuns(projectId ? Number(projectId) : undefined));
});

app.get("/api/runs/:runId/events", (c) => {
  const stream = runEventStream(c.req.param("runId"));
  if (!stream) throw new HttpError(404, "Run not found (finished runs are kept for 15 minutes)");
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" },
  });
});

app.post("/api/runs/:runId/stop", (c) => {
  if (!getRun(c.req.param("runId"))) throw new HttpError(404, "Run not found");
  return c.json({ stopped: stopRun(c.req.param("runId")) });
});

app.post("/api/runs/:runId/permission", async (c) => {
  const body = await c.req.json<Partial<PermissionReply>>();
  if (typeof body.requestId !== "string" || typeof body.allow !== "boolean")
    throw new HttpError(400, "requestId and allow are required");
  let answers: Record<string, string> | undefined;
  if (body.answers !== undefined) {
    const entries = body.answers && typeof body.answers === "object" ? Object.entries(body.answers) : [];
    if (!entries.length || entries.length > 20 || entries.some(([, v]) => typeof v !== "string"))
      throw new HttpError(400, "answers must map each question to a string");
    answers = Object.fromEntries(entries.map(([q, a]) => [q.slice(0, 1000), (a as string).slice(0, 2000)]));
  }
  const ok = answerPermission(c.req.param("runId"), {
    requestId: body.requestId,
    allow: body.allow,
    always: body.always === true,
    message: typeof body.message === "string" ? body.message.slice(0, 2000) : undefined,
    answers,
  });
  if (!ok) throw new HttpError(409, "That request is no longer waiting for an answer");
  return c.json({ ok: true });
});

// ── Android emulator ────────────────────────────────────────────────────────

function avdOr400(name: string) {
  if (!AVD_NAME.test(name)) throw new HttpError(400, "Invalid AVD name");
  return name;
}

// The SDK, every AVD and the state of its emulator.
app.get("/api/emulator", async (c) => c.json(await emulatorOverview()));

app.post("/api/emulator/:avd/start", async (c) => c.json(await startEmulator(avdOr400(c.req.param("avd"))), 201));

app.post("/api/emulator/:avd/stop", async (c) => c.json({ stopped: await stopEmulator(avdOr400(c.req.param("avd"))) }));

app.post("/api/emulator/:avd/rotate", async (c) => {
  await rotate(avdOr400(c.req.param("avd")));
  return c.body(null, 204);
});

app.get("/api/emulator/:avd/screenshot", async (c) => {
  const avd = avdOr400(c.req.param("avd"));
  const png = await screenshot(avd);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return c.body(new Uint8Array(png), 200, {
    "content-type": "image/png",
    "content-disposition": `attachment; filename="${avd}-${stamp}.png"`,
  });
});

// The emulator's logcat, as NDJSON.
app.get("/api/emulator/:avd/logcat", (c) => {
  const stream = logcatStream(avdOr400(c.req.param("avd")));
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" } });
});

// The screen: binary frames out, JSON input (see ScreenInput) in. A WebSocket has no CORS, so any web page could
// open one to localhost; the Origin check keeps it to our own UI (the Host check above blocks DNS rebinding).
app.get(
  "/api/emulator/:avd/screen",
  async (c, next) => {
    const origin = c.req.header("origin");
    let host = "";
    try {
      host = origin ? new URL(origin).hostname : "";
    } catch {
      // Not a URL.
    }
    if (!["localhost", "127.0.0.1", "[::1]", "tauri.localhost"].includes(host)) return c.json({ error: "Forbidden origin" }, 403);
    avdOr400(c.req.param("avd"));
    await next();
  },
  upgradeWebSocket((c) => {
    const avd = c.req.param("avd")!;
    let screen: ReturnType<typeof openScreen> | undefined;
    return {
      onOpen(_evt, ws) {
        try {
          screen = openScreen(
            avd,
            (frame) => ws.send(frame),
            (message) => {
              ws.send(JSON.stringify({ error: message }));
              ws.close(1011, "emulator stream ended");
            },
          );
        } catch (err) {
          ws.send(JSON.stringify({ error: (err as Error).message }));
          ws.close(1011, "emulator unavailable");
        }
      },
      onMessage(evt) {
        if (typeof evt.data !== "string") return;
        try {
          screen?.input(JSON.parse(evt.data) as ScreenInput);
        } catch {
          // Ignore malformed input.
        }
      },
      onClose() {
        screen?.close();
      },
    };
  }),
);

app.get("/api/projects/:id/android", (c) => c.json(androidProject(projectOr404(c.req.param("id")).path)));

// `{ "apk": "app/build/outputs/apk/debug/app-debug.apk", "avd": "Pixel_10" }`: one of the APKs the route above lists.
app.post("/api/projects/:id/android/install", async (c) => {
  const p = projectOr404(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { apk?: unknown; avd?: unknown };
  if (typeof body.apk !== "string" || typeof body.avd !== "string") throw new HttpError(400, "apk and avd are required");
  return c.json({ output: await installApk(p.path, body.apk, avdOr400(body.avd)) });
});

// ── Overview ────────────────────────────────────────────────────────────────

// ── Usage ───────────────────────────────────────────────────────────────────

// `?projectId=` narrows it to one project; `?days=` sets how many days the daily series covers (default 30).
app.get("/api/usage", async (c) => {
  const projectId = c.req.query("projectId");
  if (projectId !== undefined) projectOr404(projectId);
  const days = Number(c.req.query("days") ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new HttpError(400, "days must be between 1 and 366");
  return c.json(await usageReport({ projectId: projectId === undefined ? undefined : Number(projectId), days }));
});

app.get("/api/overview", async (c) => {
  const projects = listProjects();
  const counts = emptyCounts();
  const all: Overview["nextUp"] = [];
  for (const p of projects) {
    if (!fs.existsSync(p.path)) continue;
    for (const t of await readTasks(p.path).catch(() => [] as Task[])) {
      counts[t.status]++;
      all.push({ ...t, projectId: p.id, projectName: p.name, projectColor: p.color });
    }
  }
  const statusRank = { doing: 0, todo: 1, done: 2 };
  const overview: Overview = {
    projects: projects.length,
    counts,
    nextUp: all
      .filter((t) => t.status !== "done")
      .sort((a, b) => statusRank[a.status] - statusRank[b.status] || a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))
      .slice(0, 12),
    recentlyDone: all
      .filter((t) => t.status === "done")
      .sort((a, b) => (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt))
      .slice(0, 12),
  };
  return c.json(overview);
});

// Uncommitted changes, unpushed commits, stale branches and the last test Claude ran, per project.
app.get("/api/health", async (c) => {
  const health = await Promise.all(
    listProjects().map(async (p): Promise<ProjectHealth> => {
      if (!fs.existsSync(p.path))
        return { projectId: p.id, exists: false, isRepo: false, uncommitted: 0, unpushed: 0, behind: 0, hasRemote: false, noUpstream: false, staleBranches: [] };
      const [git, lastTest] = await Promise.all([getGitHealth(p.path), lastTestRun(p.path).catch(() => undefined)]);
      return { projectId: p.id, exists: true, ...git, lastTest };
    }),
  );
  return c.json(health);
});

// An API path with no route is a JSON 404, not the web app's index.html below (which the client can't parse).
app.all("/api/*", (c) => c.json({ error: `No API route for ${c.req.method} ${c.req.path}` }, 404));

// ── Static web build (production) ───────────────────────────────────────────

const webDist = path.resolve(import.meta.dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  const root = path.relative(process.cwd(), webDist);
  app.use("/*", serveStatic({ root }));
  // The page itself is checked with the server each time, so a new build shows up on reload.
  app.get("*", serveStatic({ path: path.join(root, "index.html"), onFound: (_, c) => c.header("Cache-Control", "no-cache") }));
}

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1", websocket: { server: new WebSocketServer({ noServer: true }) } }, (info) => {
  console.log(`Project dashboard API on http://localhost:${info.port}`);
  startScheduler();
  void recoverReviewers();
});
