// The review agent: when a task reaches Done (in a project with autoReview, or when you ask from its card), a
// read-only Claude session looks over what the task changed, notes anything wrong, and forecasts the work that
// should come next: bugs it spotted, loose ends, natural improvements. Those land in To do as new tasks linked back
// to the one they came from, so finished work keeps feeding the board. It never changes files and doesn't start the
// tasks it adds; moving one to In progress is still your call (or autoRun's, once you do).
import type { ChatEvent, Project, ReviewerFinding, ReviewerReport, RunInfo, Task, TaskKind, TaskPriority } from "../types.ts";
import { listProjects } from "../db.ts";
import { taskChanges } from "./review.ts";
import { activeReviewerRun, createRun } from "./runs.ts";
import { getSettings } from "./settings.ts";
import { KINDS, createTask, getTask, readTasks, updateTask } from "./tasks.ts";

/** Most follow-ups one review may add; a task that came from a review chain gets fewer (see followUpLimit). */
const MAX_FOLLOW_UPS = 3;
/** How much of the diff goes into the prompt; past this the agent reads the rest with git itself. */
const MAX_DIFF_CHARS = 60_000;

/** How many reviews deep the task's origin goes: 0 for a task you added, 1 for a review's follow-up, and so on. */
function depth(task: Task, board: Task[]): number {
  const byId = new Map(board.map((t) => [t.id, t]));
  let n = 0;
  for (let t: Task | undefined = task; t?.origin && n < 10; t = byId.get(t.origin.taskId)) n++;
  return n;
}

// Each step down a chain of reviews suggests less, so the board can't grow on its own forever.
const followUpLimit = (d: number) => Math.max(0, MAX_FOLLOW_UPS - d);

async function diffSection(project: Project, task: Task): Promise<string[]> {
  const changes = await taskChanges(project, task.id).catch(() => undefined);
  if (!changes?.files.length) {
    return [
      "The dashboard has no record of which files this task changed (it may have been done by hand, or its changes " +
        "were already committed and reviewed). Use git log / git show to find the relevant work if you need it.",
      ...(changes?.commits.length ? ["", "Commits the task's sessions made:", ...changes.commits.map((c) => `- ${c}`)] : []),
    ];
  }
  const out = [
    `Files the task changed (${changes.files.length}):`,
    ...changes.files.map((f) => `- ${f.status} ${f.path} (+${f.added} −${f.removed})`),
  ];
  if (changes.commits.length) out.push("", "Commits the task's sessions made:", ...changes.commits.map((c) => `- ${c}`));
  let budget = MAX_DIFF_CHARS;
  const shown: string[] = [];
  for (const f of changes.files) {
    if (!f.patch || f.patch.length > budget) continue;
    budget -= f.patch.length;
    shown.push(f.patch);
  }
  const review = task.review;
  const left = changes.files.length - shown.length;
  out.push("", "The diff:", "```diff", shown.join("").trimEnd(), "```");
  if (left)
    out.push(
      `${left} file${left === 1 ? "" : "s"} didn't fit above.` +
        (review?.end ? ` See them with: git diff ${review.base} ${review.end} -- <path>` : " Read them directly."),
    );
  return out;
}

async function reviewerPrompt(project: Project, task: Task): Promise<{ prompt: string; limit: number }> {
  const board = await readTasks(project.path);
  const d = depth(task, board);
  const limit = followUpLimit(d);
  const open = board.filter((t) => t.status !== "done" && t.id !== task.id);
  const recent = board
    .filter((t) => t.status === "done" && t.id !== task.id)
    .sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""))
    .slice(0, 15);
  const list = (ts: Task[]) => (ts.length ? ts.slice(0, 60).map((t) => `- [${t.kind}] ${t.title}`) : ["(none)"]);

  const prompt = [
    "You're the review agent for this project's task board. A task just moved to Done. Look over the work, then " +
      "forecast what should come next. This session is read-only: read files and use read-only git commands, " +
      "but don't edit anything or run builds or tests.",
    "",
    `Finished task: ${task.title} (${task.kind})`,
    ...(task.notes?.trim() ? [`Notes: ${task.notes.trim()}`] : []),
    ...(task.plan?.trim() ? ["", "The plan it followed:", task.plan.trim()] : []),
    ...(task.origin ? ["", `It was itself suggested by the review of "${task.origin.title}".`] : []),
    "",
    ...(await diffSection(project, task)),
    "",
    "1. Code review. Keep it simple and practical: real bugs, edge cases it misses, things it broke, security " +
      "problems, leftover debug code, missing error handling. Read the surrounding code where it helps. Skip style nits.",
    `2. Forecast. Suggest at most ${limit} follow-up task${limit === 1 ? "" : "s"}` +
      (limit ? ": bugs you found worth fixing, unfinished parts, or the obvious next improvement this work opens up. " +
        "Each must be concrete, worth doing, and small enough for one session. None is a perfectly good answer; " +
        "don't invent work, and don't repeat anything already on the board below." : " (this task is already several reviews deep, so the chain stops here)."),
    "",
    "Open tasks on the board:",
    ...list(open),
    "",
    "Recently done:",
    ...list(recent),
    "",
    "End your final message with one fenced json block in exactly this shape (nothing after it):",
    "```json",
    JSON.stringify(
      {
        verdict: "good | concerns",
        summary: "One or two sentences on the work.",
        findings: [{ severity: "high | medium | low", file: "path/to/file.ts:42", text: "What's wrong and why it matters." }],
        followUps: [{ title: "Short imperative title", notes: "What to do and why, with file pointers.", kind: "bug | feature | chore | idea", priority: 2 }],
      },
      null,
      2,
    ),
    "```",
    'Use "good" when nothing needs fixing (findings can then be empty or only low). Priority is 1 (urgent) to 3 (someday).',
  ].join("\n");
  return { prompt, limit };
}

