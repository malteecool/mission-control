import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { CheckSquare, FolderPlus, History, LayoutGrid, MessageSquare, Plus, Search, Settings2 } from "lucide-react";
import type { ProjectSummary } from "../lib/api.ts";
import { navigate, type Route } from "../lib/router.ts";
import { chat } from "../lib/chatStore.ts";
import { fuzzyScore } from "../lib/util.ts";
import { Dot, Kbd, Modal } from "./ui.tsx";

interface Item {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  projects,
  route,
  onAddProject,
}: {
  open: boolean;
  onClose: () => void;
  projects: ProjectSummary[];
  route: Route;
  onAddProject: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [];
    if (route.name === "project") {
      const id = route.id;
      all.push(
        { id: "tab-tasks", group: "This project", label: "Tasks", icon: <CheckSquare size={14} />, run: () => navigate({ name: "project", id, tab: "tasks" }) },
        { id: "tab-chat", group: "This project", label: "Chat with Claude", icon: <MessageSquare size={14} />, run: () => navigate({ name: "project", id, tab: "chat" }) },
        {
          id: "new-chat",
          group: "This project",
          label: "New chat session",
          icon: <Plus size={14} />,
          run: () => {
            chat.newSession(id);
            navigate({ name: "project", id, tab: "chat" });
          },
        },
        { id: "tab-history", group: "This project", label: "Chat history", icon: <History size={14} />, run: () => navigate({ name: "project", id, tab: "history" }) },
      );
    }
    for (const p of projects) {
      all.push({
        id: `p-${p.id}`,
        group: "Projects",
        label: p.name,
        hint: `${p.counts.todo + p.counts.doing} open`,
        icon: <Dot color={p.color} />,
        run: () => navigate({ name: "project", id: p.id, tab: route.name === "project" ? route.tab : "tasks" }),
      });
    }
    all.push(
      { id: "overview", group: "General", label: "Overview", icon: <LayoutGrid size={14} />, run: () => navigate({ name: "overview" }) },
      { id: "add", group: "General", label: "Add project…", icon: <FolderPlus size={14} />, run: onAddProject },
      { id: "settings", group: "General", label: "Settings", icon: <Settings2 size={14} />, run: () => navigate({ name: "settings" }) },
    );
    if (!query) return all;
    return all
      .map((it) => ({ it, s: fuzzyScore(query, `${it.label} ${it.group}`) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it);
  }, [projects, route, query, onAddProject]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (it?: Item) => {
    if (!it) return;
    onClose();
    it.run();
  };

  let lastGroup = "";
  return (
    <Modal open={open} onClose={onClose} className="max-w-lg overflow-hidden">
      <div className="flex items-center gap-3 border-b border-white/10 px-4">
        <Search size={15} className="text-slate-500" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(items[index]);
            }
          }}
          placeholder="Jump to a project or action…"
          className="h-12 flex-1 bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none"
        />
        <Kbd>Esc</Kbd>
      </div>
      <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2">
        {items.length === 0 && <div className="px-3 py-6 text-center text-sm text-slate-500">No matches</div>}
        {items.map((it, i) => {
          const header = !query && it.group !== lastGroup ? it.group : null;
          lastGroup = it.group;
          return (
            <div key={it.id}>
              {header && <div className="hud-label px-3 pb-1 pt-3">{header}</div>}
              <button
                data-index={i}
                onMouseMove={() => setIndex(i)}
                onClick={() => choose(it)}
                className={clsx(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm",
                  i === index ? "bg-cyan-400/10 text-white" : "text-slate-300",
                )}
              >
                <span className="flex w-4 justify-center text-slate-400">{it.icon}</span>
                <span className="flex-1 truncate">{it.label}</span>
                {it.hint && <span className="font-mono text-[10px] text-slate-500">{it.hint}</span>}
              </button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
