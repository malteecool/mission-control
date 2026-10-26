// Dev runner for the API: restarts it when server code changes, like `node --watch`, but waits until no Claude
// session is running first. Restarting stops every Claude process the server started, so without this a session
// that edits the dashboard's own server code would cut itself off mid-task.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(serverDir, "src");
const port = Number(process.env.DASHBOARD_API_PORT) || 4317;
const args = ["--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts"];

let child;
let restarting = false;
let pending = false;
let waitingSince = 0;
let debounce;

const say = (msg) => console.log(`\x1b[2m[dev]\x1b[22m ${msg}`);

function start() {
  child = spawn(process.execPath, args, { cwd: serverDir, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    child = undefined;
    if (restarting) {
      restarting = false;
      start();
    } else if (!shuttingDown) {
      say(`Server exited (${signal ?? `code ${code}`}). Waiting for a file change to start it again.`);
    }
  });
}

/** How many Claude sessions the running server has queued or in progress (0 if it can't be reached). */
async function activeRuns() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return 0;
    return (await res.json()).filter((r) => r.status === "running" || r.status === "queued").length;
  } catch {
    return 0;
  }
}

async function restartWhenIdle() {
  if (!pending) return;
  const n = await activeRuns();
  if (n) {
    if (!waitingSince) {
      waitingSince = Date.now();
      say(`Server code changed. Restarting once ${n} Claude session${n === 1 ? "" : "s"} finish${n === 1 ? "es" : ""}.`);
    }
    setTimeout(restartWhenIdle, 2000);
    return;
  }
  pending = false;
  if (child) {
    if (waitingSince) say("Claude sessions finished. Restarting.");
    restarting = true;
    child.kill();
  } else {
    say("Starting the server again.");
    start();
  }
  waitingSince = 0;
}

fs.watch(srcDir, { recursive: true }, (_, name) => {
  if (!name || !/\.(ts|json)$/.test(name)) return;
  pending = true;
  clearTimeout(debounce);
  // Edits come in bursts; wait for them to settle. While waiting on sessions, later edits join the same restart.
  debounce = setTimeout(() => {
    if (!waitingSince) void restartWhenIdle();
  }, 300);
});

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shuttingDown = true;
    // Let the server stop its Claude processes, then exit.
    if (child) child.once("exit", () => process.exit(0)).kill(sig);
    else process.exit(0);
  });
}

start();
