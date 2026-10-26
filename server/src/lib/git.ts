import { execFile } from "node:child_process";
import type { GitInfo } from "../types.ts";

const cache = new Map<string, { at: number; info: GitInfo }>();
const TTL_MS = 10_000;

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 4000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

export async function getGitInfo(cwd: string, fresh = false): Promise<GitInfo> {
  const hit = cache.get(cwd);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.info;

  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let info: GitInfo;
  if (branch === null) {
    info = { isRepo: false };
  } else {
    const [status, last] = await Promise.all([
      git(cwd, ["status", "--porcelain"]),
      git(cwd, ["log", "-1", "--format=%ct%x09%s"]),
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
