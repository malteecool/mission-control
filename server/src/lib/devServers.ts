// Runs a project's dev command (`npm run dev` and friends) from its page, keeping recent output so the Dev tab can
// show logs and attach at any time. One dev server per project. Its output goes to log files in data/ rather than
// pipes, so it outlives a dashboard restart: the next start reattaches to it (tails the logs, watches the process).
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dataDir } from "../db.ts";
import type { DevLogLine, DevServerInfo, DevServerStatus } from "../types.ts";

type Listener = (line: DevLogLine | null) => void; // null: state changed (started, URL found, exited)

/** Follows one of a dev server's log files from `offset` on. */
interface Tail {
  file: string;
  offset: number;
  reader: ReturnType<typeof lineReader>;
}

interface DevServer {
  info: DevServerStatus;
  /** Set when this dashboard process started it. */
  child?: ChildProcess;
  /**
   * Set when it was reattached after a restart: the PIDs still running from it (Windows) or its process group ID (Unix),
   * watched by polling since there's no child process to hear from.
   */
  adopted?: number[];
  /**
   * When each adopted PID started (Windows), written down with it so the next restart can still find them: by then the
   * root PID is long dead and may belong to something else, so its children can no longer be told from strangers.
   */
  adoptedStarted?: Map<number, number>;
  tails?: Tail[];
  logs: DevLogLine[];
  nextSeq: number;
  listeners: Set<Listener>;
  stopRequested: boolean;
}

const servers = new Map<number, DevServer>();
const MAX_LINES = 2000;
const logDir = path.join(dataDir, "dev-servers");
const MAX_LOG_BYTES = 5 * 1024 * 1024; // A log file is emptied once it grows past this and has been read.
const BACKLOG_BYTES = 256 * 1024; // How much of each log file to show again when reattaching.
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
  const decoder = new StringDecoder("utf8"); // Keeps a character split across reads whole.
  return {
    write(chunk: Buffer) {
      const parts = (rest + decoder.write(chunk)).split(/\r?\n|\r(?!\n)/);
      rest = parts.pop() ?? "";
      for (const p of parts) onLine(p.replace(ANSI, ""));
    },
    flush() {
      rest += decoder.end();
      if (rest) onLine(rest.replace(ANSI, ""));
      rest = "";
    },
  };
}

function logFile(projectId: number, stream: "stdout" | "stderr") {
  return path.join(logDir, `${projectId}.${stream === "stdout" ? "out" : "err"}.log`);
}

function newTail(s: DevServer, stream: "stdout" | "stderr", offset = 0): Tail {
  return { file: logFile(s.info.projectId, stream), offset, reader: lineReader((t) => push(s, stream, t)) };
}

/** Passes on whatever was written to the log file since the last read. */
function readTail(t: Tail) {
  let fd: number;
  try {
    fd = fs.openSync(t.file, "r");
  } catch {
    return;
  }
  let size = 0;
  try {
    size = fs.fstatSync(fd).size;
    if (size < t.offset) t.offset = 0; // Emptied.
    const buf = Buffer.alloc(64 * 1024);
    while (t.offset < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - t.offset), t.offset);
      if (!n) break;
      t.offset += n;
      t.reader.write(buf.subarray(0, n));
    }
  } catch {
    // Try again on the next poll.
  } finally {
    fs.closeSync(fd);
  }
  // The dev server writes in append mode, so after emptying the file it carries on from the start.
  if (t.offset > MAX_LOG_BYTES && t.offset >= size) {
    try {
      fs.truncateSync(t.file, 0);
      t.offset = 0;
    } catch {
      // Still in use in a way that forbids it; try later.
    }
  }
}

