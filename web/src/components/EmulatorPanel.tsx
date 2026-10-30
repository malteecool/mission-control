import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ArrowLeft,
  Camera,
  Circle,
  Download,
  Eraser,
  Hammer,
  Play,
  Power,
  RotateCw,
  Smartphone,
  Square,
  SquareStack,
  Unplug,
  Usb,
  Wifi,
  X,
} from "lucide-react";
import { api, type AndroidRunEvent, type DeviceInfo, type EmulatorInfo } from "../lib/api.ts";
import { timeAgo } from "../lib/util.ts";
import { h264Player } from "../lib/h264.ts";
import { Button, Empty, ErrorNote, IconButton } from "./ui.tsx";

const MAX_LINES = 2000;
// Heartbeats come every 10s, as on the Dev tab.
const STALE_MS = 25_000;
const PICKED_KEY = "emulator-avd";
/** Prefix of a picked physical device in PICKED_KEY (AVD names can't contain a colon). */
const DEVICE_KEY = "device:";

type Send = (msg: unknown) => void;

/**
 * Where a screen comes from: an emulator's gRPC API (raw RGB frames), or scrcpy over adb (H.264) for physical devices
 * and for emulators the dashboard can't reach through gRPC.
 */
type Source = { kind: "emulator"; avd: string } | { kind: "device"; serial: string };

const sourceBase = (s: Source) =>
  s.kind === "emulator" ? `/api/emulator/${encodeURIComponent(s.avd)}` : `/api/devices/${encodeURIComponent(s.serial)}`;

/**
 * A device's screen: frames from the WebSocket drawn on a canvas, pointer and keys sent back. `sendRef` gets the
 * function that sends input, for the toolbar's buttons. Remount it (`key`) when the source changes.
 */
function Screen({ source, sendRef }: { source: Source; sendRef: React.RefObject<Send | null> }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [frames, setFrames] = useState(false);
  const [error, setError] = useState<string>();
  const scrcpy = source.kind === "device";

  const send: Send = (msg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  sendRef.current = send;

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let image: ImageData | undefined;
    let player: ReturnType<typeof h264Player> | undefined;
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

    const drawRgb = (data: ArrayBuffer) => {
      // [width u32][height u32][rotation u8][3 spare], then RGB.
      const view = new DataView(data);
      const width = view.getUint32(0), height = view.getUint32(4);
      const rgb = new Uint8Array(data, 12);
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

    const drawFrame = (frame: VideoFrame) => {
      const canvas = canvasRef.current;
      if (canvas) {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        canvas.getContext("2d")!.drawImage(frame, 0, 0);
        setFrames(true);
      }
      frame.close();
    };

    const connect = () => {
      if (scrcpy && typeof VideoDecoder === "undefined") {
        setError("This browser can't decode the device's video (it has no WebCodecs).");
        return;
      }
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${proto}://${location.host}${sourceBase(source)}/screen`);
      ws = socket;
      socket.binaryType = "arraybuffer";
      wsRef.current = socket;
      if (scrcpy) {
        player?.close();
        player = h264Player(drawFrame, (message) => {
          setError(message);
          // The device restarts its encoder, sending a new config and key frame.
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "reset" }));
        });
      }
      socket.onopen = () => {
        setConnected(true);
        setError(undefined);
        sendSize();
      };
      socket.onmessage = (e) => {
        if (typeof e.data === "string") {
          const msg = JSON.parse(e.data) as { error?: string; type?: string };
          if (msg.error) setError(msg.error);
          return;
        }
        if (player) player.packet(e.data as ArrayBuffer);
        else drawRgb(e.data as ArrayBuffer);
      };
      socket.onclose = () => {
        setConnected(false);
        if (wsRef.current === socket) wsRef.current = null;
        // scrcpy starts its server on the device again each time, so leave it a little longer.
        if (!stopped) retry = setTimeout(connect, scrcpy ? 3000 : 2000);
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(resizeTimer);
      observer.disconnect();
      ws?.close();
      player?.close();
    };
    // Remounted when the source changes.
  }, []);

  // Mouse wheel scrolls (for the emulator, the server turns it into a short drag). Collected for a moment so one flick is one scroll.
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
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm whitespace-pre-line text-slate-500">
          {error ??
            (!connected
              ? scrcpy
                ? "Connecting to the device…"
                : "Connecting to the emulator…"
              : scrcpy
                ? "Starting scrcpy on the device…"
                : "Waiting for the first frame…")}
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

