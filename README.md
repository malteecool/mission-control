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

**Requirements:** Node 22.13+ (uses the built-in `node:sqlite`), Git, and the Claude Code CLI logged in
(`claude`, then `/login`). Set `CLAUDE_BIN` if `claude` isn't on your PATH.

## How it works

- **Projects** are registered folders, stored in `server/data/dashboard.db`. Removing a project never touches its files.
  "Add project" also lists every folder you've already used Claude Code in.
- **Tasks** live in each project at `.dashboard/tasks.json`, so you can ask Claude to read, add or complete them in a chat.
  The "work on this" button on a task card hands it to Claude with exactly those instructions.
  Quick-add syntax: `Fix login #bug !1` (kinds: `#feature #bug #chore #idea`, priority `!1`–`!3`).
- **Chat** runs `claude -p --output-format stream-json` in the project folder, using your normal Claude login.
  Pick a model and permission mode per chat. In the default "Ask" mode, tools that need approval are denied
  because nobody can approve them; "Accept edits" lets Claude change files; "Full access" also allows shell commands.
- **History** reads Claude Code's own session files (`~/.claude/projects/…`), so it includes chats from the terminal
  and desktop app too. Any session can be resumed from the dashboard.

The API only accepts requests to a local host name, and writes need an `x-dashboard` header, so other websites
can't drive Claude through it.
