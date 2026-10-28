// Runs a project's dev command (`npm run dev` and friends) from its page, keeping recent output so the Dev tab can
// show logs and attach at any time. One dev server per project; it lives as long as the dashboard server does.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dataDir } from "../db.ts";
import type { DevLogLine, DevServerInfo, DevServerStatus } from "../types.ts";

type Listener = (line: DevLogLine | null) => void; // null: state changed (started, URL found, exited)

interface DevServer {
  info: DevServerStatus;
  child?: ChildProcess;
  logs: DevLogLine[];
  nextSeq: number;
  listeners: Set<Listener>;
  stopRequested: boolean;
}

const servers = new Map<number, DevServer>();
const MAX_LINES = 2000;
// Scripts offered first, in this order; any other script can be picked too.
const PREFERRED = ["dev", "start", "serve", "preview", "watch"];

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s'")]*)?/i;

/** The package manager the project uses, judged by its lockfile. */
function packageManager(dir: string): string {
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(dir, "bun.lockb")) || fs.existsSync(path.join(dir, "bun.lock"))) return "bun";
  return "npm";
}

function readScripts(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { scripts?: unknown };
    if (!pkg.scripts || typeof pkg.scripts !== "object") return {};
    return Object.fromEntries(Object.entries(pkg.scripts).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

function emptyStatus(projectId: number): DevServerStatus {
  return { projectId, status: "stopped" };
}

export function devServerInfo(projectId: number, dir: string): DevServerInfo {
  const scripts = readScripts(dir);
  const names = Object.keys(scripts).sort((a, b) => {
    const ra = PREFERRED.indexOf(a), rb = PREFERRED.indexOf(b);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.localeCompare(b);
  });
  return {
    ...(servers.get(projectId)?.info ?? emptyStatus(projectId)),
    packageManager: packageManager(dir),
    scripts: names.map((name) => ({ name, command: scripts[name] })),
  };
}

/** Status of every project's dev server that is running (or was, until the dashboard restarts). */
export function listDevServers(): DevServerStatus[] {
  return [...servers.values()].filter((s) => s.info.script).map((s) => s.info);
}

function push(s: DevServer, stream: DevLogLine["stream"], text: string) {
  const line: DevLogLine = { seq: s.nextSeq++, stream, text, ts: new Date().toISOString() };
  s.logs.push(line);
  if (s.logs.length > MAX_LINES) s.logs.splice(0, s.logs.length - MAX_LINES);
  for (const l of s.listeners) l(line);
  if (!s.info.url && stream !== "system") {
    const m = LOCAL_URL.exec(text);
    if (m) {
      s.info.url = m[0].replace("0.0.0.0", "localhost").replace(/\[::1?\]/, "localhost");
      changed(s);
    }
  }
}

function changed(s: DevServer) {
  for (const l of s.listeners) l(null);
}

/** Splits a stream into lines, keeping a partial last line until the rest arrives. */
function lineReader(onLine: (text: string) => void) {
  let rest = "";
  return {
    write(chunk: Buffer) {
      const parts = (rest + chunk.toString("utf8")).split(/\r?\n|\r(?!\n)/);
      rest = parts.pop() ?? "";
      for (const p of parts) onLine(p.replace(ANSI, ""));
    },
    flush() {
      if (rest) onLine(rest.replace(ANSI, ""));
      rest = "";
    },
  };
}

export function startDevServer(projectId: number, dir: string, script: string): DevServerStatus {
  const existing = servers.get(projectId);
  if (existing?.info.status === "running") throw new Error("The dev server is already running");
  const scripts = readScripts(dir);
  if (!Object.hasOwn(scripts, script)) throw new Error(`package.json has no "${script}" script`);
  // It goes through a shell, so keep to names that need no quoting (dev, dev:web, start-server…).
  if (!/^[\w:.@/-]+$/.test(script)) throw new Error(`Can't run a script named "${script}" from here`);

  const pm = packageManager(dir);
  const command = `${pm} run ${script}`;
  const s: DevServer = existing ?? { info: emptyStatus(projectId), logs: [], nextSeq: 0, listeners: new Set(), stopRequested: false };
  s.info = { projectId, status: "running", script, command, startedAt: new Date().toISOString() };
  s.stopRequested = false;
  servers.set(projectId, s);
  push(s, "system", `$ ${command}`);

  // The script name was checked above, so it's safe to pass through the shell (needed for npm.cmd).
  // Detached on Unix so the whole process group can be stopped; BROWSER=none keeps tools from opening a tab themselves.
  const child = spawn(command, {
    cwd: dir,
    shell: true,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0", DASHBOARD_API_PORT: undefined },
  });
  s.child = child;
  s.info.pid = child.pid;
  saveRunning();
  const out = lineReader((t) => push(s, "stdout", t));
  const err = lineReader((t) => push(s, "stderr", t));
  child.stdout?.on("data", (c: Buffer) => out.write(c));
  child.stderr?.on("data", (c: Buffer) => err.write(c));
  child.once("error", (e) => push(s, "system", `Couldn't start: ${e.message}`));
  child.once("close", (code, signal) => {
    out.flush();
    err.flush();
    if (s.child !== child) return;
    s.child = undefined;
    saveRunning();
    s.info = {
      ...s.info,
      status: s.stopRequested || code === 0 ? "stopped" : "crashed",
      exitCode: code ?? undefined,
      finishedAt: new Date().toISOString(),
      pid: undefined,
    };
    push(s, "system", s.stopRequested ? "Stopped." : `Exited (${signal ?? `code ${code}`}).`);
    changed(s);
  });
  changed(s);
  return s.info;
}

/** Kills the dev command and everything it started (a dev server is usually a few processes deep). */
function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
}

/** Stops a whole process group (Unix), even when its leader is gone. */
function killGroup(pgid: number) {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

export function stopDevServer(projectId: number): boolean {
  const s = servers.get(projectId);
  if (!s?.child) return false;
  s.stopRequested = true;
  push(s, "system", "Stopping…");
  killTree(s.child.pid);
  return true;
}

// Don't leave dev servers holding their ports after the dashboard goes away (claudeRunner turns signals into exit).
process.on("exit", () => {
  for (const s of servers.values()) if (s.child) killTree(s.child.pid);
  saveRunning([]);
});

// The exit handler doesn't run when the server is killed outright (TerminateProcess on Windows, which is how
// scripts/dev.mjs restarts it there, or SIGKILL), so the running dev servers are also written down and any left
// over are stopped on the next start. They can't be re-adopted: their output went to pipes that died with us.
const runningFile = path.join(dataDir, "dev-servers.json");

interface RunningRecord {
  projectId: number;
  pid: number;
  startedAt: string;
  command?: string;
  script?: string;
}

function saveRunning(records = [...servers.values()].flatMap((s): RunningRecord[] =>
  s.child?.pid && s.info.startedAt
    ? [{ projectId: s.info.projectId, pid: s.child.pid, startedAt: s.info.startedAt, command: s.info.command, script: s.info.script }]
    : [],
)) {
  try {
    if (records.length) fs.writeFileSync(runningFile, JSON.stringify(records, null, 2));
    else fs.rmSync(runningFile, { force: true });
  } catch {
    // Best effort; worst case a leftover dev server isn't cleaned up next time.
  }
}

interface ProcessEntry {
  pid: number;
  ppid: number;
  /** When it started, ms since epoch. */
  started: number;
}

/** Every running process with its parent and start time (Windows). */
function processTable(): ProcessEntry[] {
  const table: ProcessEntry[] = [];
  const script = `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToUniversalTime().ToString('o'))" }`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const [pid, ppid, iso] = line.trim().split(" ");
    if (pid && ppid && iso) table.push({ pid: Number(pid), ppid: Number(ppid), started: Date.parse(iso) });
  }
  return table;
}

interface GroupEntry {
  pid: number;
  pgid: number;
  /** When it started, ms since epoch. */
  started: number;
}

/** Seconds from ps's `etime` ("[[dd-]hh:]mm:ss"), which unlike Linux's `etimes` macOS and the BSDs have too. */
function parseEtime(etime: string): number {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!m) return NaN;
  const [, days, hours, minutes, seconds] = m;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/** Every running process with its process group and start time (Unix). */
function processGroups(): GroupEntry[] {
  const r = spawnSync("ps", ["-A", "-o", "pid=,pgid=,etime="], { encoding: "utf8", timeout: 20_000 });
  const now = Date.now();
  const table: GroupEntry[] = [];
  for (const line of (r.stdout ?? "").split("\n")) {
    const [pid, pgid, etime] = line.trim().split(/\s+/);
    const elapsed = parseEtime(etime ?? "");
    if (pid && pgid && !Number.isNaN(elapsed)) table.push({ pid: Number(pid), pgid: Number(pgid), started: now - elapsed * 1000 });
  }
  return table;
}

/** When the machine last booted, ms since epoch, or undefined if it can't be told. */
function bootTime(): number | undefined {
  if (process.platform === "win32") {
    const script = "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')";
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    const t = Date.parse((r.stdout ?? "").trim());
    return Number.isNaN(t) ? undefined : t;
  }
  try {
    const uptime = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (uptime > 0) return Date.now() - uptime * 1000;
  } catch {
    // Not Linux.
  }
  const r = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5_000 }); // macOS / BSD: "{ sec = 1700000000, usec = 0 } ..."
  const sec = Number(/sec = (\d+)/.exec(r.stdout ?? "")?.[1]);
  return sec > 0 ? sec * 1000 : undefined;
}

