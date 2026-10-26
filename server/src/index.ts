import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
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
import { getGitInfo } from "./lib/git.ts";
import { createTask, deleteTask, readTasks, updateTask, validateTaskInput } from "./lib/tasks.ts";
import { discoverProjects, lastSessionAt, listSessions, locateSession, readTranscript } from "./lib/claudeSessions.ts";
import { PERMISSION_MODES, answerPermission, startRun, stopRun } from "./lib/claudeRunner.ts";
import type { ChatRequest, Overview, PermissionReply, Project, ProjectSummary, Task, TaskStatus } from "./types.ts";

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
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
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
  const updated = updateProject(p.id, {
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
    color: body.color,
    pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
    touch: body.touch === true,
  });
  return c.json(await summarise(updated!));
});

// Unregisters only; never touches the folder.
app.delete("/api/projects/:id", (c) => {
  const p = projectOr404(c.req.param("id"));
  deleteProject(p.id);
  return c.body(null, 204);
});

// ── Tasks ───────────────────────────────────────────────────────────────────

app.get("/api/projects/:id/tasks", async (c) => c.json(await readTasks(projectOr404(c.req.param("id")).path)));

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
  const task = await updateTask(p.path, c.req.param("taskId"), input);
  if (!task) throw new HttpError(404, "Task not found");
  return c.json(task);
});

app.delete("/api/projects/:id/tasks/:taskId", async (c) => {
  const p = projectOr404(c.req.param("id"));
  if (!(await deleteTask(p.path, c.req.param("taskId")))) throw new HttpError(404, "Task not found");
  return c.body(null, 204);
});

// ── Claude sessions & chat ──────────────────────────────────────────────────

app.get("/api/projects/:id/sessions", async (c) => c.json(await listSessions(projectOr404(c.req.param("id")).path)));

app.get("/api/projects/:id/sessions/:sid", async (c) => {
  const t = await readTranscript(projectOr404(c.req.param("id")).path, c.req.param("sid"));
  if (!t) throw new HttpError(404, "Session not found");
  return c.json(t);
});

app.post("/api/projects/:id/chat", async (c) => {
  const p = projectOr404(c.req.param("id"));
  const body = await c.req.json<ChatRequest>();
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new HttpError(400, "prompt is required");
  const permissionMode = body.permissionMode ?? "default";
  if (!PERMISSION_MODES.includes(permissionMode)) throw new HttpError(400, "Unknown permission mode");
  if (body.model !== undefined && !/^[a-zA-Z0-9.\-_[\]]{1,64}$/.test(body.model))
    throw new HttpError(400, "Invalid model name");

  let cwd = p.path;
  if (body.sessionId) {
    const loc = await locateSession(p.path, body.sessionId);
    if (!loc) throw new HttpError(404, "Session not found for this project");
    if (!fs.existsSync(loc.cwd)) throw new HttpError(400, `The session's folder no longer exists: ${loc.cwd}`);
    cwd = loc.cwd;
  }
  if (!fs.existsSync(cwd)) throw new HttpError(400, `Project folder not found: ${cwd}`);

  const stream = startRun({
    cwd,
    prompt: body.prompt,
    sessionId: body.sessionId,
    model: body.model || undefined,
    permissionMode,
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" },
  });
});

app.post("/api/chat/:runId/stop", (c) => c.json({ stopped: stopRun(c.req.param("runId")) }));

app.post("/api/chat/:runId/permission", async (c) => {
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

// ── Overview ────────────────────────────────────────────────────────────────

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

// ── Static web build (production) ───────────────────────────────────────────

const webDist = path.resolve(import.meta.dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  const root = path.relative(process.cwd(), webDist);
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ path: path.join(root, "index.html") }));
}

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`Project dashboard API on http://localhost:${info.port}`);
});
