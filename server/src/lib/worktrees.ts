// Tasks on their own branch: in a project with parallelTasks on, each task gets its own git worktree and branch under
// <project>/.claude/worktrees/, so several Claude sessions can work at once without editing the same files. With
// featureBranches on, feature tasks get one too (on a feature/… branch), so your checkout never switches branches.
// Reviewing such a task means merging its branch, or pushing it and opening a pull request. Claude Code keeps the sessions of .claude/worktrees/* checkouts
// next to the project's own, so History and "Open session" find them, and replies continue in the worktree.
import fs from "node:fs";
import path from "node:path";
import type { Project, Task, TaskWorktree } from "../types.ts";
import { git, mustGit, repoFor, type Repo } from "./git.ts";
import { TASK_FILE, addTasks, readTasks } from "./tasks.ts";

const WORKTREES = path.join(".claude", "worktrees");

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");

/** The task file's path inside a checkout, relative to its root with forward slashes. */
const taskFileIn = (repo: Repo) => [repo.rel, TASK_FILE.split(path.sep).join("/")].filter(Boolean).join("/");

/**
 * Keeps the worktrees out of the main checkout's `git status` and review snapshots (git would otherwise pick each
 * one up as an embedded repository). Uses .git/info/exclude, so nothing tracked changes.
 */
async function excludeWorktrees(repo: Repo) {
  const file = path.resolve(repo.root, (await mustGit(repo.root, ["rev-parse", "--git-path", "info/exclude"])).trim());
  const line = `/${[repo.rel, WORKTREES.split(path.sep).join("/")].filter(Boolean).join("/")}/`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current.split(/\r?\n/).includes(line)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}# Task worktrees made by the project dashboard\n${line}\n`);
}

/** Whether a fresh run of the task should get its own worktree and branch. */
export const wantsOwnBranch = (project: Project, task: Task) =>
  project.parallelTasks || (project.featureBranches && task.kind === "feature");

/**
 * Creates the task's worktree on a new branch from the main checkout's HEAD (or on the task's existing branch, left
 * over from an earlier attempt). Undefined when the project isn't in a git repository with at least one commit.
 */
export async function createWorktree(project: Project, task: Task): Promise<TaskWorktree | undefined> {
  const repo = await repoFor(project.path);
  if (!repo) return undefined;
  const head = await git(repo.root, ["rev-parse", "-q", "--verify", "HEAD"]);
  if (!head.ok) return undefined;
  await excludeWorktrees(repo);

  const id = task.id.slice(0, 8);
  const root = path.join(project.path, WORKTREES, `task-${id}`);
  const branch = `${task.kind === "feature" ? "feature" : "task"}/${slug(task.title) || "task"}-${id}`;
  if (!fs.existsSync(root)) {
    const exists = (await git(repo.root, ["rev-parse", "-q", "--verify", `refs/heads/${branch}`])).ok;
    await git(repo.root, ["worktree", "prune"]);
    await mustGit(repo.root, ["worktree", "add", "-q", ...(exists ? [root, branch] : ["-b", branch, root, "HEAD"])], {
      timeout: 300_000,
    });
  }
  // Reusing a folder that's already there: take whatever branch it has checked out.
  const current = (await mustGit(root, ["symbolic-ref", "--short", "-q", "HEAD"])).trim();
  const base = (await mustGit(repo.root, ["merge-base", "HEAD", current || "HEAD"])).trim();
  return { root, path: repo.rel ? path.join(root, ...repo.rel.split("/")) : root, branch: current || branch, base };
}

/**
 * Brings tasks Claude added to the worktree's copy of the task file onto the board in the main checkout, keeping
 * their ids so doing it again adds nothing. Tasks that were already in the file when the branch started don't count.
 */
export async function importFollowUps(project: Project, wt: TaskWorktree): Promise<number> {
  const theirs = await readTasks(wt.path).catch(() => []);
  if (!theirs.length) return 0;
  const repo = await repoFor(wt.path);
  const before = repo ? await git(wt.root, ["show", `${wt.base}:${taskFileIn(repo)}`]) : undefined;
  let known = new Set<string>();
  try {
    if (before?.ok) known = new Set((JSON.parse(before.stdout).tasks ?? []).map((t: { id?: string }) => t.id));
  } catch {
    /* not valid JSON at the base commit; everything in the copy counts as new */
  }
  return addTasks(
    project.path,
    theirs.filter((t) => !known.has(t.id)).map((t) => ({ ...t, status: t.status === "done" ? "done" : "todo", sessionId: undefined })),
  );
}

/**
 * Commits whatever the worktree has that isn't committed yet onto its branch, leaving out its copy of the task file
 * (the board in the main checkout is the real one). Returns false when there was nothing to commit.
 */
export async function commitWorktree(wt: TaskWorktree, message: string): Promise<boolean> {
  const repo = await repoFor(wt.path);
  if (!repo) throw new Error(`Not a git checkout: ${wt.root}`);
  await mustGit(wt.root, ["add", "-A", "--", ".", `:(exclude)${taskFileIn(repo)}`]);
  if ((await git(wt.root, ["diff", "--cached", "--quiet"])).ok) return false;
  await mustGit(wt.root, ["commit", "-q", "-m", message], { timeout: 120_000 });
  return true;
}

/** Removes the worktree folder (uncommitted changes in it are lost) and, with `deleteBranch`, its branch too. */
export async function removeWorktree(project: Project, wt: TaskWorktree, opts: { deleteBranch?: boolean } = {}) {
  const repo = await repoFor(project.path);
  if (!repo) throw new Error(`Not a git repository: ${project.path}`);
  if (fs.existsSync(wt.root)) await mustGit(repo.root, ["worktree", "remove", "--force", wt.root], { timeout: 120_000 });
  else await git(repo.root, ["worktree", "prune"]);
  if (opts.deleteBranch) await git(repo.root, ["branch", "-D", wt.branch]);
}

/**
 * A task with a worktree was deleted from the board: commit its work to the branch and remove the folder, so the
 * work stays reachable from the branch without a checkout lying around. Leaves the folder if committing fails.
 */
export async function shelveWorktree(project: Project, task: Task) {
  const wt = task.worktree;
  if (!wt || !fs.existsSync(wt.root)) return;
  await commitWorktree(wt, `WIP: ${task.title}`);
  await removeWorktree(project, wt);
}
