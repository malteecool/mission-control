// Reads Claude Code's own session store: ~/.claude/projects/<encoded cwd>/<session id>.jsonl
// Files can be tens of MB, so summaries read only the head and tail of each file.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { ChatItem, DiscoveredProject, SessionSearchHit, SessionSummary, SessionTranscript, TestRun } from "../types.ts";

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKTREE_MARKER = "--claude-worktrees-";

export function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

/** Claude Code names a project's session folder after its cwd with every non-alphanumeric char → "-". */
export function encodePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, "-");
}

async function listDirs(): Promise<string[]> {
  try {
    const entries = await fsp.readdir(claudeProjectsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** The project's own session folder plus folders for its .claude/worktrees/* checkouts. */
async function sessionDirsFor(projectPath: string): Promise<Array<{ dir: string; worktree?: string }>> {
  const key = encodePath(projectPath).toLowerCase();
  const out: Array<{ dir: string; worktree?: string }> = [];
  for (const name of await listDirs()) {
    const lower = name.toLowerCase();
    if (lower === key) out.push({ dir: path.join(claudeProjectsDir(), name) });
    else if (lower.startsWith(key + WORKTREE_MARKER))
      out.push({ dir: path.join(claudeProjectsDir(), name), worktree: name.slice(key.length + WORKTREE_MARKER.length) });
  }
  return out;
}

async function listJsonl(dir: string): Promise<Array<{ file: string; id: string; mtime: Date; size: number }>> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((n) => n.endsWith(".jsonl") && SESSION_ID_RE.test(n.slice(0, -6)));
  const stats = await Promise.all(
    files.map(async (n) => {
      const file = path.join(dir, n);
      // The file can be deleted between readdir and stat (e.g. Claude Code's session cleanup).
      const st = await fsp.stat(file).catch(() => null);
      return st && { file, id: n.slice(0, -6), mtime: st.mtime, size: st.size };
    }),
  );
  return stats.filter((s) => s !== null);
}

async function readChunk(file: string, from: "head" | "tail", bytes: number): Promise<any[]> {
  const fh = await fsp.open(file, "r");
  try {
    const { size } = await fh.stat();
    const len = Math.min(bytes, size);
    const start = from === "head" ? 0 : size - len;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    const lines = buf.toString("utf8").split("\n");
    // Drop the partial line at the cut.
    if (from === "head" && len < size) lines.pop();
    if (from === "tail" && start > 0) lines.shift();
    const out: any[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* partial or corrupt line */
      }
    }
    return out;
  } finally {
    await fh.close();
  }
}

type JsonlFile = { file: string; id: string; mtime: Date; size: number };

const activityCache = new Map<string, { mtimeMs: number; size: number; at: Date | undefined }>();

/** When the session last had a message, or undefined if no message timestamp was found (metadata-only files) or
 *  the file couldn't be read (e.g. deleted since it was listed). Not the file's mtime: Claude Code appends title
 *  and mode entries to old sessions (e.g. when they're listed for /resume), which would make a months-old session
 *  look fresh. */
async function lastMessageAt(f: JsonlFile): Promise<Date | undefined> {
  const hit = activityCache.get(f.file);
  if (hit && hit.mtimeMs === f.mtime.getTime() && hit.size === f.size) return hit.at;
  let newest = 0;
  try {
    // The last lines can be one huge tool result, so look further back if the first read finds no timestamp.
    for (const bytes of [64 * 1024, 2 * 1024 * 1024]) {
      for (const e of await readChunk(f.file, "tail", bytes)) {
        const t = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
        if (t > newest) newest = t;
      }
      if (newest || bytes >= f.size) break;
    }
  } catch {
    return undefined;
  }
  const at = newest ? new Date(Math.min(newest, f.mtime.getTime())) : undefined;
  activityCache.set(f.file, { mtimeMs: f.mtime.getTime(), size: f.size, at });
  return at;
}

/** Text of a real human prompt, or null for tool results, meta entries and slash-command plumbing. */
function userPromptText(entry: any): string | null {
  if (entry?.type !== "user" || entry.isMeta || entry.isSidechain) return null;
  const content = entry.message?.content;
  let text: string | null = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    if (content.some((b: any) => b?.type === "tool_result")) return null;
    text = content
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  }
  if (!text?.trim()) return null;
  if (/^\s*<(local-command|command-|system-reminder|bash-)/.test(text) || text.startsWith("Caveat:")) return null;
  return text.trim();
}