const SLACK = 10_000; // Clock and timestamp rounding between our record and the OS.
const CHILD_WINDOW = 60_000; // How soon after the dev command its direct children start.

/**
 * The processes still running from a dev server started as `root` at `startedAt` (Windows). The root itself is often gone
 * (on Windows the outer cmd.exe dies with us while npm's children live on), but Windows keeps each process's parent
 * PID after the parent exits, so the rest can still be found. Start times guard against reused PIDs: the root must
 * have started when ours did, every descendant after its parent, and, when the root is gone, its direct children
 * within a minute of it (anything later is more likely a stranger that inherited the PID as its parent).
 */
function leftoverTree(table: ProcessEntry[], root: number, startedAt: number): number[] {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const live = byPid.get(root);
  if (live && Math.abs(live.started - startedAt) > SLACK) return []; // The PID belongs to something else now.
  const found: number[] = live ? [root] : [];
  const queue = [{ pid: root, started: live?.started ?? startedAt }];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const p of table) {
      if (p.ppid !== parent.pid || p.pid === parent.pid || p.started < parent.started - SLACK || found.includes(p.pid)) continue;
      if (!live && parent.pid === root && p.started > startedAt + CHILD_WINDOW) continue;
      found.push(p.pid);
      queue.push(p);
    }
  }
  return found;
}

