import type {
  ChatRequest,
  DiscoveredProject,
  RunInfo,
  Overview,
  PermissionReply,
  ProjectSummary,
  SessionSummary,
  SessionTranscript,
  Settings,
  ClaudeInfo,
  DesktopStatus,
  Task,
} from "../../../server/src/types.ts";

export type * from "../../../server/src/types.ts";

export class ApiError extends Error {}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-dashboard": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(err.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  projects: () => request<ProjectSummary[]>("GET", "/api/projects"),
  project: (id: number) => request<ProjectSummary>("GET", `/api/projects/${id}`),
  discover: () => request<DiscoveredProject[]>("GET", "/api/projects/discover"),
  addProject: (body: { path: string; name?: string; description?: string }) =>
    request<ProjectSummary>("POST", "/api/projects", body),
  updateProject: (
    id: number,
    body: Partial<Pick<ProjectSummary, "name" | "description" | "color" | "pinned" | "autoRun" | "autoPermissionMode">> & {
      touch?: boolean;
    },
  ) =>
    request<ProjectSummary>("PATCH", `/api/projects/${id}`, body),
  removeProject: (id: number) => request<void>("DELETE", `/api/projects/${id}`),

  tasks: (id: number) => request<Task[]>("GET", `/api/projects/${id}/tasks`),
  addTask: (id: number, body: Partial<Task>) => request<Task>("POST", `/api/projects/${id}/tasks`, body),
  updateTask: (id: number, taskId: string, body: Partial<Task>) =>
    request<Task>("PATCH", `/api/projects/${id}/tasks/${taskId}`, body),
  deleteTask: (id: number, taskId: string) => request<void>("DELETE", `/api/projects/${id}/tasks/${taskId}`),

  sessions: (id: number) => request<SessionSummary[]>("GET", `/api/projects/${id}/sessions`),
  session: (id: number, sid: string) => request<SessionTranscript>("GET", `/api/projects/${id}/sessions/${sid}`),

  overview: () => request<Overview>("GET", "/api/overview"),

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
