import { execFile, spawn } from "node:child_process";
import path from "node:path";
import type { GitInfo, ProjectHealth, StaleBranch } from "../types.ts";

const cache = new Map<string, { at: number; info: GitInfo }>();
const TTL_MS = 10_000;

function gitOut(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 4000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

export async function getGitInfo(cwd: string, fresh = false): Promise<GitInfo> {
  const hit = cache.get(cwd);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.info;

  const branch = await gitOut(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let info: GitInfo;
  if (branch === null) {
    info = { isRepo: false };
  } else {
    const [status, last] = await Promise.all([
      gitOut(cwd, ["status", "--porcelain"]),
      gitOut(cwd, ["log", "-1", "--format=%ct%x09%s"]),
    ]);
    const [ts, ...msg] = (last ?? "").split("\t");
    info = {
      isRepo: true,
      branch,
      dirty: status ? status.split("\n").filter(Boolean).length : 0,
      lastCommitAt: ts ? new Date(Number(ts) * 1000).toISOString() : undefined,
      lastCommitMessage: msg.join("\t") || undefined,
    };
  }
  cache.set(cwd, { at: Date.now(), info });
  return info;
}

// For commands that need stdin, other env or a longer timeout (snapshots, commits, worktrees).
export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(
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

export async function mustGit(cwd: string, args: string[], opts?: Parameters<typeof git>[2]): Promise<string> {
  const r = await git(cwd, args, opts);
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || "unknown error"}`);
  return r.stdout;
}

export interface Repo {
  root: string;
  /** The project folder relative to the repo root, "" when the project is the whole repo. */
  rel: string;
}

export async function repoFor(projectPath: string): Promise<Repo | null> {
  const r = await git(projectPath, ["rev-parse", "--show-toplevel"], { timeout: 4000 });
  if (!r.ok) return null;
  const root = path.resolve(r.stdout.trim());
  const rel = path.relative(root, path.resolve(projectPath)).split(path.sep).join("/");
  return { root, rel };
}

const STALE_DAYS = 30;
// Long-lived branches that sit untouched while you work elsewhere; not worth a warning.
const LONG_LIVED = new Set(["main", "master", "trunk", "develop", "dev"]);

/** Uncommitted files, unpushed commits and stale local branches, for the overview's health panel. */
export async function getGitHealth(cwd: string): Promise<
  Pick<ProjectHealth, "isRepo" | "branch" | "uncommitted" | "unpushed" | "behind" | "hasRemote" | "noUpstream" | "staleBranches">
> {
  const info = await getGitInfo(cwd);
  const empty = { uncommitted: 0, unpushed: 0, behind: 0, hasRemote: false, noUpstream: false, staleBranches: [] };
  if (!info.isRepo) return { isRepo: false, ...empty };

  const [remotes, counts, refs] = await Promise.all([
    gitOut(cwd, ["remote"]),
    gitOut(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    gitOut(cwd, ["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(committerdate:unix)%09%(upstream:track)"]),
  ]);
  const hasRemote = !!remotes;
  let behind = 0;
  let unpushed = 0;
  const noUpstream = counts === null;
  if (counts) [behind, unpushed] = counts.split(/\s+/).map(Number);
  // No upstream (or a detached HEAD): count what no remote has seen at all.
  else if (hasRemote) unpushed = Number(await gitOut(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"])) || 0;

  const cutoff = Date.now() - STALE_DAYS * 86_400_000;
  const staleBranches: StaleBranch[] = [];
  for (const line of (refs ?? "").split("\n").filter(Boolean)) {
    const [name, ts, track] = line.split("\t");
    if (name === info.branch || LONG_LIVED.has(name)) continue;
    const at = Number(ts) * 1000;
    const gone = track === "[gone]";
    if (gone || at < cutoff) staleBranches.push({ name, lastCommitAt: new Date(at).toISOString(), gone });
  }
  staleBranches.sort((a, b) => a.lastCommitAt.localeCompare(b.lastCommitAt));

  return {
    isRepo: true,
    branch: info.branch,
    uncommitted: info.dirty ?? 0,
    unpushed,
    behind,
    hasRemote,
    noUpstream,
    staleBranches,
  };
}
