// Right-click menus in the app's own style. Any element opens one with `onContextMenu={menu(() => items)}`; a single
// host in App renders it. In the desktop app this replaces the browser's menu (desktop/src-tauri/src/init.js).
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";

export type MenuItem =
  | { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  /** A row of small toggle buttons, e.g. priorities; `active` marks the current one. */
  | { label: string; choices: Array<{ label: string; active?: boolean; color?: string; onSelect: () => void }> }
  | { heading: string }
  | "separator";

/** A tiny external store, so any component can open the menu or a toast without context plumbing. */
function store<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    set(next: T) {
      value = next;
      listeners.forEach((l) => l());
    },
    use() {
      return useSyncExternalStore(
        (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => value,
      );
    },
  };
}

const opened = store<{ x: number; y: number; items: MenuItem[] } | null>(null);
const toasts = store<{ id: number; text: string } | null>(null);

/** An onContextMenu handler that opens a menu; `items` runs at click time, so it sees current state. */
export function menu(items: () => Array<MenuItem | false | null | undefined>) {
  return (e: MouseEvent) => {
    // Leave the native menu for text you've selected or are editing (copy, paste).
    const t = e.target as Element;
    if (t.closest("input, textarea") || String(window.getSelection() ?? "").trim()) return;
    e.preventDefault();
    e.stopPropagation();
    const list = items().filter(Boolean) as MenuItem[];
    if (list.length) opened.set({ x: e.clientX, y: e.clientY, items: list });
  };
}

/** A one-line message, for menu actions that fail after the menu has closed (no editor on PATH, say). */
export const toast = (text: string) => toasts.set({ id: Date.now(), text });

/** Wraps a menu action so its error shows as a toast. */
export const attempt = (fn: () => Promise<unknown>) => () => void fn().catch((e: Error) => toast(e.message));

const actionable = (i: MenuItem): i is Extract<MenuItem, { onSelect: () => void }> =>
  typeof i === "object" && "onSelect" in i && !i.disabled;

export function ContextMenuHost() {
  return (
    <>
      <Menu />
      <Toast />
    </>
  );
}

function Menu() {
  const open = opened.use();
  const close = () => opened.set(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [active, setActive] = useState(-1);

  // Keep the menu on screen: flip left/up when it would run off the edge.
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    const pad = 8;
    setPos({
      left: open.x + width + pad > innerWidth ? Math.max(pad, open.x - width) : open.x,
      top: open.y + height + pad > innerHeight ? Math.max(pad, open.y - height) : open.y,
    });
    setActive(-1);
    ref.current.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close);
    };
  }, [open]);

  const items = open?.items ?? [];
  const select = (i: MenuItem) => {
    if (!actionable(i)) return;
    close();
    i.onSelect();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          role="menu"
          tabIndex={-1}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.08 } }}
          transition={{ duration: 0.1 }}
          style={{ left: pos.left, top: pos.top, transformOrigin: "top left" }}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            const steps = items.map((i, n) => (actionable(i) ? n : -1)).filter((n) => n >= 0);
            if (e.key === "Escape") close();
            else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && steps.length) {
              e.preventDefault();
              const at = steps.indexOf(active);
              const next =
                e.key === "ArrowDown" ? (at + 1) % steps.length : at <= 0 ? steps.length - 1 : at - 1;
              setActive(steps[next]);
            } else if (e.key === "Enter" && active >= 0) {
              e.preventDefault();
              select(items[active]);
            }
          }}
          className="fixed z-[100] min-w-[220px] max-w-[300px] rounded-xl border border-white/10 bg-[#0b1020]/95 p-1 text-sm shadow-[0_16px_48px_-12px_rgb(0_0_0/0.9)] backdrop-blur-xl focus:outline-none"
        >
          {items.map((item, n) =>
            item === "separator" ? (
              <div key={n} className="my-1 h-px bg-white/[0.07]" />
            ) : "heading" in item ? (
              <div key={n} className="hud-label truncate px-2.5 pb-1 pt-1.5">
                {item.heading}
              </div>
            ) : "choices" in item ? (
              <div key={n} className="flex items-center gap-1 px-2.5 py-1">
                <span className="flex-1 text-xs text-slate-400">{item.label}</span>
                {item.choices.map((c) => (
                  <button
                    key={c.label}
                    onClick={() => {
                      close();
                      c.onSelect();
                    }}
                    className={clsx(
                      "rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider transition",
                      c.active ? "bg-white/15 text-white" : "text-slate-400 hover:bg-white/10 hover:text-white",
                    )}
                    style={c.color ? { color: c.color } : undefined}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            ) : (
              <button
                key={n}
                role="menuitem"
                disabled={item.disabled}
                onClick={() => select(item)}
                onMouseEnter={() => setActive(n)}
                className={clsx(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition disabled:cursor-default disabled:opacity-35",
                  item.danger ? "text-rose-300" : "text-slate-200",
                  active === n && !item.disabled && (item.danger ? "bg-rose-500/15" : "bg-white/[0.08] text-white"),
                )}
              >
                <span className="flex w-4 shrink-0 justify-center opacity-70">{item.icon}</span>
                <span className="flex-1 truncate">{item.label}</span>
                {item.hint && <span className="font-mono text-[10px] text-slate-500">{item.hint}</span>}
              </button>
            ),
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Toast() {
  const t = toasts.use();
  const [visible, setVisible] = useState<typeof t>(null);
  useEffect(() => {
    if (!t) return;
    setVisible(t);
    const timer = setTimeout(() => setVisible(null), 4500);
    return () => clearTimeout(timer);
  }, [t]);
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key={visible.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          onClick={() => setVisible(null)}
          className="fixed bottom-5 left-1/2 z-[100] -translate-x-1/2 rounded-xl border border-rose-500/30 bg-[#140a12]/95 px-4 py-2 text-sm text-rose-200 shadow-2xl"
        >
          {visible.text}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
