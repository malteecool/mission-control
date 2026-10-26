import fs from "node:fs";
import path from "node:path";

// Pushes a ping whenever a project's .dashboard/tasks.json changes (Claude, an editor or the dashboard itself),
// so open task boards refetch without polling.

type Listener = () => void;

interface WatchState {
  listeners: Set<Listener>;
  watcher?: fs.FSWatcher;
  debounce?: ReturnType<typeof setTimeout>;
}

const watchers = new Map<string, WatchState>();

function notify(state: WatchState) {
  clearTimeout(state.debounce);
  // Writes arrive as several events (temp file, rename); report them once.
  state.debounce = setTimeout(() => {
    for (const l of state.listeners) l();
  }, 100);
}

/**
 * Watch the .dashboard folder rather than the file: writes replace tasks.json by renaming a temp file over it,
 * which would orphan a watch on the file itself. Until the folder exists, watch the project root (not recursively,
 * which would walk node_modules) for it to appear.
 */
function arm(projectPath: string, state: WatchState) {
  state.watcher?.close();
  const dir = path.join(projectPath, ".dashboard");
  try {
    if (fs.existsSync(dir)) {
      state.watcher = fs.watch(dir, { persistent: false }, (_, name) => {
        if (!name || name === "tasks.json") notify(state);
      });
    } else {
      state.watcher = fs.watch(projectPath, { persistent: false }, (_, name) => {
        if (name === ".dashboard" && fs.existsSync(dir)) {
          arm(projectPath, state);
          notify(state);
        }
      });
    }
    // The folder was deleted or the watch broke: start over from the project root.
    state.watcher.on("error", () => {
      if (watchers.get(projectPath) === state) setTimeout(() => arm(projectPath, state), 1000);
    });
  } catch {
    state.watcher = undefined;
  }
}

/** Subscribe to tasks.json changes for a project. Returns an unsubscribe function. */
export function watchTasks(projectPath: string, listener: Listener): () => void {
  let state = watchers.get(projectPath);
  if (!state) {
    state = { listeners: new Set() };
    watchers.set(projectPath, state);
    arm(projectPath, state);
  }
  state.listeners.add(listener);
  const s = state;
  return () => {
    s.listeners.delete(listener);
    if (s.listeners.size) return;
    clearTimeout(s.debounce);
    s.watcher?.close();
    watchers.delete(projectPath);
  };
}

/** NDJSON stream with one `{"type":"changed"}` line per change, until the client disconnects. */
export function watchTasksStream(projectPath: string): ReadableStream<Uint8Array> {
  const line = new TextEncoder().encode(JSON.stringify({ type: "changed" }) + "\n");
  let unwatch: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: Uint8Array) => {
        try {
          controller.enqueue(chunk);
        } catch {
          // Client went away; cancel() cleans up.
        }
      };
      unwatch = watchTasks(projectPath, () => send(line));
      // Heartbeat: lets the server notice a dropped client, and the client notice a dead server (the dev proxy
      // keeps the browser's end open when the API restarts). Keep in step with STALE_MS in web/src/lib/taskWatch.ts.
      keepAlive = setInterval(() => send(new Uint8Array([10])), 10_000);
    },
    cancel() {
      clearInterval(keepAlive);
      unwatch?.();
    },
  });
}