interface Parsed {
  verdict: "good" | "concerns";
  summary?: string;
  findings: ReviewerFinding[];
  followUps: Array<{ title: string; notes?: string; kind: TaskKind; priority: TaskPriority }>;
}

/** The json block at the end of the agent's final message; lenient about missing or odd fields. */
export function parseReviewerResult(text: string): Parsed | undefined {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fenced.length ? fenced.reverse() : [text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const raw of candidates) {
    let v: any;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const str = (x: unknown, max: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : undefined);
    const findings: ReviewerFinding[] = (Array.isArray(v.findings) ? v.findings : [])
      .map((f: any) => ({
        severity: ["high", "medium", "low"].includes(f?.severity) ? f.severity : "medium",
        text: str(f?.text, 1000)!,
        file: str(f?.file, 300),
      }))
      .filter((f: ReviewerFinding) => f.text)
      .slice(0, 20);
    const followUps = (Array.isArray(v.followUps) ? v.followUps : [])
      .map((t: any) => ({
        title: str(t?.title, 200)!,
        notes: str(t?.notes, 4000),
        kind: KINDS.includes(t?.kind) ? (t.kind as TaskKind) : "feature",
        priority: ([1, 2, 3].includes(t?.priority) ? t.priority : 2) as TaskPriority,
      }))
      .filter((t: { title?: string }) => t.title);
    const verdict = v.verdict === "good" || v.verdict === "concerns" ? v.verdict : findings.some((f) => f.severity !== "low") ? "concerns" : "good";
    return { verdict, summary: str(v.summary, 1000), findings, followUps };
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Starts the review agent on a finished task, unless it's already looking at it. Runs one review at a time per
 * project, in the task's worktree if it still has one.
 */
export async function startReviewer(project: Project, task: Task): Promise<RunInfo> {
  const existing = activeReviewerRun(task.id);
  if (existing) return existing;
  const { prompt, limit } = await reviewerPrompt(project, task);
  const settings = getSettings();
  const startedAt = new Date().toISOString();
  const info = createRun({
    projectId: project.id,
    taskId: task.id,
    role: "reviewer",
    title: `Review: ${task.title}`,
    queueKey: `reviewer:${project.id}`,
    launch: {
      cwd: task.worktree?.path ?? project.path,
      prompt,
      permissionMode: "default",
      readOnly: true,
      model: settings.taskModel || settings.defaultModel || undefined,
    },
    hooks: {
      onSession: (sessionId) => void patchReport(project, task.id, { sessionId }).catch(log),
      onFinish: (run, last) => void finishReviewer(project, task.id, run, last, limit).catch(log),
    },
  });
  await updateTask(project.path, task.id, { reviewer: { status: "running", runId: info.id, startedAt } });
  return info;
}

/** A task just reached Done: review it if the project asks for that. */
export function reviewIfEnabled(project: Project, task: Task) {
  if (project.autoReview && task.status === "done") void startReviewer(project, task).catch(log);
}

async function patchReport(project: Project, taskId: string, patch: Partial<ReviewerReport>) {
  const task = await getTask(project.path, taskId);
  if (task?.reviewer) await updateTask(project.path, taskId, { reviewer: { ...task.reviewer, ...patch } });
}

async function finishReviewer(project: Project, taskId: string, run: RunInfo, last: ChatEvent | null, limit: number) {
  const task = await getTask(project.path, taskId);
  // Deleted meanwhile, or a newer review took over.
  if (!task || (task.reviewer?.runId && task.reviewer.runId !== run.id)) return;
  const base = { runId: run.id, sessionId: run.sessionId, startedAt: task.reviewer?.startedAt ?? run.startedAt, finishedAt: new Date().toISOString() };
  const fail = (error: string) => updateTask(project.path, taskId, { reviewer: { ...base, status: "failed", error } });

  if (run.status === "stopped") return void (await fail("Stopped before the review finished."));
  if (last?.type !== "done" || last.isError)
    return void (await fail((last?.type === "error" ? last.message : last?.type === "done" ? last.text : undefined) || "The review run failed."));
  const parsed = parseReviewerResult(last.result ?? "");
  if (!parsed) return void (await fail("The review agent didn't end with its report. Open its session to read what it said."));

  // Skip suggestions the board already has, matched loosely on the title.
  const taken = new Set((await readTasks(project.path)).filter((t) => t.status !== "done").map((t) => norm(t.title)));
  const followUps: string[] = [];
  for (const f of parsed.followUps.slice(0, limit)) {
    if (taken.has(norm(f.title))) continue;
    taken.add(norm(f.title));
    const created = await createTask(project.path, {
      title: f.title,
      notes: f.notes,
      kind: f.kind,
      priority: f.priority,
      status: "todo",
      origin: { taskId: task.id, title: task.title },
    });
    followUps.push(created.id);
  }
  await updateTask(project.path, taskId, {
    reviewer: { ...base, status: "done", verdict: parsed.verdict, summary: parsed.summary, findings: parsed.findings, followUps },
  });
}

/** Reviews cut off by a restart would otherwise show as running forever. Called once at startup. */
export async function recoverReviewers() {
  for (const p of listProjects()) {
    const tasks = await readTasks(p.path).catch(() => []);
    for (const t of tasks)
      if (t.reviewer?.status === "running" && !activeReviewerRun(t.id))
        await updateTask(p.path, t.id, { reviewer: { ...t.reviewer, status: "failed", error: "Interrupted: the dashboard stopped before the review finished." } }).catch(log);
  }
}

function log(err: unknown) {
  console.error("Review agent:", err);
}
