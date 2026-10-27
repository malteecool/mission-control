// Task automation: moving a task to "In progress" starts a Claude session for it, and the session's
// outcome moves the card. The dashboard owns the task's status; Claude only reports whether it finished.
import type { ChatEvent, Project, RunInfo, Task } from "../types.ts";
import { beginReview, endReview } from "./review.ts";
import { activeRunForTask, createRun, stopRun } from "./runs.ts";
import { getSettings } from "./settings.ts";
import { getTask, readTasks, updateTask } from "./tasks.ts";

const MARKER_DONE = /^\s*TASK_STATUS:\s*done\b/im;
const MARKER_BLOCKED = /^\s*TASK_STATUS:\s*blocked\b[\s:\-–—]*(.*)$/im;

const STATUS_LINES = [
  "End your final message with exactly one of these lines:",
  "TASK_STATUS: done",
  "TASK_STATUS: blocked - <what you need from me>",
];

function taskPrompt(t: Task, feedback?: string): string {
  // Your standing instructions from the settings page, e.g. "Run the tests before finishing".
  const extra = getSettings().taskInstructions.trim();
  return [
    `You're working on a task from this project's task board (.dashboard/tasks.json, id ${t.id}).`,
    "",
    `Task: ${t.title}`,
    ...(t.notes?.trim() ? ["", `Notes: ${t.notes.trim()}`] : []),
    "",
    "Do the work now. The dashboard tracks this task's status itself, so don't edit its entry in .dashboard/tasks.json " +
      "(adding new follow-up tasks to that file is fine).",
    ...(extra ? ["", extra] : []),
    ...(feedback ? ["", "An earlier attempt already changed some files. I reviewed them and want these changes:", "", feedback] : []),
    "",
    ...STATUS_LINES,
  ].join("\n");
}

// Sent when continuing the task's own session, which already holds the original instructions.
const RESUME_PROMPT = [
  "Your session on this task was interrupted before you finished (the dashboard stopped or restarted).",
  "Check what you already changed, then pick up where you left off and finish the task.",
  "",
  ...STATUS_LINES,
].join("\n");

// "Ask for changes" from the review, continuing the task's own session.
const feedbackPrompt = (feedback: string) =>
  ["I reviewed the changes you made for this task and want some changes:", "", feedback, "", ...STATUS_LINES].join("\n");

/**
 * Starts (or queues) a session for the task. Returns the existing run if one is already active.
 * With `resume`, continues the task's last session instead of starting a fresh one. With `feedback` (your
 * review of its changes), continues that session if there is one and asks for those changes.
 */
export function startTaskRun(project: Project, task: Task, opts: { resume?: boolean; feedback?: string } = {}): RunInfo {
  const existing = activeRunForTask(task.id);
  if (existing) return existing;
  const resume = (opts.resume || opts.feedback) && task.sessionId;
  const settings = getSettings();
  const base = {
    cwd: project.path,
    permissionMode: project.autoPermissionMode,
    model: settings.taskModel || settings.defaultModel || undefined,
  };
  return createRun({
    projectId: project.id,
    taskId: task.id,
    title: task.title,
    queueKey: `project:${project.id}`,
    launch: resume
      ? { ...base, prompt: opts.feedback ? feedbackPrompt(opts.feedback) : RESUME_PROMPT, sessionId: task.sessionId }
      : { ...base, prompt: taskPrompt(task, opts.feedback) },
    hooks: {
      // Snapshot the files before Claude touches them, and again when it's done, for the card's review.
      prepare: () => beginReview(project, task.id).catch(log),
      onStart: () => void updateTask(project.path, task.id, { agentStatus: undefined, agentNote: undefined }).catch(log),
      onSession: (sessionId) => void updateTask(project.path, task.id, { sessionId }).catch(log),
      onFinish: (info, last) => void finishTaskTurn(project, task.id, info, last).catch(log),
    },
  });
}

/** The task left "In progress" (or was deleted): stop its run. */
export function stopTaskRun(taskId: string): boolean {
  const run = activeRunForTask(taskId);
  return run ? stopRun(run.id) : false;
}

/**
 * A chat turn in a session that belongs to a task counts as work on that task, e.g. answering
 * Claude after it reported "blocked". Finds that task so the turn's outcome can move the card.
 */
export async function taskForSession(project: Project, sessionId: string): Promise<Task | undefined> {
  return (await readTasks(project.path)).find((t) => t.sessionId === sessionId);
}

/** A run in the task's session ended: record what the files look like now, then move the card. */
export async function finishTaskTurn(project: Project, taskId: string, info: RunInfo, last: ChatEvent | null) {
  await endReview(project, taskId).catch(log);
  await applyOutcome(project, taskId, info, last);
}

/** Moves the card according to how the run ended. Leaves it alone if you've already moved it. */
export async function applyOutcome(project: Project, taskId: string, info: RunInfo, last: ChatEvent | null) {
  const task = await getTask(project.path, taskId);
  if (!task || task.status !== "doing") return;

  if (info.status === "stopped") {
    await updateTask(project.path, taskId, { agentStatus: "failed", agentNote: "Stopped before Claude finished." });
    return;
  }
  if (last?.type !== "done" || last.isError) {
    const why = last?.type === "error" ? last.message : last?.type === "done" ? last.text : undefined;
    await updateTask(project.path, taskId, { agentStatus: "failed", agentNote: why || "The run failed." });
    return;
  }

  const text = last.result ?? "";
  const blocked = MARKER_BLOCKED.exec(text);
  if (MARKER_DONE.test(text) && !blocked) {
    await updateTask(project.path, taskId, { status: "done", agentStatus: undefined, agentNote: undefined });
  } else {
    await updateTask(project.path, taskId, {
      agentStatus: "blocked",
      agentNote: blocked?.[1]?.trim() || "Claude finished without confirming the task is done. Check the session, then reply there or move the card yourself.",
    });
  }
}

function log(err: unknown) {
  console.error("Task automation:", err);
}