/** The device's logcat, followed live; reconnects while the panel is open. */
function Logcat({ url }: { url: string }) {
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
          const res = await fetch(url, { signal: conn.signal });
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
  }, [url]);

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

type BuildLine = { seq: number; text: string; stream: "stdout" | "stderr" | "system" };
type Build = { lines: BuildLine[]; state: "running" | "done" | "failed" | "stopped"; message?: string };

/** Gradle's output for a build & run, then adb's, followed while it comes. */
function BuildLog({ build, onClose }: { build: Build; onClose: () => void }) {
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [build.lines]);

  const pill = {
    running: { label: "building…", className: "bg-amber-400/15 text-amber-200 animate-pulse" },
    done: { label: "launched", className: "bg-emerald-400/15 text-emerald-300" },
    failed: { label: "failed", className: "bg-rose-500/15 text-rose-300" },
    stopped: { label: "stopped", className: "bg-white/10 text-slate-400" },
  }[build.state];
  return (
    <div className="flex h-[45%] min-h-32 shrink-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-400">Build</span>
        <span className={clsx("rounded-full px-2 py-0.5 font-mono text-[10px]", pill.className)}>{pill.label}</span>
        {build.message && <span className="min-w-0 truncate text-xs text-slate-400">{build.message}</span>}
        {build.state !== "running" && (
          <IconButton onClick={onClose} title="Close the build output" className="ml-auto">
            <X size={14} />
          </IconButton>
        )}
      </div>
      <div
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="glass min-h-0 flex-1 overflow-auto rounded-2xl p-3 font-mono text-[11px] leading-relaxed"
      >
        {build.lines.map((l) => (
          <div
            key={l.seq}
            className={clsx(
              "whitespace-pre-wrap break-all",
              l.stream === "system"
                ? "text-sky-300"
                : /^e: |error:|^FAILURE|FAILED|^\* What went wrong/.test(l.text)
                  ? "text-rose-300"
                  : /^w: |warning:/i.test(l.text)
                    ? "text-amber-200"
                    : "text-slate-300",
            )}
          >
            {l.text}
          </div>
        ))}
        {!build.lines.length && <div className="text-slate-600">Starting Gradle…</div>}
      </div>
    </div>
  );
}

/** `adb connect`, or `adb pair` when a pairing code is given (Android 11+'s Wireless debugging). */
function ConnectForm({ onConnected }: { onConnected: (output: string) => void }) {
  const qc = useQueryClient();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const pairing = code.trim() !== "";
  const connect = useMutation({
    mutationFn: () => api.connectDevice(address.trim(), code.trim() || undefined),
    onSuccess: (res) => {
      onConnected(res.output);
      setCode("");
      qc.invalidateQueries({ queryKey: ["devices"] });
    },
  });
  const input = "h-9 rounded-lg border border-white/10 bg-black/30 px-2 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none";
  return (
    <div className="flex flex-col gap-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          connect.mutate();
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.20:5555" className={clsx(input, "w-48")} />
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          placeholder="Pairing code (optional)"
          inputMode="numeric"
          maxLength={6}
          className={clsx(input, "w-44")}
        />
        <Button type="submit" variant="primary" disabled={!address.trim() || connect.isPending}>
          <Wifi size={12} /> {connect.isPending ? (pairing ? "Pairing…" : "Connecting…") : pairing ? "Pair" : "Connect"}
        </Button>
      </form>
      <div className="text-xs text-slate-500">
        On the device, turn on Developer options › Wireless debugging. New devices: tap “Pair device with pairing code”
        and pair using that address and code, then connect to the address shown on the Wireless debugging screen. Older
        devices: run <code className="font-mono text-slate-400">adb tcpip 5555</code> over USB, then connect to the device's
        IP on port 5555.
      </div>
      {connect.error && <ErrorNote>{connect.error.message}</ErrorNote>}
    </div>
  );
}

