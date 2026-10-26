// Server-side runs (chats and task sessions), polled so cards, badges and the chat can show what Claude is doing.
import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type RunInfo } from "./api.ts";

const isActive = (r: RunInfo) => r.status === "queued" || r.status === "running";

export function useRuns(): RunInfo[] {
  const q = useQuery({
    queryKey: ["runs"],
    queryFn: api.runs,
    // Poll quickly while something is running so approvals and finished tasks show up promptly.
    refetchInterval: (query) => (query.state.data?.some(isActive) ? 1500 : 5000),
    // Keep polling in a background tab so desktop notifications still fire.
    refetchIntervalInBackground: true,
  });
  return q.data ?? [];
}

export function activeRuns(runs: RunInfo[], projectId?: number): RunInfo[] {
  return runs.filter((r) => isActive(r) && (projectId === undefined || r.projectId === projectId));
}

export function activeRunForTask(runs: RunInfo[], taskId: string): RunInfo | undefined {
  return runs.find((r) => r.taskId === taskId && isActive(r));
}

/** When a run finishes, refresh what it may have changed (task lanes, sessions, git state). */
export function useRefreshOnRunFinished() {
  const runs = useRuns();
  const qc = useQueryClient();
  const seen = useRef(new Map<string, RunInfo["status"]>());
  useEffect(() => {
    for (const r of runs) {
      const before = seen.current.get(r.id);
      if (before && isActive({ ...r, status: before }) && !isActive(r)) {
        const refresh = () => {
          for (const key of [["tasks", r.projectId], ["sessions", r.projectId], ["project", r.projectId], ["projects"], ["overview"]])
            qc.invalidateQueries({ queryKey: key });
        };
        refresh();
        // The server moves the task card right after the run ends; catch that write too.
        setTimeout(refresh, 1200);
      }
      seen.current.set(r.id, r.status);
    }
  }, [runs, qc]);
}
