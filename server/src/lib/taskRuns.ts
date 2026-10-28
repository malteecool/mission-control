// Task automation: moving a task to "In progress" starts a Claude session for it, and the session's
// outcome moves the card. The dashboard owns the task's status; Claude only reports whether it finished.
// Plan-first tasks start in plan mode: the plan goes onto the card, and approving it continues the same
// session in the project's task mode to build it.
// In a project that runs tasks in parallel, each task works in its own git worktree and branch (worktrees.ts) and
// starts right away, and so does a feature task in a project with featureBranches; other task runs share the project
// folder and queue one at a time.
import type { ChatEvent, Project, RunInfo, Task } from "../types.ts";
import { beginReview, endReview } from "./review.ts";
import { activeRunForTask, createRun, stopRun } from "./runs.ts";
import { reviewIfEnabled } from "./reviewer.ts";
import { getSettings } from "./settings.ts";
import { getTask, readTasks, updateTask, type TaskInput } from "./tasks.ts";
import { createWorktree, importFollowUps, wantsOwnBranch } from "./worktrees.ts";

const MARKER_DONE = /^\s*TASK_STATUS:\s*done\b/im;
const MARKER_BLOCKED = /^\s*TASK_STATUS:\s*blocked\b[\s:\-–—]*(.*)$/im;

const STATUS_LINES = [
  "End your final message with exactly one of these lines:",
  "TASK_STATUS: done",
  "TASK_STATUS: blocked - <what you need from me>",
];

const DONT_EDIT_ENTRY =
  "The dashboard tracks this task's status itself, so don't edit its entry in .dashboard/tasks.json " +
  "(adding new follow-up tasks to that file is fine).";

const header = (t: Task) => [
  `You're working on a task from this project's task board (.dashboard/tasks.json, id ${t.id}).`,
  "",
  `Task: ${t.title}`,
  ...(t.notes?.trim() ? ["", `Notes: ${t.notes.trim()}`] : []),
  "",
  ...(t.worktree ? [worktreeNote(t.worktree.branch), ""] : []),
];

const worktreeNote = (branch: string) =>
  `You're in a git worktree of the project on its own branch, ${branch}, so other tasks can run at the same time ` +
  "in their own worktrees. Keep all your changes in this folder; when I've reviewed them I merge the branch. " +
  "It's a fresh checkout, so anything git doesn't track (installed dependencies, build output, .env files) isn't " +
  "here until you set it up. Committing to this branch is fine, but leave .dashboard/tasks.json out of commits.";

// Your standing instructions from the settings page, e.g. "Run the tests before finishing".
function standing(): string[] {
  const extra = getSettings().taskInstructions.trim();
  return extra ? ["", extra] : [];
}

function taskPrompt(t: Task, opts: { feedback?: string; note?: string } = {}): string {
  // A plan-first task starting over in a fresh session after you approved its plan: hand the plan along.
  const approved = t.planFirst && t.planApproved ? t.plan?.trim() : undefined;
  return [
    ...header(t),
    ...(approved ? ["You already planned this task and I approved the plan:", "", approved, "", "Build it now."] : ["Do the work now."]),
    DONT_EDIT_ENTRY,
    ...standing(),
    ...(opts.note ? ["", opts.note] : []),
    ...(opts.feedback ? ["", "An earlier attempt already changed some files. I reviewed them and want these changes:", "", opts.feedback] : []),
    "",
    ...STATUS_LINES,
  ].join("\n");
}

function planPrompt(t: Task, feedback?: string): string {
  return [
    ...header(t),
    "Plan first: you're in plan mode, so don't change any files. Explore the code, work out how you'd do this, " +
      "then present your plan with the ExitPlanMode tool. I'll review it on the dashboard; once I approve it, " +
      "this same session continues and you build it.",
    ...standing(),
    ...(feedback ? ["", "I saw an earlier plan for this and want these changes:", "", feedback] : []),
    "",
    "If you can't make a plan without something from me, end your final message with this line instead:",
    "TASK_STATUS: blocked - <what you need from me>",
  ].join("\n");
}