function oneLine(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

export async function listSessions(projectPath: string): Promise<SessionSummary[]> {
  const dirs = await sessionDirsFor(projectPath);
  const out: SessionSummary[] = [];
  for (const { dir, worktree } of dirs) {
    for (const f of await listJsonl(dir)) {
      const head = await readChunk(f.file, "head", 96 * 1024);
      const tail = f.size > 96 * 1024 ? await readChunk(f.file, "tail", 128 * 1024) : head;

      let firstPrompt: string | null = null;
      let createdAt: string | undefined;
      let cwd: string | undefined;
      let gitBranch: string | undefined;
      for (const e of head) {
        createdAt ??= e.timestamp;
        cwd ??= e.cwd;
        gitBranch ??= e.gitBranch;
        firstPrompt ??= userPromptText(e);
        if (firstPrompt && cwd) break;
      }
      let customTitle: string | undefined;
      let aiTitle: string | undefined;
      let lastPrompt: string | undefined;
      for (const e of tail) {
        if (e.type === "custom-title" && e.customTitle) customTitle = e.customTitle;
        if (e.type === "ai-title" && e.aiTitle) aiTitle = e.aiTitle;
        if (e.type === "summary" && e.summary) aiTitle ??= e.summary;
        if (e.type === "last-prompt" && e.lastPrompt) lastPrompt = e.lastPrompt;
      }
      // Sessions without any human prompt (aborted starts, sidechains) are noise.
      if (!firstPrompt && !lastPrompt) continue;
      out.push({
        id: f.id,
        title: oneLine(customTitle ?? aiTitle ?? firstPrompt ?? lastPrompt ?? "Untitled session", 100),
        firstPrompt: oneLine(firstPrompt ?? lastPrompt ?? ""),
        lastPrompt: lastPrompt ? oneLine(lastPrompt) : undefined,
        createdAt,
        updatedAt: ((await lastMessageAt(f)) ?? f.mtime).toISOString(),
        sizeBytes: f.size,
        gitBranch,
        worktree: worktree ? (cwd ? path.basename(cwd) : worktree) : undefined,
        cwd,
      });
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const lastActivityCache = new Map<string, { at: number; value?: string }>();

export async function lastSessionAt(projectPath: string): Promise<string | undefined> {
  const hit = lastActivityCache.get(projectPath);
  if (hit && Date.now() - hit.at < 15_000) return hit.value;
  let newest = 0;
  for (const { dir } of await sessionDirsFor(projectPath)) {
    for (const f of await listJsonl(dir)) newest = Math.max(newest, (await lastMessageAt(f))?.getTime() ?? 0);
  }
  const value = newest ? new Date(newest).toISOString() : undefined;
  lastActivityCache.set(projectPath, { at: Date.now(), value });
  return value;
}

/** Where a session's file lives and which folder it ran in. */
export async function locateSession(
  projectPath: string,
  sessionId: string,
): Promise<{ file: string; cwd: string } | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  for (const { dir, worktree } of await sessionDirsFor(projectPath)) {
    const file = path.join(dir, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    let cwd = projectPath;
    if (worktree) {
      const head = await readChunk(file, "head", 64 * 1024);
      cwd = head.find((e) => typeof e.cwd === "string")?.cwd ?? projectPath;
    }
    return { file, cwd };
  }
  return null;
}

export function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const pick =
    input.command ??
    input.file_path ??
    input.notebook_path ??
    input.pattern ??
    input.url ??
    input.query ??
    input.description ??
    input.prompt ??
    input.skill;
  if (typeof pick === "string") return oneLine(pick, 200);
  if (name === "TodoWrite" && Array.isArray(input.todos)) return `${input.todos.length} todos`;
  if (Array.isArray(input.questions))
    return oneLine(input.questions.map((q: any) => q?.question).filter(Boolean).join(" · "), 200);
  const firstString = Object.values(input).find((v) => typeof v === "string") as string | undefined;
  return firstString ? oneLine(firstString, 200) : "";
}

export function toolResultText(content: unknown): string {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    text = content
      .map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : ""))
      .filter(Boolean)
      .join("\n");
  else text = content == null ? "" : JSON.stringify(content);
  return text.length > 4000 ? text.slice(0, 4000) + "\n… (truncated)" : text;
}

const MAX_ITEMS = 1500;

export async function readTranscript(projectPath: string, sessionId: string): Promise<SessionTranscript | null> {
  const loc = await locateSession(projectPath, sessionId);
  if (!loc) return null;

  const items: ChatItem[] = [];
  const tools = new Map<string, Extract<ChatItem, { kind: "tool" }>>();
  let title: string | undefined;
  let aiTitle: string | undefined;
  let firstPrompt: string | undefined;
  let n = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(loc.file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "custom-title") title = e.customTitle;
    if (e.type === "ai-title") aiTitle = e.aiTitle;
    if (e.isSidechain) continue;

    if (e.type === "user") {
      const prompt = userPromptText(e);
      if (prompt) {
        firstPrompt ??= prompt;
        items.push({ kind: "user", id: e.uuid ?? `u${n++}`, text: prompt, ts: e.timestamp });
      } else if (Array.isArray(e.message?.content)) {
        for (const b of e.message.content) {
          if (b?.type !== "tool_result") continue;
          const tool = tools.get(b.tool_use_id);
          if (tool) {
            tool.result = toolResultText(b.content);
            tool.isError = !!b.is_error;
          }
        }
      }
    } else if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === "text" && b.text?.trim()) {
          items.push({ kind: "assistant", id: `${e.uuid ?? n++}:t`, text: b.text, ts: e.timestamp });
        } else if (b?.type === "tool_use") {
          const item = {
            kind: "tool" as const,
            id: b.id,
            name: b.name,
            summary: toolSummary(b.name, b.input),
            input: b.input,
            ts: e.timestamp,
          };
          tools.set(b.id, item);
          items.push(item);
        }
      }
    } else if (e.type === "system" && e.subtype === "compact_boundary") {
      items.push({ kind: "system", id: e.uuid ?? `s${n++}`, text: "Conversation compacted", ts: e.timestamp });
    }
  }

  const truncated = items.length > MAX_ITEMS;
  return {
    id: sessionId,
    title: oneLine(title ?? aiTitle ?? firstPrompt ?? "Untitled session", 100),
    items: truncated ? items.slice(-MAX_ITEMS) : items,
    truncated,
  };
}