type Target = { key: string; kind: "emulator"; info: EmulatorInfo } | { key: string; kind: "device"; info: DeviceInfo };

/** An emulator the dashboard can't show through gRPC, but can through scrcpy. */
const mirrored = (e: EmulatorInfo) => e.state === "running" && !e.viewable && !!e.serial;

/** What shows the target's screen, if it can be shown now. */
function sourceOf(t: Target | undefined): Source | undefined {
  if (!t) return undefined;
  if (t.kind === "device") return t.info.ready ? { kind: "device", serial: t.info.serial } : undefined;
  if (t.info.viewable) return { kind: "emulator", avd: t.info.avd };
  return mirrored(t.info) ? { kind: "device", serial: t.info.serial! } : undefined;
}

function statePill(t: Target | undefined) {
  if (t?.kind === "device") {
    return t.info.ready
      ? { label: "connected", className: "bg-emerald-400/15 text-emerald-300" }
      : { label: t.info.state, className: "bg-amber-400/15 text-amber-200" };
  }
  const e = t?.info;
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
  // Often enough that a device shows up soon after it's plugged in (or its USB debugging prompt is accepted).
  const devices = useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: 4000 });
  const project = useQuery({ queryKey: ["android", projectId], queryFn: () => api.androidProject(projectId), refetchInterval: 15_000 });
  const [picked, setPicked] = useState<string | undefined>(() => localStorage.getItem(PICKED_KEY) ?? undefined);
  const [apk, setApk] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [wifiOpen, setWifiOpen] = useState(false);
  const [build, setBuild] = useState<Build>();
  const buildCtrl = useRef<AbortController | null>(null);
  // Leaving the tab stops a build that's going.
  useEffect(() => () => buildCtrl.current?.abort(), []);

  const avds = overview.data?.avds ?? [];
  const physical = devices.data?.devices ?? [];
  const targets: Target[] = [
    ...avds.map((a): Target => ({ key: a.avd, kind: "emulator", info: a })),
    ...physical.map((d): Target => ({ key: DEVICE_KEY + d.serial, kind: "device", info: d })),
  ];
  const current =
    targets.find((t) => t.key === picked) ??
    targets.find((t) => sourceOf(t)) ??
    targets.find((t) => t.kind === "emulator" && t.info.state !== "stopped") ??
    targets[0];
  const currentKey = current?.key;
  // Stay on the device shown, even once it stops (the fallbacks above would otherwise jump to another one).
  useEffect(() => {
    if (currentKey && !picked) setPicked(currentKey);
  }, [currentKey, picked]);
  const source = sourceOf(current);
  const emulator = current?.kind === "emulator" ? current.info : undefined;
  const device = current?.kind === "device" ? current.info : undefined;
  const avd = emulator?.avd;
  const live = emulator && emulator.state !== "stopped" && emulator.state !== "crashed";
  const canInstall = emulator?.state === "running" || !!device?.ready;
  const apks = project.data?.apks ?? [];
  const chosenApk = apks.find((a) => a.path === apk) ?? apks[0];

  const refresh = () => qc.invalidateQueries({ queryKey: ["emulators"] });
  const start = useMutation({ mutationFn: (a: string) => api.startEmulator(a), onSettled: refresh });
  const stop = useMutation({ mutationFn: (a: string) => api.stopEmulator(a), onSettled: refresh });
  const rotate = useMutation({ mutationFn: (a: string) => api.rotateEmulator(a) });
  const disconnect = useMutation({
    mutationFn: (serial: string) => api.disconnectDevice(serial),
    onSettled: () => qc.invalidateQueries({ queryKey: ["devices"] }),
  });
  const install = useMutation({
    mutationFn: ({ target, path }: { target: { avd: string } | { serial: string }; path: string }) => api.installApk(projectId, target, path),
    onSuccess: (_, { path }) => setNotice(`Installed ${path.split("/").pop()}.`),
  });
  const error = start.error ?? stop.error ?? rotate.error ?? install.error ?? disconnect.error;

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const buildAndRun = async (target: { avd: string } | { serial: string }) => {
    const ctrl = new AbortController();
    buildCtrl.current = ctrl;
    let seq = 0;
    let pending: BuildLine[] = [];
    let result: Pick<Build, "state" | "message"> | undefined;
    setBuild({ lines: [], state: "running" });
    // Gradle can print hundreds of lines a second; render them a frame at a time.
    const flush = () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      setBuild((b) => b && { ...b, lines: [...b.lines, ...batch].slice(-MAX_LINES) });
    };
    const timer = setInterval(flush, 100);
    try {
      await api.buildAndRun(projectId, target, ctrl.signal, (ev: AndroidRunEvent) => {
        if ("text" in ev) pending.push({ seq: seq++, text: ev.text, stream: ev.stream });
        else if ("done" in ev) result = { state: "done", message: `Launched ${ev.package}` };
        else result = { state: "failed", message: ev.error };
      });
      result ??= { state: "failed", message: "The build stopped without finishing" };
    } catch (e) {
      result = ctrl.signal.aborted ? { state: "stopped", message: "Stopped" } : { state: "failed", message: (e as Error).message };
    } finally {
      clearInterval(timer);
      flush();
      if (buildCtrl.current === ctrl) buildCtrl.current = null;
      setBuild((b) => b && { ...b, ...result });
      qc.invalidateQueries({ queryKey: ["android", projectId] });
    }
  };

  const pick = (key: string) => {
    setPicked(key);
    localStorage.setItem(PICKED_KEY, key);
  };
  const sendRef = useRef<Send | null>(null);
  const key = (k: string) => sendRef.current?.({ type: "key", key: k, eventType: "keypress" });
  const onConnected = (output: string) => {
    setNotice(output);
    setWifiOpen(false);
  };

  if (overview.isError && devices.isError) return <div className="p-6"><ErrorNote>{overview.error.message}</ErrorNote></div>;
  if (overview.isPending || devices.isPending) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  if (!targets.length)
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 p-6">
        <Empty icon={<Smartphone size={20} />} title="No Android devices">
          {overview.data?.error ?? (
            <>
              Create a virtual device in Android Studio's Device Manager (or with{" "}
              <code className="font-mono text-slate-300">avdmanager</code>) and it shows up here.
            </>
          )}{" "}
          {devices.data?.error ?? "Or plug in a phone with USB debugging on, or connect one over Wi-Fi:"}
        </Empty>
        {!devices.data?.error && <ConnectForm onConnected={onConnected} />}
        {notice && <div className="text-xs text-emerald-300">{notice}</div>}
      </div>
    );

  const pill = statePill(current);
  const stopping = stop.isPending || emulator?.state === "stopping";
  const busy = start.isPending || stopping;
  const message = emulator ? (emulator.state !== "crashed" ? emulator.message : undefined) : device?.message;
  const installTarget = emulator ? { avd: emulator.avd } : device ? { serial: device.serial } : undefined;
  const serial = emulator?.serial ?? device?.serial;

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-7xl flex-col gap-3 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={currentKey}
          onChange={(e) => pick(e.target.value)}
          className="h-9 max-w-xs rounded-lg border border-white/10 bg-black/30 px-2 font-mono text-xs text-slate-200 focus:outline-none"
        >
          {avds.length > 0 && (
            <optgroup label="Virtual devices" className="bg-slate-900">
              {avds.map((a) => (
                <option key={a.avd} value={a.avd} className="bg-slate-900">
                  {a.avd.replace(/_/g, " ")}
                  {a.state !== "stopped" ? ` · ${a.state}` : ""}
                </option>
              ))}
            </optgroup>
          )}
          {physical.length > 0 && (
            <optgroup label="Physical devices" className="bg-slate-900">
              {physical.map((d) => (
                <option key={d.serial} value={DEVICE_KEY + d.serial} className="bg-slate-900">
                  {d.name} · {d.transport === "wifi" ? "Wi-Fi" : "USB"}
                  {d.ready ? "" : ` · ${d.state}`}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {emulator &&
          (live ? (
            <Button variant="danger" disabled={busy} onClick={() => avd && stop.mutate(avd)}>
              <Square size={12} /> {stopping ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || !avd} onClick={() => avd && start.mutate(avd)}>
              <Play size={12} /> Start
            </Button>
          ))}
        {device?.transport === "wifi" && (
          <Button disabled={disconnect.isPending} onClick={() => disconnect.mutate(device.serial)} title="adb disconnect">
            <Unplug size={12} /> Disconnect
          </Button>
        )}
        <span className={clsx("rounded-full px-2 py-0.5 font-mono text-[10px]", pill.className)}>{pill.label}</span>
        {serial && (
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-slate-500">
            {device && (device.transport === "wifi" ? <Wifi size={11} /> : <Usb size={11} />)}
            {serial}
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button onClick={() => setWifiOpen((o) => !o)} title="Connect a device over Wi-Fi (adb connect / adb pair)">
            <Wifi size={12} /> Wi-Fi…
          </Button>
          {project.data?.gradlew &&
            (build?.state === "running" ? (
              <Button variant="danger" onClick={() => buildCtrl.current?.abort()} title="Stop the Gradle build">
                <Square size={12} /> Stop build
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!canInstall || !installTarget}
                onClick={() => installTarget && buildAndRun(installTarget)}
                title={`${project.data.gradlew} assembleDebug, then install the APK and launch the app`}
              >
                <Hammer size={12} /> Build & run
              </Button>
            ))}
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
                disabled={!canInstall || install.isPending || !chosenApk}
                onClick={() => installTarget && chosenApk && install.mutate({ target: installTarget, path: chosenApk.path })}
                title="adb install -r"
              >
                <Download size={12} /> {install.isPending ? "Installing…" : "Install APK"}
              </Button>
            </>
          )}
        </div>
      </div>
      {wifiOpen && (
        <div className="glass rounded-2xl p-3">
          <ConnectForm onConnected={onConnected} />
        </div>
      )}
      {error && <ErrorNote>{error.message}</ErrorNote>}
      {notice && <div className="text-xs text-emerald-300">{notice}</div>}
      {devices.data?.error && <div className="text-xs text-slate-400">Physical devices: {devices.data.error}</div>}
      {message && <div className="text-xs text-slate-400">{message}</div>}

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex min-h-0 w-[min(46%,560px)] shrink-0 flex-col gap-2">
          {source ? (
            <>
              <Screen key={sourceBase(source)} source={source} sendRef={sendRef} />
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
                <IconButton
                  onClick={() => (source.kind === "device" ? sendRef.current?.({ type: "rotate" }) : rotate.mutate(source.avd))}
                  title="Rotate"
                >
                  <RotateCw size={14} />
                </IconButton>
                <IconButton onClick={() => key("Power")} title="Power (screen on/off)">
                  <Power size={14} />
                </IconButton>
                <a
                  href={source.kind === "device" ? api.deviceScreenshotUrl(source.serial) : api.emulatorScreenshotUrl(source.avd)}
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
              {device ? (
                (device.message ?? "This device can't be shown right now.")
              ) : emulator?.state === "crashed" ? (
                <div className="max-w-full text-left">
                  <div className="mb-2 text-rose-300">The emulator exited while starting:</div>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-slate-400">
                    {emulator.message}
                  </pre>
                </div>
              ) : emulator?.state === "starting" || emulator?.state === "booting" ? (
                "Starting the emulator… the screen shows here once it's up."
              ) : emulator?.state === "stopping" ? (
                "Shutting down (saving its snapshot)…"
              ) : emulator?.state === "running" ? (
                "This emulator's screen can't be shown here."
              ) : (
                "Start the emulator to see its screen here."
              )}
            </div>
          )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {build && <BuildLog build={build} onClose={() => setBuild(undefined)} />}
          {source ? (
            <Logcat key={sourceBase(source)} url={`${sourceBase(source)}/logcat`} />
          ) : (
            <div className="glass flex min-h-0 flex-1 items-center justify-center rounded-2xl text-sm text-slate-600">
              Logcat shows here while the device is on.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
