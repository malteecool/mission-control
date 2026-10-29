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
  /** Snapshots of the files around the task's sessions, so you can review what they changed. Cleared once reviewed. */
  review?: TaskReview;
  /** Start Claude in plan mode; it builds only after you approve its plan on the card. */
  planFirst?: boolean;
  /** The plan Claude proposed for this task (with planFirst). */
  plan?: string;
  /** You approved `plan`; later runs build instead of planning. Cleared when planFirst is toggled. */
  planApproved?: boolean;
  /** The task's own git worktree and branch (projects that run tasks in parallel). Cleared once merged or discarded. */
  worktree?: TaskWorktree;
  /** The recurring schedule that put this task on the board. */
  scheduleId?: string;
  /** The review agent's look at this task after it reached Done (projects with autoReview, or started by hand). */
  reviewer?: ReviewerReport;
  /** The finished task whose review suggested this one. */
  origin?: { taskId: string; title: string };
  /** The pull request opened for the task's branch from the review. */
  pr?: TaskPullRequest;
}

export interface TaskPullRequest {
  url: string;
  number?: number;
  branch: string;
  /** The branch it asks to merge into. */
  base: string;
  openedAt: string;
}

/** What the review agent made of a finished task: a quick code review, plus follow-up tasks it put in To do. */
export interface ReviewerReport {
  status: "running" | "done" | "failed";
  runId?: string;
  sessionId?: string;
  startedAt: string;
  finishedAt?: string;
  /** "good": nothing worth stopping for; "concerns": see findings. */
  verdict?: "good" | "concerns";
  summary?: string;
  findings?: ReviewerFinding[];
  /** Ids of the tasks it added to To do. */
  followUps?: string[];
  error?: string;
}

export interface ReviewerFinding {
  severity: "high" | "medium" | "low";
  text: string;
  /** "path" or "path:line". */
  file?: string;
}

/** A checkout of the project on its own branch, under <project>/.claude/worktrees/, where one task's sessions work. */
export interface TaskWorktree {
  /** The worktree's top folder. */
  root: string;
  /** The project folder inside it, where Claude runs (the same as root unless the project is a subfolder of its repo). */
  path: string;
  branch: string;
  /** The commit the branch started from. */
  base: string;
}

/** Git tree objects recording the project's working tree (untracked files included) around a task's sessions. */
export interface TaskReview {
  /** Before the task's first run since it was last reviewed. */
  base: string;
  /** After its latest run ended; missing while a run is going or if one was cut off. */
  end?: string;
  /** HEAD at those two moments, to spot commits the sessions made themselves. */
  head?: string;
  endHead?: string;
  startedAt: string;
}

export interface ChangedFile {
  /** Relative to the repository root, with forward slashes. */
  path: string;
  status: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  binary: boolean;
  /** The file's unified diff; empty when it was too large to send. */
  patch: string;
  truncated?: boolean;
}

/** What a task's sessions changed, from GET /api/projects/:id/tasks/:taskId/changes. */
export interface TaskChanges {
  taskId: string;
  files: ChangedFile[];
  /** No end snapshot yet, so this compares with the files as they are now (which may include others' edits). */
  live: boolean;
  /** Commits the sessions made themselves, "<hash> <subject>". */
  commits: string[];
  since?: string;
  /** Git has cleaned up the snapshots, so the changes can't be shown any more. */
  missing?: boolean;
  /** For a task in its own worktree: its branch, and the branch your main checkout is on (what Merge merges into). */
  branch?: string;
  into?: string;
  /** The remote Push and Open PR use (origin if there is one); missing when the repository has no remote. */
  remote?: string;
  /** The remote is on GitHub, so Open PR can work (through the gh CLI). */
  github?: boolean;
}

/** One entry per task with changes to review, from GET /api/projects/:id/changes. */
export interface ChangeSummary {
  taskId: string;
  /** Set for a task in its own worktree; listed even with no changed files, so its branch can be discarded. */
  branch?: string;
  files: number;
  added: number;
  removed: number;
}

/**
 * When a schedule comes round, in the server's local time. "hourly" runs every `every` hours (counted from midnight)
 * at `time`'s minute; "weekly" on `days` (0 = Sunday); "monthly" on `monthDay`, or the month's last day if it's shorter.
 */
