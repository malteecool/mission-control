import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";
import { AlertTriangle, ChevronRight, Info, Sparkles, Terminal, User } from "lucide-react";
import type { ChatItem } from "../lib/api.ts";

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
});

type Tool = Extract<ChatItem, { kind: "tool" }>;

/** Groups consecutive tool calls so a long agentic run reads as one collapsible block. */
function group(items: ChatItem[]): Array<ChatItem | { kind: "tools"; id: string; tools: Tool[] }> {
  const out: Array<ChatItem | { kind: "tools"; id: string; tools: Tool[] }> = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === "tool") {
      if (last?.kind === "tools") last.tools.push(it);
      else out.push({ kind: "tools", id: `g-${it.id}`, tools: [it] });
    } else out.push(it);
  }
  return out;
}

export function Transcript({ items, draft, running }: { items: ChatItem[]; draft?: string; running?: boolean }) {
  const grouped = group(items);
  return (
    <div className="space-y-4">
      {grouped.map((it, i) => {
        const isLast = i === grouped.length - 1;
        switch (it.kind) {
          case "user":
            return (
              <div key={it.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-4 py-2.5">
                  <div className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-[var(--accent)]">
                    <User size={10} /> You
                  </div>
                  <div className="whitespace-pre-wrap break-words text-sm text-slate-100">{it.text}</div>
                </div>
              </div>
            );
          case "assistant":
            return (
              <div key={it.id} className="flex gap-3">
                <Avatar />
                <div className="min-w-0 flex-1 pt-0.5 text-slate-200">
                  <Markdown text={it.text} />
                </div>
              </div>
            );
          case "tools":
            return <ToolGroup key={it.id} tools={it.tools} live={!!running && isLast && !draft} />;
          case "system":
            return (
              <div key={it.id} className="flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
                <Info size={11} /> {it.text}
              </div>
            );
        }
      })}
      {draft ? (
        <div className="flex gap-3">
          <Avatar />
          <div className="caret min-w-0 flex-1 whitespace-pre-wrap pt-0.5 text-sm leading-relaxed text-slate-200">{draft}</div>
        </div>
      ) : (
        running &&
        grouped[grouped.length - 1]?.kind !== "tools" && (
          <div className="flex items-center gap-3">
            <Avatar />
            <div className="scanbar h-1 w-24 rounded-full bg-white/5" />
          </div>
        )
      )}
    </div>
  );
}

function Avatar() {
  return (
    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-violet-400/30 bg-violet-400/10 text-violet-300">
      <Sparkles size={12} />
    </div>
  );
}

function ToolGroup({ tools, live }: { tools: Tool[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const errors = tools.filter((t) => t.isError).length;
  const names = [...new Set(tools.map((t) => t.name))].slice(0, 4).join(", ");
  return (
    <div className="ml-9 rounded-xl border border-white/[0.07] bg-black/20">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <ChevronRight size={13} className={clsx("text-slate-500 transition", open && "rotate-90")} />
        <Terminal size={12} className="text-slate-400" />
        <span className="font-mono text-[11px] text-slate-400">
          {tools.length} tool call{tools.length === 1 ? "" : "s"} · {names}
        </span>
        {errors > 0 && <span className="font-mono text-[10px] text-rose-300">{errors} failed</span>}
        {live && <span className="scanbar ml-auto h-0.5 w-16 rounded-full bg-white/5" />}
      </button>
      {!open && (
        <div className="px-3 pb-2 pl-9 font-mono text-[11px] text-slate-500">
          <span className="text-slate-400">{tools[tools.length - 1].name}</span> {tools[tools.length - 1].summary}
        </div>
      )}
      {open && (
        <ul className="space-y-1 border-t border-white/[0.06] p-2">
          {tools.map((t) => (
            <ToolRow key={t.id} tool={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolRow({ tool: t }: { tool: Tool }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg bg-white/[0.02]">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left font-mono text-[11px]">
        {t.isError ? (
          <AlertTriangle size={11} className="shrink-0 text-rose-300" />
        ) : (
          <span className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", t.result === undefined ? "animate-pulse bg-amber-300" : "bg-emerald-400")} />
        )}
        <span className="shrink-0 text-[var(--accent)]">{t.name}</span>
        <span className="truncate text-slate-400">{t.summary}</span>
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2">
          <pre className="max-h-48 overflow-auto rounded-md bg-black/40 p-2 font-mono text-[11px] text-slate-400">
            {JSON.stringify(t.input, null, 2)}
          </pre>
          {t.result !== undefined && (
            <pre
              className={clsx(
                "max-h-64 overflow-auto whitespace-pre-wrap rounded-md p-2 font-mono text-[11px]",
                t.isError ? "bg-rose-500/10 text-rose-200" : "bg-black/40 text-slate-300",
              )}
            >
              {t.result || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}
