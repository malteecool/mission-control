import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, Camera, Circle, Download, Eraser, Play, Power, RotateCw, Smartphone, Square, SquareStack } from "lucide-react";
import { api, type EmulatorInfo } from "../lib/api.ts";
import { timeAgo } from "../lib/util.ts";
import { Button, Empty, ErrorNote, IconButton } from "./ui.tsx";

const MAX_LINES = 2000;
// Heartbeats come every 10s, as on the Dev tab.
const STALE_MS = 25_000;
const PICKED_KEY = "emulator-avd";

type Send = (msg: unknown) => void;

/**
 * The emulator's screen: frames from the WebSocket drawn on a canvas, pointer and keys sent back. `sendRef` gets the
 * function that sends input, for the toolbar's buttons.
 */
function Screen({ avd, sendRef }: { avd: string; sendRef: React.RefObject<Send | null> }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [frames, setFrames] = useState(false);
  const [error, setError] = useState<string>();

  const send: Send = (msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  sendRef.current = send;

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let image: ImageData | undefined;
    let stopped = false;
    const box = boxRef.current!;
    // Ask the emulator for frames that fit the panel at the screen's pixel density, so it does the scaling.
    const sendSize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (ws?.readyState === WebSocket.OPEN && box.clientWidth > 0)
        ws.send(JSON.stringify({ type: "size", width: Math.round(box.clientWidth * dpr), height: Math.round(box.clientHeight * dpr) }));
    };
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendSize, 150);
    });
    observer.observe(box);

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/emulator/${encodeURIComponent(avd)}/screen`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        setError(undefined);
        sendSize();
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          const msg = JSON.parse(e.data) as { error?: string };
          if (msg.error) setError(msg.error);
          return;
        }
        // [width u32][height u32][rotation u8][3 spare], then RGB.
        const view = new DataView(e.data as ArrayBuffer);
        const width = view.getUint32(0), height = view.getUint32(4);
        const rgb = new Uint8Array(e.data as ArrayBuffer, 12);
        const canvas = canvasRef.current;
        if (!canvas || !width || !height || rgb.length < width * height * 3) return;
        if (canvas.width !== width || canvas.height !== height || !image) {
          canvas.width = width;
          canvas.height = height;
          image = new ImageData(width, height);
        }
        const px = image.data;
        for (let i = 0, j = 0; i < width * height * 3; i += 3, j += 4) {
          px[j] = rgb[i];
          px[j + 1] = rgb[i + 1];
          px[j + 2] = rgb[i + 2];
          px[j + 3] = 255;
        }
        canvas.getContext("2d")!.putImageData(image, 0, 0);
        setFrames(true);
      };
      ws.onclose = () => {
        setConnected(false);
        if (wsRef.current === ws) wsRef.current = null;
        if (!stopped) retry = setTimeout(connect, 2000);
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(resizeTimer);
      observer.disconnect();
      ws?.close();
    };
  }, [avd]);

  // Mouse wheel scrolls (the server turns it into a short drag). Collected for a moment so one flick is one scroll.
  useEffect(() => {
    const canvas = canvasRef.current!;
    let pending = 0;
    let at = { x: 0.5, y: 0.5 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      at = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      pending += (e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY) / r.height;
      timer ??= setTimeout(() => {
        timer = undefined;
        send({ type: "wheel", ...at, dy: Math.max(-0.6, Math.min(0.6, pending)) });
        pending = 0;
      }, 80);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      clearTimeout(timer);
    };
  }, []);

  const touch = (e: React.PointerEvent<HTMLCanvasElement>, down: boolean) => {
    const r = e.currentTarget.getBoundingClientRect();
    send({ type: "touch", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, down });
  };

  const onKey = (e: React.KeyboardEvent, eventType: "keydown" | "keyup") => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Leave the dashboard's own shortcuts alone.
    e.preventDefault();
    if (e.key.length === 1) {
      if (eventType === "keydown") send({ type: "text", text: e.key });
    } else send({ type: "key", key: e.key, eventType });
  };

  return (
    <div ref={boxRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          touch(e, true);
        }}
        onPointerMove={(e) => e.buttons & 1 && touch(e, true)}
        onPointerUp={(e) => touch(e, false)}
        onPointerCancel={(e) => touch(e, false)}
        onKeyDown={(e) => onKey(e, "keydown")}
        onKeyUp={(e) => onKey(e, "keyup")}
        onContextMenu={(e) => e.preventDefault()}
        className={clsx(
          "max-h-full max-w-full touch-none rounded-2xl ring-1 ring-white/10 outline-none focus:ring-[var(--accent)]",
          !frames && "invisible",
        )}
        title="Click to tap, drag to swipe, scroll to scroll. Type while it's focused."
      />
      {!frames && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
          {error ?? (connected ? "Waiting for the first frame…" : "Connecting to the emulator…")}
        </div>
      )}
      {frames && error && (
        <div className="absolute inset-x-0 bottom-2 flex justify-center">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </div>
  );
}

/** The emulator's logcat, followed live; reconnects while the panel is open. */
function Logcat({ avd }: { avd: string }) {
  const [lines, setLines] = useState<Array<{ seq: number; text: string }>>([]);
  const [filter, setFilter] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let seq = 0;
    (async () => {
      while (!ctrl.signal.aborted) {
        const conn = new AbortController();
        const stop = () => conn.abort();
        ctrl.signal.addEventListener("abort", stop);
        let lastSeen = Date.now();
        const watchdog = setInterval(() => Date.now() - lastSeen > STALE_MS && conn.abort(), 5000);
        try {
          const res = await fetch(`/api/emulator/${encodeURIComponent(avd)}/logcat`, { signal: conn.signal });
          if (!res.ok || !res.body) throw new Error(`logcat failed (${res.status})`);
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let rest = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            lastSeen = Date.now();
            const parts = (rest + value).split("\n");
            rest = parts.pop() ?? "";
            const batch = parts.filter((p) => p.trim()).flatMap((p) => {
              const msg = JSON.parse(p) as { text?: string };
              return msg.text === undefined ? [] : [{ seq: seq++, text: msg.text }];
            });
            if (batch.length) setLines((prev) => [...prev, ...batch].slice(-MAX_LINES));
          }
        } catch {
          // Dropped, timed out or unmounted; the loop condition decides which.
        } finally {
          clearInterval(watchdog);
          ctrl.signal.removeEventListener("abort", stop);
        }
        if (!ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 3000));
      }
    })();
    return () => ctrl.abort();
  }, [avd]);

  const shown = filter ? lines.filter((l) => l.text.toLowerCase().includes(filter.toLowerCase())) : lines;

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-400">Logcat</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter (tag, package, text)…"
          className="h-7 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none"
        />
        <Button size="sm" onClick={() => setLines([])} title="Clear the log">
          <Eraser size={12} /> Clear
        </Button>
      </div>
      <div
        ref={logRef}
        onScroll={(e) => {
          // Only scrolling up stops following: layout shifts (fonts loading, scroll anchoring) also fire scroll events.
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) stick.current = true;
          else if (el.scrollTop < lastTop.current - 4) stick.current = false;
          lastTop.current = el.scrollTop;
        }}
        className="glass min-h-0 flex-1 overflow-auto rounded-2xl p-3 font-mono text-[11px] leading-relaxed"
      >
        {shown.length ? (
          shown.map((l) => (
            <div
              key={l.seq}
              className={clsx(
                "whitespace-pre-wrap break-all",
                // Threadtime format: "date time pid tid LEVEL tag: message".
                / [EF] /.test(l.text.slice(18, 34)) ? "text-rose-300" : / W /.test(l.text.slice(18, 34)) ? "text-amber-200" : "text-slate-300",
              )}
            >
              {l.text}
            </div>
          ))
        ) : (
          <div className="text-slate-600">{lines.length ? "Nothing matches the filter." : "Waiting for logcat…"}</div>
        )}
      </div>
    </div>
  );
}

function statePill(e: EmulatorInfo | undefined) {
  switch (e?.state) {
    case "running":
      return { label: "running", className: "bg-emerald-400/15 text-emerald-300" };
    case "starting":
    case "booting":
    case "stopping":
      return { label: e.state, className: "bg-amber-400/15 text-amber-200 animate-pulse" };
    case "crashed":
      return { label: "crashed", className: "bg-rose-500/15 text-rose-300" };
    default:
      return { label: "stopped", className: "bg-white/10 text-slate-400" };
  }
}

export function EmulatorPanel({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const overview = useQuery({
    queryKey: ["emulators"],
    queryFn: api.emulators,
    // Quicker while one is starting or stopping, so the screen appears soon after it boots.
    refetchInterval: (q) => (q.state.data?.avds.some((a) => ["starting", "booting", "stopping"].includes(a.state)) ? 1500 : 8000),
  });
  const project = useQuery({ queryKey: ["android", projectId], queryFn: () => api.androidProject(projectId), refetchInterval: 15_000 });
  const [picked, setPicked] = useState<string | undefined>(() => localStorage.getItem(PICKED_KEY) ?? undefined);
  const [apk, setApk] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const avds = overview.data?.avds ?? [];
  const current =
    avds.find((a) => a.avd === picked) ?? avds.find((a) => a.viewable) ?? avds.find((a) => a.state !== "stopped") ?? avds[0];
  const avd = current?.avd;
  // Stay on the device shown, even once it stops (the fallbacks above would otherwise jump to another one).
  useEffect(() => {
    if (avd && !picked) setPicked(avd);
  }, [avd, picked]);
  const live = current && current.state !== "stopped" && current.state !== "crashed";
  const apks = project.data?.apks ?? [];
  const chosenApk = apks.find((a) => a.path === apk) ?? apks[0];

  const refresh = () => qc.invalidateQueries({ queryKey: ["emulators"] });
  const start = useMutation({ mutationFn: (a: string) => api.startEmulator(a), onSettled: refresh });
  const stop = useMutation({ mutationFn: (a: string) => api.stopEmulator(a), onSettled: refresh });
  const rotate = useMutation({ mutationFn: (a: string) => api.rotateEmulator(a) });
  const install = useMutation({
    mutationFn: ({ a, path }: { a: string; path: string }) => api.installApk(projectId, a, path),
    onSuccess: (_, { path }) => setNotice(`Installed ${path.split("/").pop()}.`),
  });
  const error = start.error ?? stop.error ?? rotate.error ?? install.error;

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const pick = (a: string) => {
    setPicked(a);
    localStorage.setItem(PICKED_KEY, a);
  };
  const sendRef = useRef<Send | null>(null);
  const key = (k: string) => sendRef.current?.({ type: "key", key: k, eventType: "keypress" });

  if (overview.isError) return <div className="p-6"><ErrorNote>{overview.error.message}</ErrorNote></div>;
  if (!overview.data) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  if (overview.data.error)
    return (
      <Empty icon={<Smartphone size={20} />} title="No Android SDK found">
        {overview.data.error}
      </Empty>
    );
  if (!avds.length)
    return (
      <Empty icon={<Smartphone size={20} />} title="No virtual devices">
        Create one in Android Studio's Device Manager (or with <code className="font-mono text-slate-300">avdmanager</code>) and it
        shows up here.
      </Empty>
    );

  const pill = statePill(current);
  const stopping = stop.isPending || current?.state === "stopping";
  const busy = start.isPending || stopping;

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-7xl flex-col gap-3 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={avd}
          onChange={(e) => pick(e.target.value)}
          className="h-9 max-w-xs rounded-lg border border-white/10 bg-black/30 px-2 font-mono text-xs text-slate-200 focus:outline-none"
        >
          {avds.map((a) => (
            <option key={a.avd} value={a.avd} className="bg-slate-900">
              {a.avd.replace(/_/g, " ")}
              {a.state !== "stopped" ? ` · ${a.state}` : ""}
            </option>
          ))}
        </select>
        {live ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => avd && stop.mutate(avd)}
          >
            <Square size={12} /> {stopping ? "Stopping…" : "Stop"}
          </Button>
        ) : (
          <Button variant="primary" disabled={busy || !avd} onClick={() => avd && start.mutate(avd)}>
            <Play size={12} /> Start
          </Button>
        )}
        <span className={clsx("rounded-full px-2 py-0.5 font-mono text-[10px]", pill.className)}>{pill.label}</span>
        {current?.serial && <span className="font-mono text-[11px] text-slate-500">{current.serial}</span>}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {apks.length > 0 && (
            <>
              <select
                value={chosenApk?.path}
                onChange={(e) => setApk(e.target.value)}
                className="h-9 max-w-64 rounded-lg border border-white/10 bg-black/30 px-2 font-mono text-xs text-slate-200 focus:outline-none"
                title={chosenApk && `${chosenApk.path}, built ${timeAgo(chosenApk.modifiedAt)}`}
              >
                {apks.map((a) => (
                  <option key={a.path} value={a.path} className="bg-slate-900">
                    {a.path.replace(/^.*?build\/outputs\/apk\//, "")} · {timeAgo(a.modifiedAt)}
                  </option>
                ))}
              </select>
              <Button
                disabled={current?.state !== "running" || install.isPending || !chosenApk}
                onClick={() => avd && chosenApk && install.mutate({ a: avd, path: chosenApk.path })}
                title="adb install -r"
              >
                <Download size={12} /> {install.isPending ? "Installing…" : "Install APK"}
              </Button>
            </>
          )}
        </div>
      </div>
      {error && <ErrorNote>{error.message}</ErrorNote>}
      {notice && <div className="text-xs text-emerald-300">{notice}</div>}
      {current?.message && current.state !== "crashed" && <div className="text-xs text-slate-400">{current.message}</div>}

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-h-0 w-[min(46%,560px)] shrink-0 flex-col gap-2">
          {current?.viewable && avd ? (
            <>
              <Screen avd={avd} sendRef={sendRef} />
              <div className="flex items-center justify-center gap-1">
                <IconButton onClick={() => key("GoBack")} title="Back">
                  <ArrowLeft size={15} />
                </IconButton>
                <IconButton onClick={() => key("GoHome")} title="Home">
                  <Circle size={14} />
                </IconButton>
                <IconButton onClick={() => key("AppSwitch")} title="Recent apps">
                  <SquareStack size={14} />
                </IconButton>
                <span className="mx-2 h-4 w-px bg-white/10" />
                <IconButton onClick={() => rotate.mutate(avd)} title="Rotate">
                  <RotateCw size={14} />
                </IconButton>
                <IconButton onClick={() => key("Power")} title="Power (screen on/off)">
                  <Power size={14} />
                </IconButton>
                <a
                  href={api.emulatorScreenshotUrl(avd)}
                  download
                  title="Save a screenshot"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-white/10 hover:text-white"
                >
                  <Camera size={14} />
                </a>
              </div>
            </>
          ) : (
            <div className="glass flex flex-1 items-center justify-center rounded-2xl p-6 text-center text-sm text-slate-500">
              {current?.state === "crashed" ? (
                <div className="max-w-full text-left">
                  <div className="mb-2 text-rose-300">The emulator exited while starting:</div>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-slate-400">
                    {current.message}
                  </pre>
                </div>
              ) : current?.state === "starting" || current?.state === "booting" ? (
                "Starting the emulator… the screen shows here once it's up."
              ) : current?.state === "stopping" ? (
                "Shutting down (saving its snapshot)…"
              ) : current?.state === "running" ? (
                "This emulator's screen can't be shown here."
              ) : (
                "Start the emulator to see its screen here."
              )}
            </div>
          )}
        </div>
        {current?.viewable && avd ? (
          <Logcat avd={avd} />
        ) : (
          <div className="glass flex min-h-0 flex-1 items-center justify-center rounded-2xl text-sm text-slate-600">
            Logcat shows here while the emulator runs.
          </div>
        )}
      </div>
    </div>
  );
}