// ── Full-text search ────────────────────────────────────────────────────────
// Searches what was said (prompts, Claude's replies) and what was touched (tool commands, file paths),
// not tool output, which is mostly file dumps and logs. Each file's text is cached until it changes.

type SearchEntry = { id: string; kind: "user" | "assistant" | "tool"; text: string; lower: string; ts?: string };
const searchCache = new Map<string, { mtimeMs: number; size: number; entries: SearchEntry[] }>();

async function searchEntries(file: string, mtimeMs: number, size: number): Promise<SearchEntry[]> {
  const hit = searchCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.entries;
  const entries: SearchEntry[] = [];
  const push = (id: string, kind: SearchEntry["kind"], text: string, ts?: string) =>
    entries.push({ id, kind, text, lower: text.toLowerCase(), ts });
  let n = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    // Cheap pre-filter: only user/assistant lines carry searchable text.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.isSidechain) continue;
    if (e.type === "user") {
      const prompt = userPromptText(e);
      // Same ids readTranscript gives these items, so a hit can be scrolled to.
      if (prompt) push(e.uuid ?? `u${n++}`, "user", prompt, e.timestamp);
    } else if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === "text" && b.text?.trim()) push(`${e.uuid ?? n++}:t`, "assistant", b.text, e.timestamp);
        else if (b?.type === "tool_use") {
          const summary = toolSummary(b.name, b.input);
          if (summary) push(b.id, "tool", `${b.name} ${summary}`, e.timestamp);
        }
      }
    }
  }
  searchCache.set(file, { mtimeMs, size, entries });
  return entries;
}

function snippet(text: string, lower: string, terms: string[], max = 220): string {
  let at = lower.length;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && i < at) at = i;
  }
  if (at === lower.length) at = 0;
  const start = Math.max(0, at - 60);
  const flat = text.slice(start, start + max * 2).replace(/\s+/g, " ").trim();
  const cut = flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
  return (start > 0 ? "…" : "") + cut;
}

