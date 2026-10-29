import type {
  ChangeSummary,
  ChatRequest,
  DiscoveredProject,
  RunInfo,
  Overview,
  Schedule,
  PermissionReply,
  ProjectHealth,
  ProjectSummary,
  SessionSearchHit,
  SessionSummary,
  SessionTranscript,
  Settings,
  ClaudeInfo,
  DesktopStatus,
  DevServerInfo,
  DevServerStatus,
  AndroidProjectInfo,
  EmulatorInfo,
  EmulatorOverview,
  DeviceOverview,
  DirListing,
  FileContent,
  Task,
  TaskChanges,
  TaskPullRequest,
  UsageReport,
} from "../../../server/src/types.ts";

export type * from "../../../server/src/types.ts";

export class ApiError extends Error {}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    // Skip the HTTP cache, including anything a browser kept from before the server sent no-store.
    cache: "no-store",
    headers: { "content-type": "application/json", "x-dashboard": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(err.error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  // Anything but JSON here means the request didn't reach the route it meant to, e.g. a server that predates it.
  if (!res.headers.get("content-type")?.includes("application/json"))
    throw new ApiError(`Unexpected response from ${new URL(url, location.href).pathname}. Is the dashboard server up to date?`);
  return res.json();
}

export const api = {
  projects: () => request<ProjectSummary[]>("GET", "/api/projects"),
  project: (id: number) => request<ProjectSummary>("GET", `/api/projects/${id}`),
  discover: () => request<DiscoveredProject[]>("GET", "/api/projects/discover"),
  addProject: (body: { path: string; name?: string; description?: string }) =>
    request<ProjectSummary>("POST", "/api/projects", body),
  updateProject: (
    id: number,
    body: Partial<Pick<ProjectSummary, "name" | "description" | "color" | "pinned" | "autoRun" | "autoPermissionMode" | "parallelTasks" | "autoReview" | "featureBranches">> & {
      touch?: boolean;
    },
  ) =>
    request<ProjectSummary>("PATCH", `/api/projects/${id}`, body),
  removeProject: (id: number) => request<void>("DELETE", `/api/projects/${id}`),
  openProject: (id: number, app: "folder" | "editor") => request<void>("POST", `/api/projects/${id}/open`, { app }),

  tasks: (id: number) => request<Task[]>("GET", `/api/projects/${id}/tasks`),
  addTask: (id: number, body: Partial<Task>) => request<Task>("POST", `/api/projects/${id}/tasks`, body),
  updateTask: (id: number, taskId: string, body: Partial<Task>) =>
    request<Task>("PATCH", `/api/projects/${id}/tasks/${taskId}`, body),
  deleteTask: (id: number, taskId: string) => request<void>("DELETE", `/api/projects/${id}/tasks/${taskId}`),

  schedules: (id: number) => request<Schedule[]>("GET", `/api/projects/${id}/schedules`),
  addSchedule: (id: number, body: Partial<Schedule>) => request<Schedule>("POST", `/api/projects/${id}/schedules`, body),
  updateSchedule: (id: number, sid: string, body: Partial<Schedule>) =>
    request<Schedule>("PATCH", `/api/projects/${id}/schedules/${sid}`, body),
  deleteSchedule: (id: number, sid: string) => request<void>("DELETE", `/api/projects/${id}/schedules/${sid}`),
  runSchedule: (id: number, sid: string) => request<Task>("POST", `/api/projects/${id}/schedules/${sid}/run`),

  changeSummaries: (id: number) => request<ChangeSummary[]>("GET", `/api/projects/${id}/changes`),
  taskChanges: (id: number, taskId: string) => request<TaskChanges>("GET", `/api/projects/${id}/tasks/${taskId}/changes`),
  commitChanges: (id: number, taskId: string, message: string, paths?: string[]) =>
    request<{ commit?: string; files: number; skipped?: string[] }>("POST", `/api/projects/${id}/tasks/${taskId}/changes/commit`, { message, paths }),
  revertChanges: (id: number, taskId: string, paths?: string[]) =>
    request<{ reverted: string[]; skipped: string[] }>("POST", `/api/projects/${id}/tasks/${taskId}/changes/revert`, { paths }),
  mergeTask: (id: number, taskId: string, message: string) =>
    request<{ commit?: string; branch: string; into: string }>("POST", `/api/projects/${id}/tasks/${taskId}/changes/merge`, { message }),
  pushBranch: (id: number, taskId: string, message: string) =>
    request<{ commit?: string; branch: string; remote: string }>("POST", `/api/projects/${id}/tasks/${taskId}/changes/push`, { message }),
  openPullRequest: (id: number, taskId: string, message: string, title?: string) =>
    request<TaskPullRequest>("POST", `/api/projects/${id}/tasks/${taskId}/changes/pr`, { message, title }),
  openPr: (id: number, taskId: string) => request<void>("POST", `/api/projects/${id}/tasks/${taskId}/pr/open`),
  discardTask: (id: number, taskId: string) => request<void>("POST", `/api/projects/${id}/tasks/${taskId}/changes/discard`),
  dismissChanges: (id: number, taskId: string) => request<void>("DELETE", `/api/projects/${id}/tasks/${taskId}/changes`),
  askForChanges: (id: number, taskId: string, feedback: string) =>
    request<RunInfo>("POST", `/api/projects/${id}/tasks/${taskId}/run`, { feedback }),
  runReviewer: (id: number, taskId: string) => request<RunInfo>("POST", `/api/projects/${id}/tasks/${taskId}/reviewer`),
  approvePlan: (id: number, taskId: string, note?: string) =>
    request<RunInfo>("POST", `/api/projects/${id}/tasks/${taskId}/plan`, { approve: true, note }),
  revisePlan: (id: number, taskId: string, feedback: string) =>
    request<RunInfo>("POST", `/api/projects/${id}/tasks/${taskId}/plan`, { approve: false, feedback }),

  sessions: (id: number) => request<SessionSummary[]>("GET", `/api/projects/${id}/sessions`),
  searchSessions: (id: number, q: string) =>
    request<SessionSearchHit[]>("GET", `/api/projects/${id}/sessions/search?q=${encodeURIComponent(q)}`),
  session: (id: number, sid: string) => request<SessionTranscript>("GET", `/api/projects/${id}/sessions/${sid}`),

  files: (id: number, path: string) => request<DirListing>("GET", `/api/projects/${id}/files?path=${encodeURIComponent(path)}`),
  fileContent: (id: number, path: string) =>
    request<FileContent>("GET", `/api/projects/${id}/files/content?path=${encodeURIComponent(path)}`),
  fileRawUrl: (id: number, path: string) => `/api/projects/${id}/files/raw?path=${encodeURIComponent(path)}`,

  devServer: (id: number) => request<DevServerInfo>("GET", `/api/projects/${id}/dev`),
  devServers: () => request<DevServerStatus[]>("GET", "/api/dev"),
  startDevServer: (id: number, script: string) => request<DevServerStatus>("POST", `/api/projects/${id}/dev/start`, { script }),
  stopDevServer: (id: number) => request<{ stopped: boolean }>("POST", `/api/projects/${id}/dev/stop`),
  clearDevLogs: (id: number) => request<void>("DELETE", `/api/projects/${id}/dev/logs`),
  openDevPreview: (id: number) => request<void>("POST", `/api/projects/${id}/dev/open`),

  emulators: () => request<EmulatorOverview>("GET", "/api/emulator"),
  startEmulator: (avd: string) => request<EmulatorInfo>("POST", `/api/emulator/${encodeURIComponent(avd)}/start`),
  stopEmulator: (avd: string) => request<{ stopped: boolean }>("POST", `/api/emulator/${encodeURIComponent(avd)}/stop`),
  rotateEmulator: (avd: string) => request<void>("POST", `/api/emulator/${encodeURIComponent(avd)}/rotate`),
  emulatorScreenshotUrl: (avd: string) => `/api/emulator/${encodeURIComponent(avd)}/screenshot`,
  androidProject: (id: number) => request<AndroidProjectInfo>("GET", `/api/projects/${id}/android`),
  installApk: (id: number, target: { avd: string } | { serial: string }, apk: string) =>
    request<{ output: string }>("POST", `/api/projects/${id}/android/install`, { ...target, apk }),
  devices: () => request<DeviceOverview>("GET", "/api/devices"),
  connectDevice: (address: string, code?: string) => request<{ output: string }>("POST", "/api/devices/connect", { address, code }),
  disconnectDevice: (serial: string) => request<void>("POST", `/api/devices/${encodeURIComponent(serial)}/disconnect`),
  deviceScreenshotUrl: (serial: string) => `/api/devices/${encodeURIComponent(serial)}/screenshot`,

  overview: () => request<Overview>("GET", "/api/overview"),
  health: () => request<ProjectHealth[]>("GET", "/api/health"),
  usage: (projectId?: number, days = 30) =>
    request<UsageReport>("GET", `/api/usage?days=${days}${projectId === undefined ? "" : `&projectId=${projectId}`}`),

  settings: () => request<Settings>("GET", "/api/settings"),
  updateSettings: (body: Partial<Settings>) => request<Settings>("PATCH", "/api/settings", body),
  claudeInfo: () => request<ClaudeInfo>("GET", "/api/settings/claude"),
  desktop: () => request<DesktopStatus>("GET", "/api/desktop"),

  chat: (id: number, body: ChatRequest) => request<RunInfo>("POST", `/api/projects/${id}/chat`, body),
  runTask: (id: number, taskId: string, resume = false) =>
    request<RunInfo>("POST", `/api/projects/${id}/tasks/${taskId}/run`, resume ? { resume } : {}),
  runs: () => request<RunInfo[]>("GET", "/api/runs"),
  stopRun: (runId: string) => request<{ stopped: boolean }>("POST", `/api/runs/${runId}/stop`),
  answerPermission: (runId: string, reply: PermissionReply) =>
    request<{ ok: true }>("POST", `/api/runs/${runId}/permission`, reply),
};