/**
 * Whether the process group of a dev server started as `leader` at `startedAt` still has members (Unix). It was
 * spawned detached, so the group ID is the leader's PID, and the group outlives the leader: orphaned members are
 * reparented to init, so they can't be found by parent PID, but they keep the group ID. A PID isn't reused while a
 * group with that ID exists, so the group is ours if any member started around when the dev command did; one whose
 * members all started later belongs to a process that got the PID after ours were all gone.
 */
function leftoverGroup(table: GroupEntry[], leader: number, startedAt: number): boolean {
  return table.some((p) => p.pgid === leader && p.started >= startedAt - SLACK && p.started <= startedAt + CHILD_WINDOW);
}

function stopLeftovers() {
  let records: RunningRecord[];
  try {
    records = JSON.parse(fs.readFileSync(runningFile, "utf8")) as RunningRecord[];
  } catch {
    return;
  }
  if (!Array.isArray(records)) return saveRunning([]);
  // A dev server started before the last boot is long gone, and its PIDs may now belong to anything.
  const booted = bootTime();
  if (booted !== undefined) records = records.filter((r) => Date.parse(r.startedAt) > booted);
  if (!records.length) return saveRunning([]);
  const windows = process.platform === "win32";
  const table = windows ? processTable() : [];
  const groups = windows ? [] : processGroups();
  for (const r of records) {
    const startedAt = Date.parse(r.startedAt);
    if (windows) {
      // Kill each surviving branch; its root may be gone.
      const pids = leftoverTree(table, r.pid, startedAt);
      if (!pids.length) continue;
      for (const pid of pids) killTree(pid);
    } else {
      // The dev server is its own process group, which outlives its leader.
      if (!leftoverGroup(groups, r.pid, startedAt)) continue;
      killGroup(r.pid);
    }
    const s: DevServer = { info: emptyStatus(r.projectId), logs: [], nextSeq: 0, listeners: new Set(), stopRequested: false };
    s.info = { projectId: r.projectId, status: "stopped", script: r.script, command: r.command, startedAt: r.startedAt, finishedAt: new Date().toISOString() };
    servers.set(r.projectId, s);
    push(s, "system", `Stopped ${r.command ?? "the dev server"} (pid ${r.pid}), left running when the dashboard last shut down.`);
  }
  saveRunning([]);
}

stopLeftovers();

/**
 * NDJSON stream for the Dev tab: `{"type":"status",...}` first and whenever it changes, then a `{"type":"log",...}`
 * line for each line of output (the kept backlog first), until the client disconnects.
 */
export function devLogStream(projectId: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let s = servers.get(projectId);
  if (!s) {
    s = { info: emptyStatus(projectId), logs: [], nextSeq: 0, listeners: new Set(), stopRequested: false };
    servers.set(projectId, s);
  }
  const server = s;
  let listener: Listener | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (msg: unknown) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(msg) + "\n"));
        } catch {
          // Client went away; cancel() cleans up.
        }
      };
      send({ type: "status", status: server.info });
      for (const line of server.logs) send({ type: "log", line });
      listener = (line) => send(line ? { type: "log", line } : { type: "status", status: server.info });
      server.listeners.add(listener);
      // Same heartbeat as the task watcher, so both ends notice a dead connection.
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(new Uint8Array([10]));
        } catch {
          // ignore
        }
      }, 10_000);
    },
    cancel() {
      clearInterval(keepAlive);
      if (listener) server.listeners.delete(listener);
    },
  });
}

export function clearDevLogs(projectId: number) {
  const s = servers.get(projectId);
  if (s) s.logs = [];
}
