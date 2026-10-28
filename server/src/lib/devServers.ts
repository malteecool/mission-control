// Runs a project's dev command (`npm run dev` and friends) from its page, keeping recent output so the Dev tab can
// show logs and attach at any time. One dev server per project; it lives as long as the dashboard server does.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill();
    }
  }
}

export function stopDevServer(projectId: number): boolean {
  const s = servers.get(projectId);
  if (!s?.child) return false;
  s.stopRequested = true;
  push(s, "system", "Stopping…");
  killTree(s.child);
  return true;
}

// Don't leave dev servers holding their ports after the dashboard goes away (claudeRunner turns signals into exit).
process.on("exit", () => {
  for (const s of servers.values()) if (s.child) killTree(s.child);
});

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