/** Sessions where every word of the query appears somewhere, best matches first. */
export async function searchSessions(projectPath: string, query: string, limit = 50): Promise<SessionSearchHit[]> {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  const terms = [...new Set(phrase.split(" ").filter(Boolean))];
  if (!terms.length) return [];

  const files: Array<{ file: string; id: string; mtime: Date; size: number }> = [];
  for (const { dir } of await sessionDirsFor(projectPath)) files.push(...(await listJsonl(dir)));

  const out: SessionSearchHit[] = [];
  const work = async (f: (typeof files)[number]) => {
    const entries = await searchEntries(f.file, f.mtime.getTime(), f.size);
    const seen = new Set<string>();
    const matches: Array<{ e: SearchEntry; score: number }> = [];
    for (const e of entries) {
      let found = 0;
      for (const t of terms) if (e.lower.includes(t)) found++, seen.add(t);
      if (!found) continue;
      // Whole-phrase hits and the human's own words count for more.
      let score = found / terms.length;
      if (terms.length > 1 && e.lower.includes(phrase)) score += 1;
      if (e.kind === "user") score += 0.25;
      else if (e.kind === "tool") score -= 0.25;
      matches.push({ e, score });
    }
    if (seen.size < terms.length) return;
    const best = [...matches].sort((a, b) => b.score - a.score).slice(0, 3);
    out.push({
      sessionId: f.id,
      updatedAt: ((await lastMessageAt(f)) ?? f.mtime).toISOString(),
      hits: matches.length,
      score: best.reduce((sum, m) => sum + m.score, 0) + Math.log10(1 + matches.length),
      matches: best.map(({ e }) => ({ itemId: e.id, kind: e.kind, text: snippet(e.text, e.lower, terms), ts: e.ts })),
    });
  };
  // A few files at a time: the first search reads every transcript in full.
  const queue = [...files];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) await work(f);
  }));

  return out.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

// ── Last test run ───────────────────────────────────────────────────────────
// The dashboard doesn't run tests itself, so "last test result" is the last test (or type check) Claude ran in
// one of the project's sessions. Claude often pipes these through `head` or echoes `$?`, which hides the exit
// code from Claude Code, so the output is read too.

const TEST_COMMAND_RE =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|type-check|check)\b|vitest|jest|mocha|pytest|playwright\s+test|cargo\s+(?:test|nextest)|go\s+test|dotnet\s+test|mvn\b.*\btest|gradlew?\b.*\btest|rspec|phpunit|tox\b|deno\s+test|node\s+--test|python3?\s+-m\s+(?:pytest|unittest)|tsc\b[^|;&]*--noEmit|mypy|pyright)/i;
// Commands that merely mention a test tool (commit messages, searches).
const NOT_A_RUN_RE = /^(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:git|grep|rg|cat|echo|ls|sed|find|head|tail)\b/;
// The call never ran, so it says nothing about the tests.
const NO_OUTCOME_RE = /^\[(?:Tool call|Request) interrupted|doesn't want to proceed|^Permission to use|^Command running in background/;
const EXIT_RE = /(?:exit(?:\s*code)?|tsc)\s*[:=]?\s*(\d+)\b/gi;
const FAILURE_RE =
  /error TS\d+|\b[1-9]\d* (?:failed|failing|errors?)\b|^\s*FAIL\b|npm ERR!|test result: FAILED|Tests?:\s+[1-9]\d* failed/im;
const SUMMARY_RE =
  /\b\d+\s+(?:passed|passing|failed|failing|errors?|tests?)\b|\bTests?:|test result:|exit(?:\s*code)?\s*[:=]?\s*\d+/i;

/** The part of a shell line that runs tests, e.g. "npm test" out of "cd app && npm test 2>&1 | tail"; null if none does. */
function testSegment(command: string): string | null {
  const parts = withoutHeredocs(command).split(/&&|\|\||[;|\n]/).map((p) => p.trim());
  const part = parts.find((p) => TEST_COMMAND_RE.test(p) && !NOT_A_RUN_RE.test(p));
  return part ? part.replace(/(?:\s*\d?>>?\s*&?\S+)+\s*$/, "") : null;
}

/** Drops heredoc bodies (scripts piped into python, file contents) so only the shell commands themselves are left. */
function withoutHeredocs(command: string): string {
  return command.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, "$3");
}

function rawResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => (b?.type === "text" ? b.text : "")).join("\n");
  return "";
}