const revisePlanPrompt = (feedback: string) =>
  [
    "I reviewed your plan and want changes before you build anything:",
    "",
    feedback,
    "",
    "You're still in plan mode. Update the plan and present it again with ExitPlanMode.",
  ].join("\n");

const approvedPrompt = (note?: string) =>
  ["I approved your plan. Build it now.", ...(note ? ["", note] : []), "", DONT_EDIT_ENTRY, "", ...STATUS_LINES].join("\n");

// Sent when continuing the task's own session, which already holds the original instructions.
const RESUME_PROMPT = [
  "Your session on this task was interrupted before you finished (the dashboard stopped or restarted).",
  "Check what you already changed, then pick up where you left off and finish the task.",
  "",
  ...STATUS_LINES,
].join("\n");

const RESUME_PLAN_PROMPT = [
  "Your session on this task was interrupted before you finished planning (the dashboard stopped or restarted).",
  "Pick up where you left off and present your plan with ExitPlanMode.",
].join("\n");

// "Ask for changes" from the review, continuing the task's own session.
const feedbackPrompt = (feedback: string) =>
  ["I reviewed the changes you made for this task and want some changes:", "", feedback, "", ...STATUS_LINES].join("\n");

/** A plan-first task whose plan you haven't approved yet: its runs plan instead of building. */
export const isPlanning = (t: Task) => !!t.planFirst && !t.planApproved;

/** Your answer to a plan-first task's plan: build it (optionally with a note), or revise it as `feedback` says. */
export type PlanReply = { approve: true; note?: string } | { approve: false; feedback: string };

/**
 * Starts (or queues) a session for the task. Returns the existing run if one is already active. In a parallel project
 * a fresh start first gives the task its own worktree; one that has a worktree keeps working there.
 * With `resume`, continues the task's last session instead of starting a fresh one. With `feedback` (your
 * review of its changes), continues that session if there is one and asks for those changes. With `planReply`,
 * continues the planning session to build the plan (pass the task already marked planApproved) or to revise it.
 */
