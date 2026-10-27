// Review what a task session changed before keeping it. When a task run starts, the project's working tree is
// snapshotted as a git tree object (through a throwaway index, so your own index is never touched); when it ends,
// again. The card's review shows the diff between the two, so edits made by you or other tasks in between or
// afterwards don't show up, and Commit / Revert act on exactly what the task's sessions wrote.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChangeSummary, ChangedFile, Project, Task, TaskChanges, TaskReview } from "../types.ts";
import { TASK_FILE, getTask, readTasks, updateTask } from "./tasks.ts";

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(
  cwd: string,
  args: string[],
  opts: { index?: string; input?: string; timeout?: number } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(opts.index ? { GIT_INDEX_FILE: opts.index } : {}) };
    const child = spawn("git", args, { cwd, env, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), opts.timeout ?? 60_000);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: "", stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.end(opts.input ?? "");
  });
}

async function mustGit(cwd: string, args: string[], opts?: Parameters<typeof git>[2]): Promise<string> {
  const r = await git(cwd, args, opts);
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || "unknown error"}`);
  return r.stdout;
}

/** A scratch index file, removed when `fn` is done. Starts as a copy of `from` if given. */
async function withTempIndex<T>(from: string | null, fn: (index: string) => Promise<T>): Promise<T> {
  const index = path.join(os.tmpdir(), `dashboard-index-${randomUUID()}`);
  if (from) await fs.copyFile(from, index).catch(() => {});
  try {
    return await fn(index);
  } finally {
    await fs.rm(index, { force: true });
    await fs.rm(`${index}.lock`, { force: true });
  }
}

interface Repo {
  root: string;
  /** The project folder relative to the repo root, "" when the project is the whole repo. */
  rel: string;
}

async function repoFor(projectPath: string): Promise<Repo | null> {
  const r = await git(projectPath, ["rev-parse", "--show-toplevel"], { timeout: 4000 });
  if (!r.ok) return null;
  const root = path.resolve(r.stdout.trim());
  const rel = path.relative(root, path.resolve(projectPath)).split(path.sep).join("/");
  return { root, rel };
}

/** Records the working tree, including untracked files that aren't ignored, as a tree object. */
async function snapshot(root: string): Promise<string> {
  const realIndex = path.resolve(root, (await mustGit(root, ["rev-parse", "--git-path", "index"])).trim());
  // Starting from a copy of your index lets git skip rehashing files whose stat info hasn't changed.
  return withTempIndex(realIndex, async (index) => {
    await mustGit(root, ["add", "-A"], { index });
    return (await mustGit(root, ["write-tree"], { index })).trim();
  });
}

async function head(root: string): Promise<string | undefined> {
  const r = await git(root, ["rev-parse", "-q", "--verify", "HEAD"]);
  return r.ok ? r.stdout.trim() : undefined;
}

/** Limits a diff to the project folder, leaving out the task file the dashboard itself keeps writing. */
function pathspec(repo: Repo): string[] {
  const prefix = repo.rel ? `${repo.rel}/` : "";
  return ["--", repo.rel || ".", `:(exclude)${prefix}${TASK_FILE.split(path.sep).join("/")}*`];
}

/** path → "<mode> <object id>" for the given paths in a tree. */
async function entries(root: string, tree: string, paths: Set<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rec of (await mustGit(root, ["ls-tree", "-r", "-z", "--full-tree", tree])).split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab === -1) continue;
    const file = rec.slice(tab + 1);
    if (!paths.has(file)) continue;
    const [mode, , id] = rec.slice(0, tab).split(" ");
    out.set(file, `${mode} ${id}`);
  }
  return out;
}

/** `git update-index --index-info` input that sets each path to its entry, or removes it if it has none. */
function indexInfo(paths: string[], from: Map<string, string>, zero: string): string {
  return paths.map((p) => `${from.get(p) ?? `0 ${zero}`}\t${p}\0`).join("");
}

/** `tree` with the given paths set to what they are in `from` (or removed when `from` lacks them). */
async function treeWith(root: string, tree: string, paths: string[], from: Map<string, string>): Promise<string> {
  return withTempIndex(null, async (index) => {
    await mustGit(root, ["read-tree", tree], { index });
    await mustGit(root, ["update-index", "-z", "--index-info"], { index, input: indexInfo(paths, from, "0".repeat(tree.length)) });
    return (await mustGit(root, ["write-tree"], { index })).trim();
  });
}

// ── Recording ───────────────────────────────────────────────────────────────

/**
 * Called before a task run starts. Keeps an earlier snapshot the task hasn't been reviewed against yet, so a
 * retry, a resume or "Ask for changes" still shows everything the task did.
 */
export async function beginReview(project: Project, taskId: string): Promise<void> {
  const task = await getTask(project.path, taskId);
  if (!task || task.review) return;
  const repo = await repoFor(project.path);
  if (!repo) return;
  const review: TaskReview = { base: await snapshot(repo.root), head: await head(repo.root), startedAt: new Date().toISOString() };
  await updateTask(project.path, taskId, { review });
}

/** Called when a run in the task's session ends: what the files look like now is what the task produced. */
export async function endReview(project: Project, taskId: string): Promise<void> {
  const task = await getTask(project.path, taskId);
  if (!task?.review) return;
  const repo = await repoFor(project.path);
  if (!repo) return;
  const end = await snapshot(repo.root);
  await updateTask(project.path, taskId, { review: { ...task.review, end, endHead: await head(repo.root) } });
}

// ── Reading ─────────────────────────────────────────────────────────────────

const MAX_FILE_PATCH = 200_000;
const MAX_TOTAL_PATCH = 2_000_000;

type FileStatus = ChangedFile["status"];
const STATUS: Record<string, FileStatus> = { A: "added", M: "modified", D: "deleted", T: "modified" };

async function changedFiles(repo: Repo, a: string, b: string): Promise<Array<Omit<ChangedFile, "patch">>> {
  const spec = pathspec(repo);
  const [names, nums] = await Promise.all([
    mustGit(repo.root, ["diff", "--no-renames", "--no-ext-diff", "-z", "--name-status", a, b, ...spec]),
    mustGit(repo.root, ["diff", "--no-renames", "--no-ext-diff", "-z", "--numstat", a, b, ...spec]),
  ]);
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
  for (const rec of nums.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (m) counts.set(m[3], { added: Number(m[1]) || 0, removed: Number(m[2]) || 0, binary: m[1] === "-" });
  }
  const parts = names.split("\0");
  const files: Array<Omit<ChangedFile, "patch">> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const file = parts[i + 1];
    const c = counts.get(file) ?? { added: 0, removed: 0, binary: false };
    files.push({ path: file, status: STATUS[parts[i][0]] ?? "modified", ...c });
  }
  return files;
}

interface Resolved {
  repo: Repo;
  review: TaskReview;
  /** The tree to compare against: the end snapshot, or the files as they are now while there isn't one. */
  end: string;
  live: boolean;
}

async function resolve(project: Project, task: Task, opts: { persistEnd?: boolean } = {}): Promise<Resolved | null> {
  if (!task.review) return null;
  const repo = await repoFor(project.path);
  if (!repo) return null;
  const review = task.review;
  if (review.end) return { repo, review, end: review.end, live: false };
  // No end snapshot: the session was cut off before it finished (say the dashboard restarted).
  const end = await snapshot(repo.root);
  if (opts.persistEnd) {
    const endHead = await head(repo.root);
    await updateTask(project.path, task.id, { review: { ...review, end, endHead } });
    return { repo, review: { ...review, end, endHead }, end, live: false };
  }
  return { repo, review, end, live: true };
}

async function objectsExist(root: string, ...ids: string[]): Promise<boolean> {
  for (const id of ids) if (!(await git(root, ["cat-file", "-e", `${id}^{tree}`])).ok) return false;
  return true;
}

export async function taskChanges(project: Project, taskId: string): Promise<TaskChanges> {
  const task = await getTask(project.path, taskId);
  if (!task) throw new ReviewError(404, "Task not found");
  const r = await resolve(project, task);
  if (!r) return { taskId, files: [], live: false, commits: [] };
  if (!(await objectsExist(r.repo.root, r.review.base, r.end)))
    return { taskId, files: [], live: r.live, commits: [], since: r.review.startedAt, missing: true };

  const files = await changedFiles(r.repo, r.review.base, r.end);
  const patch = await mustGit(r.repo.root, ["diff", "--no-renames", "--no-ext-diff", "--no-color", r.review.base, r.end, ...pathspec(r.repo)]);
  // Both listings come out in git's path order, one chunk per file.
  const chunks = patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  let total = 0;
  const withPatches: ChangedFile[] = files.map((f, i) => {
    const chunk = chunks.length === files.length ? chunks[i] : "";
    const fits = chunk.length <= MAX_FILE_PATCH && total + chunk.length <= MAX_TOTAL_PATCH;
    if (fits) total += chunk.length;
    return { ...f, patch: fits ? chunk : "", truncated: !fits || undefined };
  });

  // Commits the task's sessions made themselves; reverting files doesn't undo those.
  const until = r.live ? await head(r.repo.root) : r.review.endHead;
  let commits: string[] = [];
  if (r.review.head && until && until !== r.review.head) {
    const log = await git(r.repo.root, ["log", "--format=%h %s", "-n", "20", `${r.review.head}..${until}`]);
    commits = log.ok ? log.stdout.split("\n").filter(Boolean) : [];
  }
  return { taskId, files: withPatches, live: r.live, commits, since: r.review.startedAt };
}

/** File counts for every task on the board that has changes to review. */
export async function changeSummaries(project: Project): Promise<ChangeSummary[]> {
  const tasks = (await readTasks(project.path)).filter((t) => t.review);
  if (!tasks.length) return [];
  const repo = await repoFor(project.path);
  if (!repo) return [];
  let current: Promise<string> | undefined;
  const out: ChangeSummary[] = [];
  for (const t of tasks) {
    const review = t.review!;
    const end = review.end ?? (await (current ??= snapshot(repo.root)));
    const key = `${repo.rel}:${review.base}:${end}`;
    let files = summaryCache.get(key);
    if (!files) {
      if (!(await objectsExist(repo.root, review.base, end))) continue;
      files = await changedFiles(repo, review.base, end);
      if (review.end) summaryCache.set(key, files);
    }
    if (!files.length) continue;
    out.push({
      taskId: t.id,
      files: files.length,
      added: files.reduce((n, f) => n + f.added, 0),
      removed: files.reduce((n, f) => n + f.removed, 0),
    });
  }
  return out;
}

// Diffs between two fixed snapshots never change.
const summaryCache = new Map<string, Array<Omit<ChangedFile, "patch">>>();

// ── Acting ──────────────────────────────────────────────────────────────────

export class ReviewError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

async function prepare(project: Project, taskId: string, paths?: string[]) {
  const task = await getTask(project.path, taskId);
  if (!task) throw new ReviewError(404, "Task not found");
  const r = await resolve(project, task, { persistEnd: true });
  if (!r) throw new ReviewError(400, "This task has no recorded changes to review");
  if (!(await objectsExist(r.repo.root, r.review.base, r.end)))
    throw new ReviewError(409, "The snapshot this review is based on is gone (git cleaned it up). Dismiss the review instead.");
  const files = await changedFiles(r.repo, r.review.base, r.end);
  const chosen = paths ? files.filter((f) => paths.includes(f.path)).map((f) => f.path) : files.map((f) => f.path);
  if (!chosen.length) throw new ReviewError(400, "None of those files are part of this task's changes");
  return { ...r, task, chosen, all: files.length === chosen.length };
}

/**
 * Commits the chosen files (default: all) exactly as the task left them, on top of HEAD. Builds the commit in a
 * scratch index so anything else you have staged stays out of it; your hooks still run.
 */
export function commitChanges(project: Project, taskId: string, message: string, paths?: string[]) {
  return withLock(taskId, async () => {
    const { repo, review, end, chosen, task } = await prepare(project, taskId, paths);
    const root = repo.root;
    const want = await entries(root, end, new Set(chosen));
    const info = indexInfo(chosen, want, "0".repeat(end.length));
    const before = await head(root);

    const committed = await withTempIndex(null, async (index) => {
      await mustGit(root, before ? ["read-tree", before] : ["read-tree", "--empty"], { index });
      await mustGit(root, ["update-index", "-z", "--index-info"], { index, input: info });
      const tree = (await mustGit(root, ["write-tree"], { index })).trim();
      if (before && tree === (await mustGit(root, ["rev-parse", `${before}^{tree}`])).trim()) return false;
      await mustGit(root, ["commit", "-q", "-m", message], { index, timeout: 120_000 });
      return true;
    });
    // Line your index up with the new commit for these files, so `git status` doesn't show them as staged changes.
    if (committed) await mustGit(root, ["update-index", "-z", "--index-info"], { input: info });

    const base = await treeWith(root, review.base, chosen, want);
    const left = (await changedFiles(repo, base, end)).length;
    await updateTask(project.path, task.id, { review: left ? { ...review, end, base } : undefined });
    return { commit: committed ? (await head(root))?.slice(0, 12) : undefined, files: chosen.length };
  });
}

/**
 * Puts the chosen files (default: all) back the way they were before the task ran. Skips any file that has
 * changed again since the task finished, so later work isn't thrown away.
 */
export function revertChanges(project: Project, taskId: string, paths?: string[]) {
  return withLock(taskId, async () => {
    const { repo, review, end, chosen, task } = await prepare(project, taskId, paths);
    const root = repo.root;
    const set = new Set(chosen);
    const [was, after, now] = await Promise.all([
      entries(root, review.base, set),
      entries(root, end, set),
      snapshot(root).then((cur) => entries(root, cur, set)),
    ]);
    const ok = chosen.filter((p) => now.get(p) === after.get(p));
    const skipped = chosen.filter((p) => !ok.includes(p));
    const restore = ok.filter((p) => was.has(p));
    const remove = ok.filter((p) => !was.has(p));

    if (restore.length)
      await mustGit(root, ["--literal-pathspecs", "restore", `--source=${review.base}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        input: restore.join("\0"),
      });
    for (const p of remove) await fs.rm(path.join(root, p), { force: true });
    // A file the task created and staged would otherwise linger in your index.
    if (remove.length)
      await git(root, ["--literal-pathspecs", "rm", "--cached", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        input: remove.join("\0"),
      });

    const next = ok.length ? await treeWith(root, end, ok, was) : end;
    const left = (await changedFiles(repo, review.base, next)).length;
    await updateTask(project.path, task.id, { review: left ? { ...review, end: next } : undefined });
    return { reverted: ok, skipped };
  });
}

/** Done reviewing without committing or reverting: the changes stay in your working tree. */
export function dismissReview(project: Project, taskId: string) {
  return withLock(taskId, async () => {
    if (!(await updateTask(project.path, taskId, { review: undefined }))) throw new ReviewError(404, "Task not found");
  });
}
