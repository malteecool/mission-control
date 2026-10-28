// Desktop notifications when Claude needs you or finishes, so background task sessions don't sit waiting unseen.
// Browser permission is per browser, so the on/off switch lives in localStorage rather than the server settings.
import { useEffect, useRef } from "react";
import type { ProjectSummary, RunInfo, RunStatus } from "./api.ts";
import { chat } from "./chatStore.ts";
import { navigate, type Route } from "./router.ts";
import { useRuns } from "./runs.ts";

const KEY = "dashboard.notifications";

export const notificationsSupported = () => typeof window !== "undefined" && "Notification" in window;

export function notificationsOn(): boolean {
  try {
    return notificationsSupported() && Notification.permission === "granted" && localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Turns notifications on (asking the browser for permission if needed) or off. Returns the resulting state. */
export async function setNotifications(on: boolean): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (on && Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") on = false;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private window: works for this page only */
  }
  return on;
}

export function sendNotification(title: string, body: string, onClick?: () => void, tag?: string) {
  if (!notificationsOn()) return;
  const n = new Notification(title, { body, tag });
  n.onclick = () => {
    window.focus();
    onClick?.();
    n.close();
  };
}

const active = (s: RunStatus) => s === "queued" || s === "running";

/** The desktop app alerts about approvals natively, even with the window in the tray (desktop/src-tauri/src/approvals.rs). */
const desktopAlertsApprovals = () => (window as { __MISSION_CONTROL_DESKTOP__?: boolean }).__MISSION_CONTROL_DESKTOP__ === true;

export function useNotifications(projects: ProjectSummary[]) {
  const runs = useRuns();
  const seen = useRef<{ requests: Set<string>; status: Map<string, RunStatus> } | null>(null);

  useEffect(() => {
    // Whatever is already pending when the page opens isn't news; only notify about what happens after.
    const first = !seen.current;
    const s = (seen.current ??= { requests: new Set(), status: new Map() });
    const name = (id: number) => projects.find((p) => p.id === id)?.name ?? "Project";
    // Only when you're not looking at the dashboard.
    const away = () => document.visibilityState !== "visible" || !document.hasFocus();
    const go = (route: Route, run?: RunInfo) => () => {
      if (run) chat.attach(run.projectId, run);
      navigate(route);
    };

    for (const r of runs) {
      for (const p of r.permissions) {
        if (s.requests.has(p.requestId)) continue;
        s.requests.add(p.requestId);
        if (!first && away() && !desktopAlertsApprovals())
          sendNotification(
            `${name(r.projectId)}: Claude ${p.toolName === "AskUserQuestion" ? "has a question" : "needs your approval"}`,
            r.title,
            go({ name: "project", id: r.projectId, tab: "chat" }, r),
            p.requestId,
          );
      }
      const before = s.status.get(r.id);
      s.status.set(r.id, r.status);
      if (!before || !active(before) || active(r.status) || r.status === "stopped" || !away()) continue;
      const failed = r.status === "failed";
      sendNotification(
        `${name(r.projectId)}: ${
          r.role === "reviewer"
            ? failed
              ? "review agent failed"
              : "review agent finished"
            : r.taskId
              ? failed
                ? "task run failed"
                : "Claude finished a task"
              : failed
                ? "chat failed"
                : "Claude replied"
        }`,
        r.title,
        go({ name: "project", id: r.projectId, tab: r.taskId ? "tasks" : "chat" }),
        r.id,
      );
    }
  }, [runs, projects]);
}