function testOutcome(output: string, isError: boolean): { passed: boolean; summary?: string } {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const summaryLine = [...lines].reverse().find((l) => SUMMARY_RE.test(l));
  const typeErrors = lines.filter((l) => /error TS\d+/.test(l)).length;
  const summary = summaryLine
    ? oneLine(summaryLine, 120)
    : typeErrors
      ? `${typeErrors} type error${typeErrors === 1 ? "" : "s"}`
      : undefined;
  const exits = [...output.matchAll(EXIT_RE)];
  if (exits.length) return { passed: exits[exits.length - 1][1] === "0", summary };
  return { passed: !isError && !FAILURE_RE.test(output), summary };
}

/** The last test run found in one session file's tail, or null. */
function lastTestIn(entries: any[], sessionId: string): TestRun | null {
  const pending = new Map<string, { command: string; at?: string }>();
  let last: TestRun | null = null;
  for (const e of entries) {
    if (!Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (e.type === "assistant" && b?.type === "tool_use" && (b.name === "Bash" || b.name === "PowerShell")) {
        const command = b.input?.command;
        if (typeof command !== "string" || b.input?.run_in_background) continue;
        const segment = testSegment(command);
        if (segment) pending.set(b.id, { command: segment, at: e.timestamp });
      } else if (e.type === "user" && b?.type === "tool_result" && pending.has(b.tool_use_id)) {
        const { command, at } = pending.get(b.tool_use_id)!;
        pending.delete(b.tool_use_id);
        const output = rawResultText(b.content);
        if (NO_OUTCOME_RE.test(output.trim())) continue;
        last = { command: oneLine(command, 120), at: e.timestamp ?? at, sessionId, ...testOutcome(output, !!b.is_error) };
      }
    }
  }
  return last;
}

const testCache = new Map<string, { mtimeMs: number; size: number; run: TestRun | null }>();

export async function lastTestRun(projectPath: string): Promise<TestRun | undefined> {
  const files: Array<{ file: string; id: string; mtime: Date; size: number }> = [];
  for (const { dir } of await sessionDirsFor(projectPath)) files.push(...(await listJsonl(dir)));
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  // Only the newest few sessions, and only their tails: an old result isn't much of a health signal anyway.
  for (const f of files.slice(0, 10)) {
    let hit = testCache.get(f.file);
    if (!hit || hit.mtimeMs !== f.mtime.getTime() || hit.size !== f.size) {
      const run = lastTestIn(await readChunk(f.file, "tail", 2 * 1024 * 1024), f.id);
      hit = { mtimeMs: f.mtime.getTime(), size: f.size, run };
      testCache.set(f.file, hit);
    }
    if (hit.run) return hit.run;
  }
  return undefined;
}

/** Folders Claude Code has sessions for — candidates to register as projects. */
export async function discoverProjects(): Promise<DiscoveredProject[]> {
  const byPath = new Map<string, DiscoveredProject>();
  const tmp = os.tmpdir().toLowerCase();
  const appData = (process.env.APPDATA ?? "").toLowerCase();
  for (const name of await listDirs()) {
    if (name.includes(WORKTREE_MARKER)) continue;
    const files = (await listJsonl(path.join(claudeProjectsDir(), name))).sort(
      (a, b) => b.mtime.getTime() - a.mtime.getTime(),
    );
    if (!files.length) continue;
    let cwd: string | undefined;
    for (const f of files.slice(0, 3)) {
      cwd = (await readChunk(f.file, "head", 64 * 1024)).find((e) => typeof e.cwd === "string")?.cwd;
      if (cwd) break;
    }
    if (!cwd || !fs.existsSync(cwd)) continue;
    const lower = cwd.toLowerCase();
    if (lower.startsWith(tmp) || (appData && lower.startsWith(appData)) || /[\\/]\.claude[\\/]worktrees[\\/]/.test(lower))
      continue;
    if (encodePath(cwd).toLowerCase() !== name.toLowerCase()) continue; // a session that cd'ed elsewhere
    const existing = byPath.get(lower);
    let newest = 0;
    for (const f of files) newest = Math.max(newest, (await lastMessageAt(f))?.getTime() ?? 0);
    if (!newest) continue; // no file has a message, so nothing has really happened here
    const lastActiveAt = new Date(newest).toISOString();
    if (existing) {
      existing.sessionCount += files.length;
      if (lastActiveAt > existing.lastActiveAt) existing.lastActiveAt = lastActiveAt;
    } else {
      byPath.set(lower, { path: cwd, name: path.basename(cwd), sessionCount: files.length, lastActiveAt });
    }
  }
  return [...byPath.values()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}
