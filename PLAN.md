# Project Dashboard — Implementation Plan (MVP)

A local-first dashboard to track hobby projects, their open/done tasks, and Claude Code chats.

## Goals (MVP)

1. **Model chat + history** — chat with Claude Code *in a project's folder* from the dashboard, streamed live;
   browse and resume every past session (including ones started from the terminal / desktop app).
2. **Typed tasks** — a single, typed task model (pending vs. performed) shown the same way for every project.
3. **Easy navigation** — sidebar of projects, `Ctrl+K` command palette, keyboard-first switching.

## Architecture

```
┌──────────── web (Vite + React) ────────────┐      ┌────────────── server (Node + Hono) ──────────────┐
│ Sidebar · Command palette · Project view   │ HTTP │ /api/projects   → SQLite (node:sqlite) registry   │
│ Task board · Chat panel · Session history  │◄────►│ /api/tasks      → <repo>/.dashboard/tasks.json    │
│                                            │ NDJSON│ /api/sessions   → ~/.claude/projects/*/*.jsonl    │
│                                            │stream│ /api/chat       → spawn `claude -p --output-format │
└────────────────────────────────────────────┘      │                    stream-json` in the repo folder │
                                                    └──────────────────────────────────────────────────┘
```

| Layer     | Choice | Notes |
|-----------|--------|-------|
| Frontend  | React 19, Vite, TypeScript | |
| Styling   | Tailwind CSS v4, Framer Motion, lucide-react | dark "HUD" theme: glass panels, neon accents, grid backdrop |
| Data      | TanStack Query | caching + refetch |
| Markdown  | react-markdown + remark-gfm | render Claude replies |
| Backend   | Hono on @hono/node-server, run with `tsx` | |
| Storage   | `node:sqlite` (built into Node 22.13+) | no native build step; file at `server/data/dashboard.db` |
| Chat      | Claude Code CLI headless mode | uses the existing Claude login, no API key |

## Data model

**Project** (SQLite `projects`): `id, name, path, color, description, pinned, created_at, last_opened_at`.

**Task** (stored in each repo at `.dashboard/tasks.json`, so Claude can read/edit it in a chat):

```ts
type TaskStatus = "todo" | "doing" | "done";
type TaskKind = "feature" | "bug" | "chore" | "idea";
interface Task {
  id: string; title: string; notes?: string;
  status: TaskStatus; kind: TaskKind; priority: 1 | 2 | 3;
  createdAt: string; updatedAt: string; doneAt?: string;
  sessionId?: string;            // Claude session the task was worked on in
}
interface TaskFile { version: 1; tasks: Task[] }
```

The file is only created when the first task is added. Writes are atomic (temp file + rename).

## Claude integration

- **Run a turn**: `claude -p --output-format stream-json --verbose --include-partial-messages
  [--resume <id>] [--model <m>] --permission-mode <mode>`, cwd = project path, prompt sent on stdin.
  The server forwards each JSON line to the browser as NDJSON; the UI renders text deltas, tool calls,
  tool results and the final `result` (cost, duration). A stop button kills the process.
- **Binary resolution (Windows)**: `claude.cmd` can't be spawned without a shell, so the server resolves
  the real `claude.exe` next to the shim (override with `CLAUDE_BIN`).
- **Permission mode** selectable per chat: `default` (read-only tools), `acceptEdits`, `plan`,
  `bypassPermissions` (with a warning).
- **History**: sessions live in `~/.claude/projects/<path with non-alphanumerics → "-">/<id>.jsonl`.
  Files can be tens of MB, so the list view reads only the head (first prompt, timestamps) and the tail
  (latest `custom-title` / `ai-title`, `last-prompt`). The detail view streams the file line by line and
  keeps only user/assistant text and tool-call summaries.
- **Project discovery**: "Import from Claude history" lists folders that have sessions (real path taken from
  the `cwd` field inside the session files), so registering existing projects is one click.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET/POST | `/api/projects` | list (with task counts + git info) / register |
| PATCH/DELETE | `/api/projects/:id` | edit / unregister (never touches files) |
| GET | `/api/projects/discover` | candidate folders from Claude history |
| GET/POST | `/api/projects/:id/tasks` | list / create |
| PATCH/DELETE | `/api/projects/:id/tasks/:taskId` | update / delete |
| GET | `/api/projects/:id/sessions` | session list |
| GET | `/api/projects/:id/sessions/:sid` | session transcript |
| POST | `/api/projects/:id/chat` | start a turn → NDJSON stream |
| POST | `/api/chat/:runId/stop` | kill a running turn |
| GET | `/api/overview` | cross-project counts + recently done tasks |

## UI

- **Sidebar**: project list (pinned first, color dot, open-task badge, git dirty marker), add/import buttons.
- **Overview** (home): stat tiles, "next up" across all projects, recently completed timeline.
- **Project view**: header (path, branch, last commit, dirty) · tabs **Tasks** | **Chat** | **History**.
  - Tasks: columns To do / Doing / Done; quick-add input with `#bug`/`#idea`/`!1` shortcuts; filter by kind.
  - Chat: streaming transcript, collapsible tool calls, model + permission pickers, stop, "new session".
  - History: session list with titles and dates → open transcript read-only → "Resume" continues it in Chat.
- **Command palette** (`Ctrl+K`): jump to project, switch tab, new task, new chat.

## Build steps

1. Scaffold npm workspaces (`server`, `web`), root `npm run dev` runs both (concurrently).
2. Server: SQLite registry, task file store, git info, Claude session reader, project discovery.
3. Server: chat runner (spawn, stream, stop).
4. Web: theme + layout + sidebar + palette + overview.
5. Web: tasks board, chat panel, history.
6. Verify: register this repo, add tasks, run a real chat turn, resume it, check history.

## Out of scope for MVP (later)

Global hotkey for the desktop app (the Tauri wrapper and tray now exist, see `desktop/`), live file watching, multiple concurrent chats per project,
GitHub issue sync, tagging/search across projects, tool-permission prompts answered from the UI.
