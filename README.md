# Mission Control: project dashboard

A local dashboard for your hobby projects: typed tasks per project, plus chat with Claude Code in each project's
folder and a browsable history of every Claude session you've had there. See [PLAN.md](PLAN.md) for the design.

## Run it

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5317. The API runs on http://127.0.0.1:4317 (override with `DASHBOARD_API_PORT`).

For a single-process setup: `npm run build && npm start`, then open http://localhost:4317.

In dev, the API restarts when server code changes, but waits until no Claude session is running first, so a session
working on the dashboard itself doesn't cut itself off. If a session does get cut off (you closed the app, say), its
task card offers **Resume**, which continues the same Claude session.

### Desktop app

`desktop/` wraps the dashboard in a [Tauri](https://tauri.app) window with a tray icon. Needs Rust (`rustup`) on
top of the requirements below.

```bash
npm run desktop          # dev: runs `npm run dev` and opens it in the app window
npm run desktop:build    # builds the web app, the exe and an installer under desktop/src-tauri/target/release
```

The built app shows the same page the API serves at http://127.0.0.1:4317. If that server isn't already running it
starts one (`node` must be on your PATH; logs go to `server/data/desktop-server.log`) and stops it on Quit. It runs
the server from the checkout it was built in; set `DASHBOARD_ROOT` if you move it. Closing the window keeps the app
in the tray so task sessions keep going: click the tray icon to show or hide the window, right-click for Quit.
Quitting stops any Claude sessions the app's server is running; their cards offer **Resume** afterwards.
When Claude asks for approval or has a question while the window is hidden, minimised or in the background, the app
shows a Windows notification (and flashes the taskbar button if there is one); the tray tooltip counts what's waiting.
**Ctrl+Alt+D** shows or hides the window from anywhere; change it (or turn it off) under Settings → Desktop app,
which also says if another app already uses the combination.
To redraw the icon, edit `desktop/scripts/make-icon.mjs` and run `npm run icons -w desktop`.

**Requirements:** Node 22.13+ (uses the built-in `node:sqlite`), Git, and the Claude Code CLI logged in
(`claude`, then `/login`). Set `CLAUDE_BIN` if `claude` isn't on your PATH.

## How it works

- **Projects** are registered folders, stored in `server/data/dashboard.db`. Removing a project never touches its files.
  "Add project" also lists every folder you've already used Claude Code in.
- **Tasks** live in each project at `.dashboard/tasks.json`, so Claude can read them and add follow-ups. The board
  updates live when the file changes, whoever edits it.
  Quick-add syntax: `Fix login #bug !1` (kinds: `#feature #bug #chore #idea`, priority `!1`–`!3`).
- **Task automation:** moving a card to *In progress* starts a new Claude session for it on the server, and the
  dashboard moves the card itself. Claude ends with `TASK_STATUS: done` (the card goes to *Done*) or
  `TASK_STATUS: blocked - …` (it stays in progress with Claude's question; reply in that session and the card moves
  once Claude confirms). Failed or stopped runs stay in progress with the error. Moving the card out of *In progress*
  stops its run. One task runs at a time per project; the rest queue. Auto-start and the permission mode for task
  sessions are per-project settings, separate from the chat's mode; Settings → Task sessions sets the mode for all
  projects at once.
- **Runs live on the server,** so chats and task sessions keep going when you navigate away or reload. Cards and
  the chat show what's running; open one to watch it or answer approvals.
- **Chat** runs `claude -p --output-format stream-json` in the project folder, using your normal Claude login.
  Pick a model and permission mode per chat. In the default "Ask" mode, Claude pauses before editing files or
  running commands and waits for your approval — a card appears in the chat panel, and on any other page a popup in
  the bottom-right corner lets you allow, deny or answer it without switching (↗ opens the chat, − hides the popup;
  the task card's **Review** still works). "Accept edits" auto-approves file edits, asking only before shell
  commands. "Full access" auto-approves everything.
- **Settings** (sidebar, or Ctrl+K) holds dashboard-wide defaults: the model and permission mode new chats start
  with, the permission mode, model and standing instructions for task sessions, the automation settings new projects get, desktop
  notifications (per browser), and which `claude` executable to run.
- **History** reads Claude Code's own session files (`~/.claude/projects/…`), so it includes chats from the terminal
  and desktop app too. Any session can be resumed from the dashboard.

The API only accepts requests to a local host name, and writes need an `x-dashboard` header, so other websites
can't drive Claude through it.
