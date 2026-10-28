import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, GitBranch, History, MessageSquareShare, Search, Sparkles, Terminal, User } from "lucide-react";
import { api, type SessionSearchHit, type SessionSummary } from "../lib/api.ts";
import { href, navigate } from "../lib/router.ts";
import { chat } from "../lib/chatStore.ts";
import { formatBytes, timeAgo } from "../lib/util.ts";
import { Button, Empty, ErrorNote } from "./ui.tsx";
import { Transcript } from "./Transcript.tsx";

export function HistoryPanel({ projectId, sessionId }: { projectId: number; sessionId?: string }) {
  const sessions = useQuery({ queryKey: ["sessions", projectId], queryFn: () => api.sessions(projectId) });
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  // Transcript item to scroll to after picking a search match.
  const [focus, setFocus] = useState<{ sessionId: string; itemId: string; n: number } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const searching = debounced.length >= 2;
  const search = useQuery({
    queryKey: ["session-search", projectId, debounced],
    queryFn: () => api.searchSessions(projectId, debounced),
    enabled: searching,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  const byId = useMemo(() => new Map((sessions.data ?? []).map((s) => [s.id, s])), [sessions.data]);
  const results = useMemo(
    () =>
      (search.data ?? []).flatMap((hit) => {
        const s = byId.get(hit.sessionId);
        return s ? [{ s, hit }] : [];
      }),
    [search.data, byId],
  );
  const list: Array<{ s: SessionSummary; hit?: SessionSearchHit }> = searching
    ? results
    : (sessions.data ?? []).map((s) => ({ s }));
  const terms = useMemo(() => debounced.toLowerCase().split(/\s+/).filter(Boolean), [debounced]);

  return (
    <div className="grid h-full min-h-0 lg:grid-cols-[360px_1fr]">
      <div className={clsx("flex min-h-0 flex-col border-white/[0.06] lg:border-r", sessionId && "hidden lg:flex")}>
        <div className="p-4 pb-2">
          <div className="accent-ring flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-3">
            <Search size={13} className="text-slate-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search everything said in past sessions…"
              className="flex-1 bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none"
            />
            {searching && search.isFetching && <span className="scanbar h-0.5 w-10 rounded-full bg-white/5" />}
          </div>
          {searching && search.data && !search.isPlaceholderData && (
            <div className="mt-2 px-1 font-mono text-[10px] uppercase tracking-wider text-slate-500">
              {results.length === 0
                ? "No matches"
                : `${results.length}${search.data.length >= 50 ? "+" : ""} session${results.length === 1 ? "" : "s"}`}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {sessions.isLoading && <div className="p-4 text-sm text-slate-500">Reading Claude history…</div>}
          {sessions.error && <ErrorNote>{sessions.error.message}</ErrorNote>}
          {sessions.data?.length === 0 && (
            <Empty icon={<History size={20} />} title="No sessions yet">
              Chats you have with Claude Code in this folder, from here, the terminal or the desktop app, show up here.
            </Empty>
          )}
          {searching && search.error && <ErrorNote>{search.error.message}</ErrorNote>}
          {searching && search.isLoading && <div className="p-4 text-sm text-slate-500">Searching every transcript…</div>}
          <ul className="space-y-1">
            {list.map(({ s, hit }) => (
              <li key={s.id}>
                <SessionRow
                  projectId={projectId}
                  s={s}
                  hit={hit}
                  terms={terms}
                  active={s.id === sessionId}
                  onPick={(itemId) => setFocus((f) => ({ sessionId: s.id, itemId, n: (f?.n ?? 0) + 1 }))}
                />
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className={clsx("min-h-0", !sessionId && "hidden lg:block")}>
        {sessionId ? (
          <SessionDetail
            projectId={projectId}
            sessionId={sessionId}
            focus={focus?.sessionId === sessionId ? focus : undefined}
          />
        ) : (
          <Empty icon={<MessageSquareShare size={20} />} title="Pick a session">
            Read any past conversation, then resume it in the chat tab.
          </Empty>
        )}
      </div>
    </div>
  );
}

const KIND_ICON = { user: User, assistant: Sparkles, tool: Terminal };

function SessionRow({
  projectId,
  s,
  hit,
  terms,
  active,
  onPick,
}: {
  projectId: number;
  s: SessionSummary;
  hit?: SessionSearchHit;
  terms: string[];
  active: boolean;
  onPick: (itemId: string) => void;
}) {
  const link = href({ name: "project", id: projectId, tab: "history", sessionId: s.id });
  return (
    <div
      className={clsx(
        "rounded-xl border transition",
        active
          ? "border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
          : "border-transparent hover:bg-white/[0.04]",
      )}
    >
      <a href={link} onClick={() => hit?.matches[0] && onPick(hit.matches[0].itemId)} className="block px-3 py-2.5">
        <div className="truncate text-sm text-slate-100">{s.title}</div>
        {!hit && s.lastPrompt && s.lastPrompt !== s.firstPrompt && (
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
          <span className="ml-auto">{hit ? `${hit.hits} match${hit.hits === 1 ? "" : "es"}` : formatBytes(s.sizeBytes)}</span>
        </div>
      </a>
      {hit && (
        <ul className="space-y-0.5 px-1.5 pb-1.5">
          {hit.matches.map((m) => {
            const Icon = KIND_ICON[m.kind];
            return (
              <li key={m.itemId}>
                <a
                  href={link}
                  onClick={() => onPick(m.itemId)}
                  className="flex gap-2 rounded-lg px-1.5 py-1 text-xs leading-snug text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"
                >
                  <Icon size={11} className="mt-0.5 shrink-0 text-slate-500" />
                  <span className={clsx("line-clamp-2 break-words", m.kind === "tool" && "font-mono text-[11px]")}>
                    <Highlight text={m.text} terms={terms} />
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-sm bg-[color-mix(in_srgb,var(--accent)_25%,transparent)] px-0.5 text-white">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function SessionDetail({
  projectId,
  sessionId,
  focus,
}: {
  projectId: number;
  sessionId: string;
  focus?: { itemId: string; n: number };
}) {
  const t = useQuery({ queryKey: ["session", projectId, sessionId], queryFn: () => api.session(projectId, sessionId) });

  useEffect(() => {
    if (!focus || !t.data) return;
    const el = document.querySelector(`[data-items~="${CSS.escape(focus.itemId)}"]`);
    if (!el) return; // older than the part of a long session that's shown
    el.scrollIntoView({ block: "center" });
    el.classList.add("search-focus");
    const timer = setTimeout(() => el.classList.remove("search-focus"), 2000);
    return () => {
      clearTimeout(timer);
      el.classList.remove("search-focus");
    };
  }, [focus?.itemId, focus?.n, t.data]);

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
          disabled={!t.data}
          title="Continue this session in the chat tab"
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