export interface ScheduleRule {
  freq: "hourly" | "daily" | "weekdays" | "weekly" | "monthly";
  /** "HH:MM", 24-hour. */
  time: string;
  days?: number[];
  monthDay?: number;
  every?: number;
}

/** A recurring task: each time it comes round, a fresh copy lands on the project's board (and starts, with autoStart). */
export interface Schedule {
  id: string;
  projectId: number;
  title: string;
  notes?: string;
  kind: TaskKind;
  priority: TaskPriority;
  planFirst?: boolean;
  rule: ScheduleRule;
  enabled: boolean;
  /** Start a Claude session on the task right away; otherwise it waits in To do. */
  autoStart: boolean;
  createdAt: string;
  /** Missing while disabled. */
  nextRunAt?: string;
  lastRunAt?: string;
  /** The task the last run put on the board. */
  lastTaskId?: string;
  /** What happened last time when it wasn't a plain run, e.g. it was skipped. */
  lastNote?: string;
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

/** The last test command Claude ran in one of the project's sessions, and how it went. */
export interface TestRun {
  command: string;
  passed: boolean;
  at?: string;
  sessionId: string;
  /** A line from the output that sums it up, e.g. "Tests: 2 failed, 40 passed". */
  summary?: string;
}

/** A local branch worth cleaning up: no commits for a while, or its remote branch was deleted. */
export interface StaleBranch {
  name: string;
  lastCommitAt: string;
  /** Its upstream branch no longer exists (usually merged and deleted on the remote). */
  gone: boolean;
}

/** One entry per project for the overview's health panel, from GET /api/health. */
export interface ProjectHealth {
  projectId: number;
  exists: boolean;
  isRepo: boolean;
  branch?: string;
  /** Files with uncommitted changes, untracked ones included. */
  uncommitted: number;
  /** Commits on HEAD that aren't on its upstream, or on any remote when it has no upstream. */
  unpushed: number;
  /** Commits on the upstream that HEAD doesn't have yet (as of the last fetch). */
  behind: number;
  hasRemote: boolean;
  /** HEAD's branch isn't tracking a remote branch. */
  noUpstream: boolean;
  staleBranches: StaleBranch[];
  lastTest?: TestRun;
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
  /** Give each task its own git worktree and branch so several run at once, instead of one at a time in the folder. */
  parallelTasks: boolean;
  /** When a task reaches Done, run the review agent on it: a quick code review that can add follow-up tasks. */
  autoReview: boolean;
  /** Feature tasks get their own worktree and feature/… branch even when tasks don't run in parallel. */
  featureBranches: boolean;
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "stopped";

/** A Claude run tracked by the server: an interactive chat turn or a task session. */
export interface RunInfo {
  id: string;
  projectId: number;
  /** Set for runs working on a task. */
  taskId?: string;
  /** "reviewer": the review agent looking over a finished task, not work on the task itself. */
  role?: "reviewer";
  sessionId?: string;
  title: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  /** Approvals and questions waiting for you. */
  permissions: PermissionRequest[];
  /** The mode and model the run was started with. */
  permissionMode: PermissionMode;
  model?: string;
  error?: string;
}

export type DevStatus = "running" | "stopped" | "crashed";

/** A project's dev command (`npm run dev` etc.) started from the dashboard. */
export interface DevServerStatus {
  projectId: number;
  status: DevStatus;
  script?: string;
  command?: string;
  pid?: number;
  /** The first local URL the command printed, for the "Open preview" link. */
  url?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
}

export interface DevServerInfo extends DevServerStatus {
  packageManager: string;
  /** package.json scripts, the likely dev command first. */
  scripts: Array<{ name: string; command: string }>;
}

export type EmulatorState = "stopped" | "starting" | "booting" | "running" | "stopping" | "crashed";

/** One Android Virtual Device and, if it's running, the emulator instance for it. */
export interface EmulatorInfo {
  avd: string;
  state: EmulatorState;
  /** The adb serial (`emulator-5554`) while it runs. */
  serial?: string;
  pid?: number;
  /** Whether the dashboard can show its screen: false when it runs without a gRPC token we can read (Android Studio). */
  viewable: boolean;
  /** Device screen size in pixels, portrait. */
  screen?: { width: number; height: number };
  /** Why it can't be shown, or why it crashed (the tail of its log). */
  message?: string;
}

export interface EmulatorOverview {
  /** The Android SDK folder, when one was found. */
  sdk?: string;
  /** Set when the SDK or its emulator is missing. */
  error?: string;
  avds: EmulatorInfo[];
}

/** A physical device (or anything else adb sees that isn't one of the SDK's emulators), mirrored through scrcpy. */
export interface DeviceInfo {
  /** The adb serial: `R58M123ABC` over USB, `192.168.1.20:5555` or an mDNS name over Wi-Fi. */
  serial: string;
  /** adb's state: `device` when it's usable, else `unauthorized`, `offline`, `no permissions`… */
  state: string;
  /** The model, as adb reports it (`Pixel 8`), else the serial. */
  name: string;
  transport: "usb" | "wifi";
  /** Whether it can be mirrored now (adb state `device`). */
  ready: boolean;
  /** What to do when it isn't ready. */
  message?: string;
}

export interface DeviceOverview {
  /** Set when adb is missing or failed. */
  error?: string;
  devices: DeviceInfo[];
}

/** What the Android tab needs to know about a project. */
export interface AndroidProjectInfo {
  /** Has Gradle files or an AndroidManifest.xml. */
  isAndroid: boolean;
  /** Built APKs under `<module>/build/outputs/apk`, newest first. Paths are relative to the project. */
  apks: Array<{ path: string; size: number; modifiedAt: string }>;
}

export interface DevLogLine {
  seq: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
  ts: string;
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

/** One session matching a History search, from GET /api/projects/:id/sessions/search?q=. */
export interface SessionSearchHit {
  sessionId: string;
  updatedAt: string;
  /** How many prompts, replies and tool calls matched. */
  hits: number;
  score: number;
  /** The best few matches; itemId is the transcript item to scroll to. */
  matches: Array<{ itemId: string; kind: "user" | "assistant" | "tool"; text: string; ts?: string }>;
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
  /** Global shortcut that shows or hides the desktop app's window, e.g. "Ctrl+Alt+D"; "" turns it off. */
  desktopHotkey: string;
}

/** What the desktop app last reported about itself. */
export interface DesktopStatus {
  /** Whether the desktop app has reported in the last minute. */
  running: boolean;
  /** The shortcut it has registered, if any. */
  hotkey?: string;
  /** Why it couldn't register desktopHotkey, e.g. another app already uses it. */
  error?: string;
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

export interface UsageTotals {
  costUsd: number;
  runs: number;
  turns: number;
}

/** Cost and turns of finished Claude runs, from GET /api/usage (optionally for one project). */
export interface UsageReport {
  /** Everything recorded. */
  total: UsageTotals;
  /** Today, in the server's local time. */
  today: UsageTotals;
  /** The days covered by `days`. */
  period: UsageTotals;
  /** One entry per day, oldest first, including days with nothing. `day` is YYYY-MM-DD. */
  days: Array<UsageTotals & { day: string }>;
  /** Most expensive first. */
  projects: Array<UsageTotals & { projectId: number; name: string; color: string }>;
  /** Task runs plus chat turns in a task's session; most expensive first. */
  tasks: Array<UsageTotals & { projectId: number; taskId: string; title: string; status?: TaskStatus; lastRunAt: string }>;
}

/** One entry of a project folder, from GET /api/projects/:id/files. */
export interface FileEntry {
  name: string;
  /** Relative to the project folder, with forward slashes. */
  path: string;
  type: "dir" | "file";
  /** Bytes; 0 for folders. */
  size: number;
  modifiedAt: string;
}

export interface DirListing {
  /** "" for the project folder itself. */
  path: string;
  /** Folders first, then files, each by name. */
  entries: FileEntry[];
  /** Set when the folder had more entries than are listed. */
  truncated?: boolean;
}

/** A file's contents, from GET /api/projects/:id/files/content. */
export interface FileContent {
  path: string;
  size: number;
  modifiedAt: string;
  /** Looks binary, so there's no `text`. */
  binary: boolean;
  /** A picture the browser can show from GET /api/projects/:id/files/raw. */
  image: boolean;
  text?: string;
  /** Only the start of the file is in `text`. */
  truncated?: boolean;
}