export async function startTaskRun(
  project: Project,
  task: Task,
  opts: { resume?: boolean; feedback?: string; planReply?: PlanReply } = {},
): Promise<RunInfo> {
  const existing = activeRunForTask(task.id);
  if (existing) return existing;
  const { planReply } = opts;
  const resume = (opts.resume || opts.feedback || planReply) && task.sessionId;
  // Not when continuing a session (it lives in the folder it started in) or when there are changes in the project
  // folder waiting for review: those stay where they are.
  if (wantsOwnBranch(project, task) && !task.worktree && !resume && !task.review) {
    const worktree = await createWorktree(project, task).catch((err) => void log(err));
    if (worktree) task = (await updateTask(project.path, task.id, { worktree })) ?? { ...task, worktree };
    const raced = activeRunForTask(task.id);
    if (raced) return raced;
  }
  const planning = isPlanning(task);
  let prompt: string;
  if (resume)
    prompt = planReply
      ? planReply.approve
        ? approvedPrompt(planReply.note)
        : revisePlanPrompt(planReply.feedback)
      : opts.feedback
        ? feedbackPrompt(opts.feedback)
        : planning
          ? RESUME_PLAN_PROMPT
          : RESUME_PROMPT;
  else if (planning) prompt = planPrompt(task, planReply?.approve === false ? planReply.feedback : undefined);
  else prompt = taskPrompt(task, { feedback: opts.feedback, note: planReply?.approve ? planReply.note : undefined });

  const settings = getSettings();
  // The plan Claude handed in through ExitPlanMode during this run, if it did.
  let plan: string | undefined;
  return createRun({
    projectId: project.id,
    taskId: task.id,
    title: task.title,
    // Tasks in their own worktree don't get in each other's way, so they don't wait for one another.
    queueKey: task.worktree ? undefined : `project:${project.id}`,
    launch: {
      cwd: task.worktree?.path ?? project.path,
      prompt,
      sessionId: resume ? task.sessionId : undefined,
      // Planning happens in plan mode; once approved, the same session builds in the project's task mode.
      permissionMode: planning ? "plan" : project.autoPermissionMode,
      model: settings.taskModel || settings.defaultModel || undefined,
      onPlan: planning ? (p) => (plan = p) : undefined,
    },
    hooks: {
      // Snapshot the files before Claude touches them, and again when it's done, for the card's review.
      prepare: () => beginReview(project, task.id).catch(log),
      onStart: () =>
        void updateTask(project.path, task.id, {
          agentStatus: undefined,
          agentNote: undefined,
          // A new plan replaces the old one.
          ...(planning ? { plan: undefined } : {}),
        }).catch(log),
      onSession: (sessionId) => void updateTask(project.path, task.id, { sessionId }).catch(log),
      onFinish: (info, last) => void finishTaskTurn(project, task.id, info, last, plan).catch(log),
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

/**
 * A run in the task's session ended: record what the files look like now, then move the card. A plan-mode run
 * on a task that's still being planned puts its plan on the card instead.
 */
export async function finishTaskTurn(project: Project, taskId: string, info: RunInfo, last: ChatEvent | null, plan?: string) {
  await endReview(project, taskId).catch(log);
  const task = await getTask(project.path, taskId);
  // Follow-up tasks Claude added to the worktree's copy of the board belong on the real one.
  if (task?.worktree) await importFollowUps(project, task.worktree).catch(log);
  if (task && info.permissionMode === "plan" && isPlanning(task)) await applyPlanOutcome(project, task, info, last, plan);
  else await applyOutcome(project, taskId, info, last);
}

/** How a run that didn't end normally goes on its card; undefined if it ended normally. */
function failure(info: RunInfo, last: ChatEvent | null): TaskInput | undefined {
  if (info.status === "stopped") return { agentStatus: "failed", agentNote: "Stopped before Claude finished." };
  if (last?.type !== "done" || last.isError) {
    const why = last?.type === "error" ? last.message : last?.type === "done" ? last.text : undefined;
    return { agentStatus: "failed", agentNote: why || "The run failed." };
  }
}

/** Moves the card according to how the run ended. Leaves it alone if you've already moved it. */
export async function applyOutcome(project: Project, taskId: string, info: RunInfo, last: ChatEvent | null) {
  const task = await getTask(project.path, taskId);
  if (!task || task.status !== "doing") return;

  const failed = failure(info, last);
  if (failed) return void (await updateTask(project.path, taskId, failed));

  const text = (last?.type === "done" && last.result) || "";
  const blocked = MARKER_BLOCKED.exec(text);
  if (MARKER_DONE.test(text) && !blocked) {
    const done = await updateTask(project.path, taskId, { status: "done", agentStatus: undefined, agentNote: undefined });
    if (done) reviewIfEnabled(project, done);
  } else {
    await updateTask(project.path, taskId, {
      agentStatus: "blocked",
      agentNote: blocked?.[1]?.trim() || "Claude finished without confirming the task is done. Check the session, then reply there or move the card yourself.",
    });
  }
}

/**
 * A planning run ended: the plan (from ExitPlanMode, else Claude's final message) waits on the card for your
 * approval. The card stays in "In progress" either way.
 */
async function applyPlanOutcome(project: Project, task: Task, info: RunInfo, last: ChatEvent | null, plan?: string) {
  if (task.status !== "doing") return;
  const failed = failure(info, last);
  if (failed) return void (await updateTask(project.path, task.id, failed));

  const text = (last?.type === "done" && last.result) || "";
  const blocked = MARKER_BLOCKED.exec(text);
  if (!plan && blocked) {
    await updateTask(project.path, task.id, {
      agentStatus: "blocked",
      agentNote: blocked[1]?.trim() || "Claude needs something from you before it can plan.",
    });
    return;
  }
  plan ||= text.trim();
  if (!plan) {
    await updateTask(project.path, task.id, {
      agentStatus: "blocked",
      agentNote: "Claude finished without proposing a plan. Check the session, then reply there or start a new run.",
    });
    return;
  }
  await updateTask(project.path, task.id, { plan, agentStatus: undefined, agentNote: undefined });
}

function log(err: unknown) {
  console.error("Task automation:", err);
}