/** Shows the last part of a log file again (after a restart) and returns where it ends, to follow on from there. */
function readBacklog(s: DevServer, stream: "stdout" | "stderr"): number {
  const file = logFile(s.info.projectId, stream);
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return 0;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - BACKLOG_BYTES);
    const buf = Buffer.alloc(size - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.subarray(0, n).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1); // Skip the partial first line.
    const reader = lineReader((t) => push(s, stream, t));
    reader.write(Buffer.from(text));
    reader.flush();
    return start + n;
  } catch {
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

/** Empties a log file and opens it for a new dev server to write to. */
function openLog(file: string): number {
  fs.writeFileSync(file, "");
  return fs.openSync(file, "a");
}

export async function startDevServer(projectId: number, dir: string, script: string): Promise<DevServerStatus> {
  // A start made while the leftover sweep is still running would otherwise be taken for a leftover, or overwritten by one.
  await leftoversAdopted;
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
  // Output goes straight to files rather than pipes, so the dev server keeps running if the dashboard goes away.
  fs.mkdirSync(logDir, { recursive: true });
  const fds: number[] = [];
  let child: ChildProcess;
  try {
    fds.push(openLog(logFile(projectId, "stdout")), openLog(logFile(projectId, "stderr")));
    child = spawn(command, {
      cwd: dir,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", fds[0], fds[1]],
      env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0", DASHBOARD_API_PORT: undefined },
    });
  } catch (e) {
    s.info = { ...s.info, status: "crashed", finishedAt: new Date().toISOString() };
    push(s, "system", `Couldn't start: ${(e as Error).message}`);
    changed(s);
    throw e;
  } finally {
    for (const fd of fds) fs.closeSync(fd); // The child has its own copies.
  }
  s.child = child;
  s.adopted = undefined;
  s.adoptedStarted = undefined;
  s.tails = [newTail(s, "stdout"), newTail(s, "stderr")];
  s.info.pid = child.pid;
  saveRunning();
  child.once("error", (e) => push(s, "system", `Couldn't start: ${e.message}`));
  child.once("close", (code, signal) => {
    if (s.child !== child) return;
    s.child = undefined;
    finishTails(s);
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

export async function stopDevServer(projectId: number): Promise<boolean> {
  await leftoversAdopted; // Until then a leftover dev server isn't known yet.
  const s = servers.get(projectId);
  if (!s?.child && !s?.adopted) return false;
  s.stopRequested = true;
  push(s, "system", "Stopping…");
  if (s.child) killTree(s.child.pid);
  else if (process.platform !== "win32") killGroup(s.adopted![0]);
  else {
    // Look again rather than trusting the PIDs from the restart: one may have exited and been reused since.
    const table = s.info.pid && s.info.startedAt ? (await windowsProcesses())?.table : undefined;
    const pids = table ? leftoverTrees(table, s.info.pid!, Date.parse(s.info.startedAt!), survivors(s)) : s.adopted;
    for (const pid of pids ?? []) killTree(pid);
  }
  return true;
}

/** Reads the remaining output of a dev server that has exited and stops following its logs. */
function finishTails(s: DevServer) {
  for (const t of s.tails ?? []) {
    readTail(t);
    t.reader.flush();
  }
  s.tails = undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // Exists, just not ours to signal.
  }
}

/** Notices when a reattached dev server exits, since there's no child process to report it. */
function checkAdopted(s: DevServer) {
  if (!s.adopted) return;
  // Windows: drop PIDs as they exit, so one reused later doesn't count. Unix: the group lives while any member does.
  const before = s.adopted.length;
  s.adopted = process.platform === "win32" ? s.adopted.filter(isAlive) : s.adopted.filter((g) => isAlive(-g));
  if (s.adopted.length) {
    if (s.adopted.length !== before) saveRunning(); // Keep the written-down survivors to the ones still running.
    return;
  }
  s.adopted = undefined;
  s.adoptedStarted = undefined;
  finishTails(s);
  saveRunning();
  s.info = { ...s.info, status: "stopped", finishedAt: new Date().toISOString(), pid: undefined };
  push(s, "system", s.stopRequested ? "Stopped." : "Exited (exit code unknown: it was started before the dashboard restarted).");
  changed(s);
}

// Follow the log files of every running dev server, and watch the reattached ones for exiting. Unref'd so these
// timers never keep the dashboard alive by themselves.
setInterval(() => {
  for (const s of servers.values()) for (const t of s.tails ?? []) readTail(t);
}, 250).unref();
setInterval(() => {
  for (const s of servers.values()) checkAdopted(s);
}, 2000).unref();

// Dev servers deliberately aren't stopped when the dashboard exits: a restart (scripts/dev.mjs, or after an update)
// shouldn't take down the user's dev server. They're written down instead, and the next start reattaches to them.
const runningFile = path.join(dataDir, "dev-servers.json");

interface RunningRecord {
  projectId: number;
  pid: number;
  startedAt: string;
  command?: string;
  script?: string;
  /** Its output goes to log files (so it can be reattached). Older records are of dev servers whose output went to pipes. */
  logged?: boolean;
  /**
   * The processes it was reattached to and when each started, ms since epoch (Windows). Set once it has been through a
   * restart, when the root `pid` is usually gone: if that PID is reused, the survivors can only be found by these.
   */
  survivors?: { pid: number; started: number }[];
}

/** The adopted PIDs of a reattached dev server with their start times (Windows). */
function survivors(s: DevServer): { pid: number; started: number }[] | undefined {
  if (!s.adopted || !s.adoptedStarted) return undefined;
  const list = s.adopted.flatMap((pid) => {
    const started = s.adoptedStarted!.get(pid);
    return started === undefined ? [] : [{ pid, started }];
  });
  return list.length ? list : undefined;
}

function saveRunning(records = [...servers.values()].flatMap((s): RunningRecord[] =>
  (s.child || s.adopted) && s.info.pid && s.info.startedAt
    ? [{ projectId: s.info.projectId, pid: s.info.pid, startedAt: s.info.startedAt, command: s.info.command, script: s.info.script, logged: true, survivors: s.child ? undefined : survivors(s) }]
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

/** Runs a command without waiting on it, resolving to its output, or undefined if it failed or timed out. */
function capture(command: string, args: string[], timeout: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { windowsHide: true, timeout, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(undefined);
    }
    let out = "";
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => resolve(code === 0 ? out : undefined));
  });
}

/**
 * Every running process with its parent and start time (Windows), and, with `withBoot`, when the machine last booted
 * (ms since epoch, undefined if it can't be told). One PowerShell for both, since starting one takes a while.
 * Undefined if PowerShell failed.
 */
async function windowsProcesses(withBoot = false): Promise<{ table: ProcessEntry[]; booted?: number } | undefined> {
  const script = [
    ...(withBoot ? [`"boot $((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o'))"`] : []),
    `Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToUniversalTime().ToString('o'))" }`,
  ].join("; ");
  const out = await capture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 20_000);
  if (out === undefined) return undefined;
  const table: ProcessEntry[] = [];
  let booted: number | undefined;
  for (const line of out.split(/\r?\n/)) {
    const [a, b, c] = line.trim().split(" ");
    if (a === "boot") {
      const t = Date.parse(b ?? "");
      if (!Number.isNaN(t)) booted = t;
    } else if (a && b && c) table.push({ pid: Number(a), ppid: Number(b), started: Date.parse(c) });
  }
  return { table, booted };
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

/** Every running process with its process group and start time (Unix), or undefined if ps failed. */
async function processGroups(): Promise<GroupEntry[] | undefined> {
  // One -o per column: in "pid=,pgid=,etime=" everything after the first "=" is pid's header text.
  const out = await capture("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "etime="], 20_000);
  if (out === undefined) return undefined;
  const now = Date.now();
  const table: GroupEntry[] = [];
  for (const line of out.split("\n")) {
    const [pid, pgid, etime] = line.trim().split(/\s+/);
    const elapsed = parseEtime(etime ?? "");
    if (pid && pgid && !Number.isNaN(elapsed)) table.push({ pid: Number(pid), pgid: Number(pgid), started: now - elapsed * 1000 });
  }
  return table;
}

/** When the machine last booted (Unix), ms since epoch, or undefined if it can't be told. Windows: see windowsProcesses. */
async function bootTime(): Promise<number | undefined> {
  try {
    const uptime = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (uptime > 0) return Date.now() - uptime * 1000;
  } catch {
    // Not Linux.
  }
  const out = await capture("sysctl", ["-n", "kern.boottime"], 5_000); // macOS / BSD: "{ sec = 1700000000, usec = 0 } ..."
  const sec = Number(/sec = (\d+)/.exec(out ?? "")?.[1]);
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
 * Like leftoverTree, but also following the `survivors` written down after an earlier restart (Windows): each one still
 * running with the same start time, and everything it has started since. The root's children alone stop being enough
 * once the root PID is reused, since leftoverTree then can't tell its PID from a stranger's.
 */
function leftoverTrees(table: ProcessEntry[], root: number, startedAt: number, survivors: { pid: number; started: number }[] | undefined): number[] {
  const found = new Set(leftoverTree(table, root, startedAt));
  const byPid = new Map(table.map((p) => [p.pid, p]));
  for (const sv of survivors ?? []) {
    const live = byPid.get(sv.pid);
    if (!live || Math.abs(live.started - sv.started) > SLACK) continue; // Exited, and maybe reused since.
    for (const pid of leftoverTree(table, sv.pid, sv.started)) found.add(pid);
  }
  return [...found];
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

/** A dev server written down by the previous dashboard process, reattached if it's still running. */
function leftoverServer(r: RunningRecord, live: number[] | undefined, started?: Map<number, number>): DevServer {
  const s = sweptServer(r.projectId);
  s.info = { projectId: r.projectId, status: live ? "running" : "stopped", script: r.script, command: r.command, startedAt: r.startedAt };
  push(s, "system", `$ ${r.command ?? "(dev server)"}`);
  // Separate files, so the two streams' backlogs can't be interleaved; everything after this point arrives in order.
  const outEnd = readBacklog(s, "stdout");
  const errEnd = readBacklog(s, "stderr");
  if (live) {
    s.info.pid = r.pid;
    s.adopted = live;
    s.adoptedStarted = started;
    s.tails = [newTail(s, "stdout", outEnd), newTail(s, "stderr", errEnd)];
    push(s, "system", `Reattached after the dashboard restarted (pid ${r.pid}).`);
  } else {
    s.info.finishedAt = new Date().toISOString();
    push(s, "system", "Exited while the dashboard was down.");
  }
  changed(s);
  return s;
}

/**
 * The entry for a project's leftover dev server. A Dev tab opened while the sweep ran may have made one already
 * (devLogStream); it's reused, so that tab hears about the leftover.
 */
function sweptServer(projectId: number): DevServer {
  let s = servers.get(projectId);
  if (!s) {
    s = { info: emptyStatus(projectId), logs: [], nextSeq: 0, listeners: new Set(), stopRequested: false };
    servers.set(projectId, s);
  }
  return s;
}

async function adoptLeftovers() {
  let records: RunningRecord[];
  try {
    records = JSON.parse(fs.readFileSync(runningFile, "utf8")) as RunningRecord[];
  } catch {
    return;
  }
  if (!Array.isArray(records)) return saveRunning([]);
  const windows = process.platform === "win32";
  const snapshot = windows ? await windowsProcesses(true) : undefined;
  if (windows && !snapshot) return; // Keep the records so the next start can try again.
  // A dev server started before the last boot is long gone, and its PIDs may now belong to anything.
  const booted = windows ? snapshot!.booted : await bootTime();
  if (booted !== undefined) records = records.filter((r) => Date.parse(r.startedAt) > booted);
  if (!records.length) return saveRunning([]);
  const table = snapshot?.table ?? [];
  const groups = windows ? [] : await processGroups();
  if (!groups) return; // Keep the records so the next start can try again.
  const startedByPid = new Map(table.map((p) => [p.pid, p.started]));
  for (const r of records) {
    const startedAt = Date.parse(r.startedAt);
    // Windows: each surviving branch, whose root may be gone, plus whatever survived the restarts before this one. Unix:
    // its own process group, which outlives its leader.
    const pids = windows
      ? leftoverTrees(table, r.pid, startedAt, Array.isArray(r.survivors) ? r.survivors : undefined)
      : leftoverGroup(groups, r.pid, startedAt) ? [r.pid] : [];
    if (r.logged) {
      leftoverServer(r, pids.length ? pids : undefined, windows ? new Map(pids.map((pid) => [pid, startedByPid.get(pid)!])) : undefined);
      continue;
    }
    // From before dev servers logged to files: its output went to pipes that died with the old process, so it
    // can't be followed. Stop it instead.
    if (!pids.length) continue;
    if (windows) for (const pid of pids) killTree(pid);
    else killGroup(r.pid);
    const s = sweptServer(r.projectId);
    s.info = { projectId: r.projectId, status: "stopped", script: r.script, command: r.command, startedAt: r.startedAt, finishedAt: new Date().toISOString() };
    push(s, "system", `Stopped ${r.command ?? "the dev server"} (pid ${r.pid}), left running when the dashboard last shut down.`);
    changed(s);
  }
  saveRunning();
}

// Reattach to (or stop) the dev servers left by the previous dashboard process. Its PowerShell / ps calls run in the
// background so the server can start listening meanwhile; starting or stopping a dev server waits for it.
const leftoversAdopted: Promise<void> = adoptLeftovers().catch((err) => console.error("Adopting leftover dev servers:", err));

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
