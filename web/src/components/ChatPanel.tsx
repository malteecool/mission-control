import { useEffect, useRef } from "react";
import { MessageSquarePlus, Send, ShieldAlert, Sparkles, Square } from "lucide-react";
import type { PermissionMode, PermissionReply } from "../lib/api.ts";
import { chat, useChat } from "../lib/chatStore.ts";
import { Button, Empty, ErrorNote, Kbd } from "./ui.tsx";
import clsx from "clsx";
import { activeRuns, useRuns } from "../lib/runs.ts";
import { Transcript } from "./Transcript.tsx";
import { PermissionCard } from "./PermissionCard.tsx";
import { QuestionCard, askQuestions } from "./QuestionCard.tsx";

const MODELS = [
  { value: "", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

const MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: "default", label: "Ask first", hint: "Claude asks you before it edits files or runs commands" },
  { value: "acceptEdits", label: "Accept edits", hint: "Claude edits files without asking, and asks before shell commands" },
  { value: "plan", label: "Plan only", hint: "Claude explores and proposes a plan without changing anything" },
  { value: "bypassPermissions", label: "Full access", hint: "Claude may run any tool, including shell commands. Use with care." },
];

const SUGGESTIONS = [
  "Where did I leave off? Summarise recent changes and what looks unfinished.",
  "Read .dashboard/tasks.json and suggest which task to tackle next.",
  "Scan the codebase for TODOs and add them as tasks to .dashboard/tasks.json.",
];

