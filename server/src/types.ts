// Shared types — imported by the web app as type-only imports.

export type TaskStatus = "todo" | "doing" | "done";
export type TaskKind = "feature" | "bug" | "chore" | "idea";
export type TaskPriority = 1 | 2 | 3;

export interface Task {
  id: string;
  title: string;
  notes?: string;
  status: TaskStatus;
  kind: TaskKind;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
  doneAt?: string;
  /** Claude session the task was worked on in. */
  sessionId?: string;
  /**
   * Set when Claude's last run on this task ended without finishing it: "blocked" when Claude needs
   * something from you, "failed" when the run errored or was stopped. Cleared when a run finishes the task.
   */
  agentStatus?: "blocked" | "failed";
  /** Claude's explanation (or the error) that goes with agentStatus. */
  agentNote?: string;
}

export interface TaskFile {
  version: 1;
  tasks: Task[];
}

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  dirty?: number;
  lastCommitAt?: string;
  lastCommitMessage?: string;
}

export interface Project {
  id: number;
  name: string;
  path: string;
  color: string;
  description: string;
  pinned: boolean;
  createdAt: string;
  lastOpenedAt?: string;
  /** Start a Claude session when a task is moved to "In progress". */
  autoRun: boolean;
  /** Permission mode those task sessions run in. */
  autoPermissionMode: PermissionMode;
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped";

/** A Claude run tracked by the server: an interactive chat turn or a task session. */
export interface RunInfo {
  id: string;
  projectId: number;
  /** Set for runs working on a task. */
  taskId?: string;
  sessionId?: string;
  title: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  /** Approvals and questions waiting for you. */
  permissions: PermissionRequest[];
  error?: string;
}

export interface ProjectSummary extends Project {
  exists: boolean;
  git: GitInfo;
  counts: Record<TaskStatus, number>;
  lastSessionAt?: string;
}

export interface DiscoveredProject {
  path: string;
  name: string;
  sessionCount: number;
  lastActiveAt: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  firstPrompt: string;
  lastPrompt?: string;
  createdAt?: string;
  updatedAt: string;
  sizeBytes: number;
  gitBranch?: string;
  /** Set when the session ran in a git worktree of the project. */
  worktree?: string;
  cwd?: string;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; ts?: string }
  | { kind: "assistant"; id: string; text: string; ts?: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      summary: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      ts?: string;
    }
  | { kind: "system"; id: string; text: string; ts?: string };

export interface SessionTranscript {
  id: string;
  title: string;
  items: ChatItem[];
  truncated: boolean;
}

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Dashboard-wide preferences (the settings page). Per-project settings live on Project. */
export interface Settings {
  /** Model new chats start with; "" means Claude Code's own default. */
  defaultModel: string;
  /** Permission mode new chats start in. */
  defaultPermissionMode: PermissionMode;
  /** Model for task sessions; "" means the same as defaultModel. */
  taskModel: string;
  /** Added to every task session's prompt, e.g. "Run the tests before finishing". */
  taskInstructions: string;
  /** What a newly added project gets for autoRun and autoPermissionMode. */
  newProjectAutoRun: boolean;
  newProjectPermissionMode: PermissionMode;
  /** Path to the claude executable; "" means find it on PATH. */
  claudePath: string;
}

export interface ClaudeInfo {
  /** The executable the dashboard will run. */
  command: string;
  version?: string;
  error?: string;
}

export interface ChatRequest {
  prompt: string;
  sessionId?: string;
  model?: string;
  permissionMode?: PermissionMode;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolUseId?: string;
  summary: string;
  input: unknown;
  /** Claude Code offered rules that would stop it asking again for this kind of call. */
  canAlways: boolean;
}

export interface PermissionReply {
  requestId: string;
  allow: boolean;
  always?: boolean;
  message?: string;
  /** Answers to an AskUserQuestion call, keyed by question text; multi-select labels joined with ", ". */
  answers?: Record<string, string>;
}

/** Input of Claude Code's AskUserQuestion tool. */
export interface AskQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/** Normalised run events, streamed as NDJSON from GET /api/runs/:id/events (replayed from the start). */
export type ChatEvent =
  | { type: "run"; runId: string }
  | { type: "permission"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string }
  | { type: "init"; sessionId: string; model?: string; cwd?: string }
  | { type: "delta"; text: string }
  | { type: "item"; item: ChatItem }
  | { type: "tool_result"; toolUseId: string; result: string; isError: boolean }
  | {
      type: "done";
      sessionId?: string;
      isError: boolean;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
      permissionDenials: string[];
      /** Error text when isError. */
      text?: string;
      /** Claude's final message. */
      result?: string;
    }
  | { type: "error"; message: string };

export interface Overview {
  projects: number;
  counts: Record<TaskStatus, number>;
  nextUp: Array<Task & { projectId: number; projectName: string; projectColor: string }>;
  recentlyDone: Array<Task & { projectId: number; projectName: string; projectColor: string }>;
}
