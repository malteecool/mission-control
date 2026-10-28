import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ExternalLink, Eraser, Play, RotateCw, Square, TerminalSquare } from "lucide-react";
import { api, type DevLogLine, type DevServerStatus } from "../lib/api.ts";
import { timeAgo } from "../lib/util.ts";
import { Button, Empty, ErrorNote } from "./ui.tsx";

// The server sends a heartbeat every 10s; see STALE_MS in lib/taskWatch.ts.
const STALE_MS = 25_000;
const MAX_LINES = 2000;

/** Follows the dev server's status and output. The server replays its kept output on every (re)connect. */
function useDevLogs(projectId: number) {
  const qc = useQueryClient();
  const [lines, setLines] = useState<DevLogLine[]>([]);
  const [status, setStatus] = useState<DevServerStatus>();

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      let delay = 1000;
      while (!ctrl.signal.aborted) {
        const conn = new AbortController();
        const stop = () => conn.abort();
        ctrl.signal.addEventListener("abort", stop);
        let lastSeen = Date.now();
        const watchdog = setInterval(() => Date.now() - lastSeen > STALE_MS && conn.abort(), 5000);
        try {
          const res = await fetch(`/api/projects/${projectId}/dev/logs`, { signal: conn.signal });
          if (!res.ok || !res.body) throw new Error(`dev logs failed (${res.status})`);
          setLines([]);
          delay = 1000;
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let rest = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            lastSeen = Date.now();
            const parts = (rest + value).split("\n");
            rest = parts.pop() ?? "";
            const batch: DevLogLine[] = [];
            for (const part of parts) {
              if (!part.trim()) continue;
              const msg = JSON.parse(part) as { type: "status"; status: DevServerStatus } | { type: "log"; line: DevLogLine };
              if (msg.type === "log") batch.push(msg.line);
              else {
                setStatus(msg.status);
                qc.invalidateQueries({ queryKey: ["dev", projectId] });
                qc.invalidateQueries({ queryKey: ["dev-servers"] });
              }
            }
            if (batch.length) setLines((prev) => [...prev, ...batch].slice(-MAX_LINES));
          }
        } catch {
          // Dropped, timed out or unmounted; the loop condition decides which.
        } finally {
          clearInterval(watchdog);
          ctrl.signal.removeEventListener("abort", stop);
        }
        if (ctrl.signal.aborted) return;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    })();
    return () => ctrl.abort();
  }, [projectId, qc]);

  return { lines, status, clear: () => setLines([]) };
}

export function DevPanel({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["dev", projectId], queryFn: () => api.devServer(projectId) });
  const { lines, status: liveStatus, clear } = useDevLogs(projectId);
  const [picked, setPicked] = useState<string>();
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const status = liveStatus ?? info.data;
  const running = status?.status === "running";
  const scripts = info.data?.scripts ?? [];
  const script = picked ?? status?.script ?? scripts[0]?.name;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dev", projectId] });
    qc.invalidateQueries({ queryKey: ["dev-servers"] });
  };
  const start = useMutation({ mutationFn: (s: string) => api.startDevServer(projectId, s), onSettled: refresh });
  const stop = useMutation({ mutationFn: () => api.stopDevServer(projectId), onSettled: refresh });
  const open = useMutation({ mutationFn: () => api.openDevPreview(projectId) });
  const restart = useMutation({
    mutationFn: async (s: string) => {
      await api.stopDevServer(projectId);
      // Wait for the old process to exit (and free its port) before starting again.
      for (let i = 0; i < 50; i++) {
        if ((await api.devServer(projectId)).status !== "running") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      return api.startDevServer(projectId, s);
    },
    onSettled: refresh,
  });
  const error = start.error ?? stop.error ?? open.error ?? restart.error;
  const busy = start.isPending || stop.isPending || restart.isPending;

  // Keep following new output unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (info.isError) return <div className="p-6"><ErrorNote>{info.error.message}</ErrorNote></div>;
  if (!info.data) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  if (!scripts.length && !running)
    return (
      <Empty icon={<TerminalSquare size={20} />} title="No scripts to run">
        This project has no package.json with scripts. Add a <code className="font-mono text-slate-300">dev</code> script to
        start it from here.
      </Empty>
    );

  const pill =
    status?.status === "running"
      ? { label: "running", className: "bg-emerald-400/15 text-emerald-300" }
      : status?.status === "crashed"
        ? { label: `crashed${status.exitCode !== undefined ? ` · code ${status.exitCode}` : ""}`, className: "bg-rose-500/15 text-rose-300" }
        : { label: "stopped", className: "bg-white/10 text-slate-400" };

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-6xl flex-col gap-3 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={script}
          disabled={running}
          onChange={(e) => setPicked(e.target.value)}
          className="h-9 max-w-xs rounded-lg border border-white/10 bg-black/30 px-2 font-mono text-xs text-slate-200 focus:outline-none disabled:opacity-60"
          title={scripts.find((s) => s.name === script)?.command}
        >
          {scripts.map((s) => (
            <option key={s.name} value={s.name} className="bg-slate-900">
              {info.data.packageManager} run {s.name}
            </option>
          ))}
        </select>
        {running ? (
          <>
            <Button variant="danger" onClick={() => stop.mutate()} disabled={busy}>
              <Square size={12} /> Stop
            </Button>
            <Button onClick={() => script && restart.mutate(status?.script ?? script)} disabled={busy} title="Stop, then start again">
              <RotateCw size={12} /> Restart
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => script && start.mutate(script)} disabled={busy || !script}>
            <Play size={12} /> Start
          </Button>
        )}
        <span className={clsx("rounded-full px-2 py-0.5 font-mono text-[10px]", pill.className, running && "animate-pulse")}>
          {pill.label}
        </span>
        {status?.startedAt && (
          <span className="font-mono text-[11px] text-slate-500">
            {running ? `started ${timeAgo(status.startedAt)}` : status.finishedAt ? `ended ${timeAgo(status.finishedAt)}` : ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {running && status?.url && (
            <Button variant="primary" onClick={() => open.mutate()} title={`Open ${status.url} in your browser`}>
              <ExternalLink size={12} /> Open preview
              <span className="font-mono text-[10px] opacity-70">{status.url.replace(/^https?:\/\//, "")}</span>
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => {
              api.clearDevLogs(projectId).catch(() => {});
              clear();
            }}
            title="Clear the log"
          >
            <Eraser size={12} /> Clear
          </Button>
        </div>
      </div>
      {running && !status?.url && (
        <div className="text-xs text-slate-500">Waiting for the dev server to print a local URL for the preview link…</div>
      )}
      {error && <ErrorNote>{error.message}</ErrorNote>}

      <div
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="glass min-h-0 flex-1 overflow-auto rounded-2xl p-4 font-mono text-[12px] leading-relaxed"
      >
        {lines.length ? (
          lines.map((l) => (
            <div
              key={l.seq}
              className={clsx(
                "whitespace-pre-wrap break-all",
                l.stream === "stderr" && "text-rose-300",
                l.stream === "system" && "text-[var(--accent)]",
                l.stream === "stdout" && "text-slate-300",
              )}
            >
              {l.text || " "}
            </div>
          ))
        ) : (
          <div className="text-slate-600">{running ? "No output yet." : "Start the dev server to see its output here."}</div>
        )}
      </div>
    </div>
  );
}