export function ChatPanel({ projectId }: { projectId: number }) {
  const s = useChat(projectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  // Follow the stream unless the user scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [s.items, s.draft, s.running, s.permissions]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [projectId]);

  // Grow the composer with its content.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [s.composer]);

  // The project's other active runs (task sessions, chats started elsewhere) you can switch to.
  const others = activeRuns(useRuns(), projectId).filter((r) => r.id !== s.runId);

  const send = () => chat.send(projectId, s.composer);
  const mode = MODES.find((m) => m.value === s.permissionMode)!;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-6 py-3">
        <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-500">
          {s.taskId && (
            <span className="mr-2 rounded bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--accent)]">
              Task
            </span>
          )}
          {s.sessionId ? (
            <>
              <span className="text-slate-300">{s.sessionTitle ?? "Session"}</span> · {s.sessionId.slice(0, 8)}
            </>
          ) : (
            "New session"
          )}
        </div>
        <select
          value={s.model}
          onChange={(e) => chat.setModel(projectId, e.target.value)}
          disabled={s.running}
          className="h-8 rounded-lg border border-white/10 bg-black/30 px-2 text-xs text-slate-300 focus:outline-none"
          title="Model"
        >
          {MODELS.map((m) => (
            <option key={m.value} value={m.value} className="bg-slate-900">
              {m.label}
            </option>
          ))}
        </select>
        <select
          value={s.permissionMode}
          onChange={(e) => chat.setPermissionMode(projectId, e.target.value as PermissionMode)}
          disabled={s.running}
          className={`h-8 rounded-lg border bg-black/30 px-2 text-xs focus:outline-none ${
            s.permissionMode === "bypassPermissions" ? "border-rose-500/40 text-rose-300" : "border-white/10 text-slate-300"
          }`}
          title={mode.hint}
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value} className="bg-slate-900">
              {m.label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={() => chat.newSession(projectId)}
          disabled={!s.sessionId && !s.items.length}
          title="Start a new conversation (anything running keeps running)"
        >
          <MessageSquarePlus size={13} /> New
        </Button>
      </div>

      {others.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1.5 px-6 pb-2">
          {others.map((r) => (
            <button
              key={r.id}
              onClick={() => chat.attach(projectId, r)}
              className={clsx(
                "flex max-w-[280px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition",
                r.permissions.length
                  ? "animate-pulse border-amber-400/50 bg-amber-400/10 text-amber-200"
                  : "border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/25",
              )}
              title="Switch to this run"
            >
              <span
                className={clsx(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  r.permissions.length ? "bg-amber-400" : r.status === "queued" ? "bg-slate-500" : "bg-[var(--accent)]",
                )}
              />
              {r.taskId && <span className="font-mono text-[9px] uppercase tracking-wider opacity-70">task</span>}
              <span className="truncate">{r.title}</span>
              <span className="shrink-0 font-mono text-[9px] opacity-70">
                {r.permissions.length ? "needs you" : r.status === "queued" ? "queued" : "running"}
              </span>
            </button>
          ))}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-6"
      >
        <div className="mx-auto max-w-3xl pb-6">
          {s.items.length === 0 && !s.running ? (
            <Empty icon={<Sparkles size={20} />} title="Ask Claude about this project">
              Runs Claude Code in the project folder, with your normal login.
              <div className="mt-4 space-y-2">
                {SUGGESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => chat.setComposer(projectId, q)}
                    className="block w-full rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-left text-xs text-slate-300 transition hover:border-[color-mix(in_srgb,var(--accent)_50%,transparent)] hover:text-white"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </Empty>
          ) : (
            <Transcript items={s.items} draft={s.draft} running={s.running && !s.permissions.length} />
          )}

          {s.permissions.length > 0 && (
            <div className="mt-4 space-y-3">
              {s.permissions.map((r) => {
                const onAnswer = (reply: PermissionReply) => chat.answer(projectId, reply);
                const questions = r.toolName === "AskUserQuestion" ? askQuestions(r.input) : null;
                return questions ? (
                  <QuestionCard key={r.requestId} request={r} questions={questions} onAnswer={onAnswer} />
                ) : (
                  <PermissionCard key={r.requestId} request={r} onAnswer={onAnswer} />
                );
              })}
            </div>
          )}

          {s.error && (
            <div className="mt-4">
              <ErrorNote>
                {s.error}
                {/authenticat|login|oauth/i.test(s.error) && (
                  <div className="mt-1 text-xs text-rose-300/80">
                    Run <code className="font-mono">claude</code> in a terminal and use <code className="font-mono">/login</code>, then try again.
                  </div>
                )}
              </ErrorNote>
            </div>
          )}
          {s.lastRun && !s.running && (
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-slate-500">
              {s.lastRun.durationMs !== undefined && <span>{(s.lastRun.durationMs / 1000).toFixed(1)}s</span>}
              {s.lastRun.numTurns !== undefined && <span>{s.lastRun.numTurns} turns</span>}
              {s.lastRun.costUsd !== undefined && <span>${s.lastRun.costUsd.toFixed(4)}</span>}
            </div>
          )}
          {s.lastRun && s.lastRun.permissionDenials.length > 0 && (
            <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
              <div className="mb-1 flex items-center gap-1.5 font-medium">
                <ShieldAlert size={13} /> Denied tool calls
              </div>
              <ul className="space-y-0.5 font-mono text-[11px] text-amber-200/80">
                {s.lastRun.permissionDenials.slice(0, 6).map((d, i) => (
                  <li key={i} className="truncate">
                    {d}
                  </li>
                ))}
              </ul>
              <div className="mt-1 text-amber-200/70">Ask Claude to continue, or change the permission mode above, to try them again.</div>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-5">
        <div className="accent-ring glass mx-auto flex max-w-3xl items-end gap-2 rounded-2xl p-2">
          <textarea
            ref={inputRef}
            value={s.composer}
            onChange={(e) => chat.setComposer(projectId, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={s.sessionId ? "Continue the conversation…" : "Message Claude…"}
            className="max-h-60 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none"
          />
          {s.running ? (
            <Button variant="danger" onClick={() => chat.stop(projectId)} title="Stop">
              <Square size={13} /> Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={send} disabled={!s.composer.trim()} title="Send">
              <Send size={14} />
            </Button>
          )}
        </div>
        <div className="mx-auto mt-1.5 flex max-w-3xl justify-between px-2 font-mono text-[10px] text-slate-600">
          <span>{mode.hint}</span>
          <span className="hidden sm:inline">
            <Kbd>Enter</Kbd> send · <Kbd>Shift Enter</Kbd> newline
          </span>
        </div>
      </div>
    </div>
  );
}
