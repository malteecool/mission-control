// Live task board: the server pings whenever .dashboard/tasks.json changes (Claude, an editor, another tab).
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

// The server sends a heartbeat every 10s. Silence for longer means the connection is dead even if it looks open
// (Vite's dev proxy keeps the browser side open when the API restarts), so reconnect.
const STALE_MS = 25_000;

export function useTaskWatch(projectId: number) {
  const qc = useQueryClient();
  useEffect(() => {
    const ctrl = new AbortController();
    const refresh = () => {
      // A drag in flight refreshes itself when it settles; refetching now would flicker the card back.
      if (qc.isMutating()) return;
      for (const key of [["tasks", projectId], ["project", projectId], ["projects"], ["overview"]])
        qc.invalidateQueries({ queryKey: key });
    };

    (async () => {
      let delay = 1000;
      while (!ctrl.signal.aborted) {
        const conn = new AbortController();
        const stop = () => conn.abort();
        ctrl.signal.addEventListener("abort", stop);
        let lastSeen = Date.now();
        const watchdog = setInterval(() => Date.now() - lastSeen > STALE_MS && conn.abort(), 5000);
        try {
          const res = await fetch(`/api/projects/${projectId}/tasks/watch`, { signal: conn.signal });
          if (!res.ok || !res.body) throw new Error(`watch failed (${res.status})`);
          // Catch up on anything that changed while disconnected.
          refresh();
          delay = 1000;
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            lastSeen = Date.now();
            if (value.includes("changed")) refresh();
          }
        } catch {
          // Dropped, timed out or unmounted; the loop condition decides which.
        } finally {
          clearInterval(watchdog);
          ctrl.signal.removeEventListener("abort", stop);
        }
        if (ctrl.signal.aborted) return;
        // Server restarted or the connection dropped: try again, backing off to 30s.
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    })();

    return () => ctrl.abort();
  }, [projectId, qc]);
}
