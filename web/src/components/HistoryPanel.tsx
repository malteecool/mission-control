import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, GitBranch, History, MessageSquareShare, Search } from "lucide-react";
import { api } from "../lib/api.ts";
import { href, navigate } from "../lib/router.ts";
import { chat, useChat } from "../lib/chatStore.ts";
import { formatBytes, timeAgo } from "../lib/util.ts";
import { Button, Empty, ErrorNote } from "./ui.tsx";
import { Transcript } from "./Transcript.tsx";

export function HistoryPanel({ projectId, sessionId }: { projectId: number; sessionId?: string }) {
  const sessions = useQuery({ queryKey: ["sessions", projectId], queryFn: () => api.sessions(projectId) });
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = sessions.data ?? [];
    return q ? list.filter((s) => `${s.title} ${s.firstPrompt} ${s.lastPrompt ?? ""}`.toLowerCase().includes(q)) : list;
  }, [sessions.data, query]);

  return (
    <div className="grid h-full min-h-0 lg:grid-cols-[360px_1fr]">
      <div className={clsx("flex min-h-0 flex-col border-white/[0.06] lg:border-r", sessionId && "hidden lg:flex")}>
        <div className="p-4 pb-2">
          <div className="accent-ring flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3">
            <Search size={13} className="text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sessions…"
              className="flex-1 bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {sessions.isLoading && <div className="p-4 text-sm text-slate-500">Reading Claude history…</div>}
          {sessions.error && <ErrorNote>{sessions.error.message}</ErrorNote>}
          {sessions.data?.length === 0 && (
            <Empty icon={<History size={20} />} title="No sessions yet">
              Chats you have with Claude Code in this folder, from here, the terminal or the desktop app, show up here.
            </Empty>
          )}
          <ul className="space-y-1">
            {filtered.map((s) => (
              <li key={s.id}>
                <a
                  href={href({ name: "project", id: projectId, tab: "history", sessionId: s.id })}
                  className={clsx(
                    "block rounded-xl border px-3 py-2.5 transition",
                    s.id === sessionId
                      ? "border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
                      : "border-transparent hover:bg-white/[0.04]",
                  )}
                >
                  <div className="truncate text-sm text-slate-100">{s.title}</div>
                  {s.lastPrompt && s.lastPrompt !== s.firstPrompt && (
                    <div className="mt-0.5 truncate text-xs text-slate-500">↳ {s.lastPrompt}</div>
                  )}
                  <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-slate-500">
                    <span>{timeAgo(s.updatedAt)}</span>
                    {s.gitBranch && (
                      <span className="flex items-center gap-0.5 truncate">
                        <GitBranch size={9} /> {s.gitBranch}
                      </span>
                    )}
                    {s.worktree && <span className="rounded bg-violet-400/10 px-1 text-violet-300">worktree</span>}
                    <span className="ml-auto">{formatBytes(s.sizeBytes)}</span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className={clsx("min-h-0", !sessionId && "hidden lg:block")}>
        {sessionId ? (
          <SessionDetail projectId={projectId} sessionId={sessionId} />
        ) : (
          <Empty icon={<MessageSquareShare size={20} />} title="Pick a session">
            Read any past conversation, then resume it in the chat tab.
          </Empty>
        )}
      </div>
    </div>
  );
}

function SessionDetail({ projectId, sessionId }: { projectId: number; sessionId: string }) {
  const t = useQuery({ queryKey: ["session", projectId, sessionId], queryFn: () => api.session(projectId, sessionId) });
  const live = useChat(projectId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-6 py-3">
        <a href={href({ name: "project", id: projectId, tab: "history" })} className="text-slate-400 hover:text-white lg:hidden">
          <ArrowLeft size={16} />
        </a>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-white">{t.data?.title ?? "…"}</div>
          <div className="font-mono text-[10px] text-slate-500">{sessionId}</div>
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={!t.data || live.running}
          title={live.running ? "A chat is already running in this project" : "Continue this session in the chat tab"}
          onClick={() => {
            if (!t.data) return;
            chat.resume(projectId, sessionId, t.data.title, t.data.items);
            navigate({ name: "project", id: projectId, tab: "chat" });
          }}
        >
          <MessageSquareShare size={13} /> Resume
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl">
          {t.isLoading && <div className="text-sm text-slate-500">Loading transcript…</div>}
          {t.error && <ErrorNote>{t.error.message}</ErrorNote>}
          {t.data?.truncated && (
            <div className="mb-4 text-center font-mono text-[10px] uppercase tracking-wider text-slate-500">
              Long session: showing the most recent part
            </div>
          )}
          {t.data && <Transcript items={t.data.items} />}
        </div>
      </div>
    </div>
  );
}
