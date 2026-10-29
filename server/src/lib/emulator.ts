// Runs the Android SDK's emulator headless and shows it in the Android tab, the way Android Studio's Running Devices
// pane does: the emulator is started with `-no-window -grpc <port> -grpc-use-token`, and its gRPC API
// (emulator/lib/emulator_controller.proto, loaded from the installed SDK so it always matches the emulator) streams
// the screen and takes touches and keys. Running emulators are found through the discovery files each one writes
// (`<temp>/avd/running/pid_<pid>.ini`), so they outlive a dashboard restart and ones started elsewhere show up too.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { dataDir } from "../db.ts";
import type { AndroidProjectInfo, EmulatorInfo, EmulatorOverview } from "../types.ts";

export const AVD_NAME = /^[\w.-]+$/;
const logDir = path.join(dataDir, "emulators");

export class EmulatorError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

// ── SDK ─────────────────────────────────────────────────────────────────────

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

/** The Android SDK folder: ANDROID_HOME, ANDROID_SDK_ROOT or where Android Studio puts it. */
export function sdkRoot(): string | undefined {
  const home = os.homedir();
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk") : undefined,
    process.platform === "darwin" ? path.join(home, "Library", "Android", "sdk") : undefined,
    process.platform === "linux" ? path.join(home, "Android", "Sdk") : undefined,
  ];
  return candidates.find((c): c is string => !!c && fs.existsSync(path.join(c, "emulator", exe("emulator"))));
}

function sdkOr409(): string {
  const sdk = sdkRoot();
  if (!sdk) throw new EmulatorError(409, "No Android SDK with an emulator found. Set ANDROID_HOME or install it from Android Studio.");
  return sdk;
}

const emulatorBin = (sdk: string) => path.join(sdk, "emulator", exe("emulator"));
const adbBin = (sdk: string) => path.join(sdk, "platform-tools", exe("adb"));

function run(file: string, args: string[], timeout = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : "")) });
    });
  });
}

async function avdNames(sdk: string): Promise<string[]> {
  const { stdout } = await run(emulatorBin(sdk), ["-list-avds"]);
  // It can print INFO/WARNING lines among the names.
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => AVD_NAME.test(l));
}

// ── Running instances ───────────────────────────────────────────────────────

interface Running {
  avd: string;
  pid: number;
  /** Console port; the adb serial is `emulator-<port>`. */
  consolePort: number;
  grpcPort?: number;
  token?: string;
}

function runningDirs(): string[] {
  const dirs = [path.join(os.tmpdir(), "avd", "running")];
  if (process.platform === "darwin") dirs.push(path.join(os.homedir(), "Library", "Caches", "TemporaryItems", "avd", "running"));
  if (process.platform === "linux") {
    if (process.env.XDG_RUNTIME_DIR) dirs.push(path.join(process.env.XDG_RUNTIME_DIR, "avd", "running"));
    dirs.push(path.join("/tmp", `android-${os.userInfo().username}`, "avd", "running"));
  }
  return dirs;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Emulators running now, from their discovery files. A file left by one that died is skipped. */
function runningEmulators(): Running[] {
  const found: Running[] = [];
  for (const dir of runningDirs()) {
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /^pid_(\d+)\.ini$/.exec(f);
      if (!m || !alive(Number(m[1]))) continue;
      let ini: Record<string, string>;
      try {
        ini = parseIni(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        continue;
      }
      if (!ini["avd.id"] || !ini["port.serial"]) continue; // Still being written.
      found.push({
        avd: ini["avd.id"],
        pid: Number(m[1]),
        consolePort: Number(ini["port.serial"]),
        grpcPort: ini["grpc.port"] ? Number(ini["grpc.port"]) : undefined,
        token: ini["grpc.token"] || undefined,
      });
    }
  }
  return found;
}

function runningOr409(avd: string): Running & { grpcPort: number; token: string } {
  const r = runningEmulators().find((r) => r.avd === avd);
  if (!r) throw new EmulatorError(409, `${avd} isn't running`);
  if (!r.grpcPort || !r.token) throw new EmulatorError(409, `${avd} wasn't started from the dashboard, so its screen can't be shown here`);
  return r as Running & { grpcPort: number; token: string };
}

// ── gRPC ────────────────────────────────────────────────────────────────────

// The generated client: a method per rpc in emulator_controller.proto.
type Controller = grpc.Client & Record<string, (...args: unknown[]) => unknown>;
type ControllerCtor = new (address: string, creds: grpc.ChannelCredentials, options?: grpc.ChannelOptions) => Controller;

let ctor: ControllerCtor | undefined;
const clients = new Map<string, { client: Controller; md: grpc.Metadata }>();

function controller(r: Running & { grpcPort: number; token: string }) {
  const key = `${r.pid}:${r.grpcPort}`;
  let c = clients.get(key);
  if (c) return c;
  if (!ctor) {
    const lib = path.join(sdkOr409(), "emulator", "lib");
    const def = protoLoader.loadSync(path.join(lib, "emulator_controller.proto"), {
      includeDirs: [lib],
      keepCase: true,
      longs: Number,
      enums: String,
      defaults: true,
    });
    const pkg = grpc.loadPackageDefinition(def) as unknown as { android: { emulation: { control: { EmulatorController: ControllerCtor } } } };
    ctor = pkg.android.emulation.control.EmulatorController;
  }
  // Full-size frames are several MB, well past gRPC's default 4 MB limit.
  const client = new ctor(`127.0.0.1:${r.grpcPort}`, grpc.credentials.createInsecure(), { "grpc.max_receive_message_length": -1 });
  const md = new grpc.Metadata();
  md.set("authorization", `Bearer ${r.token}`);
  c = { client, md };
  clients.set(key, c);
  return c;
}

function call<T>(r: Running & { grpcPort: number; token: string }, method: string, req: unknown, timeoutMs = 5000): Promise<T> {
  const { client, md } = controller(r);
  return new Promise((resolve, reject) => {
    client[method](req, md, { deadline: Date.now() + timeoutMs }, (err: Error | null, res: T) => (err ? reject(err) : resolve(res)));
  });
}

/** Drops clients for emulators that are gone. */
function pruneClients(running: Running[]) {
  const live = new Set(running.map((r) => `${r.pid}:${r.grpcPort}`));
  for (const [key, c] of clients) {
    if (live.has(key)) continue;
    c.client.close();
    clients.delete(key);
  }
}

interface Status {
  booted: boolean;
  hardwareConfig?: { entry?: Array<{ key: string; value: string }> };
}

/** Portrait screen size, read from the emulator's hardware config. Cached per instance (it doesn't change). */
const screens = new Map<number, { width: number; height: number }>();

async function statusOf(r: Running & { grpcPort: number; token: string }) {
  const s = await call<Status>(r, "getStatus", {}, 2000);
  if (!screens.has(r.pid)) {
    const hw = Object.fromEntries((s.hardwareConfig?.entry ?? []).map((e) => [e.key, e.value]));
    const width = Number(hw["hw.lcd.width"]), height = Number(hw["hw.lcd.height"]);
    if (width > 0 && height > 0) screens.set(r.pid, { width, height });
  }
  return { booted: s.booted, screen: screens.get(r.pid) };
}

// ── Starting and stopping ───────────────────────────────────────────────────

/** Emulators this dashboard process started, until their discovery file takes over. */
interface Launch {
  child: ChildProcess;
  log: string;
  exitCode?: number | null;
  stopRequested: boolean;
}
const launches = new Map<string, Launch>();
/**
 * Emulators asked to stop, by AVD: the process to wait for. An emulator drops its discovery file early and then spends a
 * while saving its snapshot; starting it again meanwhile fails.
 */
const stopping = new Map<string, number>();

function stillStopping(avd: string): boolean {
  const pid = stopping.get(avd);
  if (pid && alive(pid)) return true;
  stopping.delete(avd);
  return false;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

function logTail(file: string, lines = 12): string {
  try {
    return fs.readFileSync(file, "utf8").replace(ANSI, "").split(/\r?\n/).filter((l) => /\S/.test(l)).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function freeGrpcPort(): Promise<number> {
  const taken = new Set(runningEmulators().map((r) => r.grpcPort));
  for (let port = 8554; port < 8654; port++) if (!taken.has(port) && (await portFree(port))) return port;
  throw new Error("No free port for the emulator's gRPC endpoint (tried 8554–8653)");
}

export async function startEmulator(avd: string): Promise<EmulatorInfo> {
  if (!AVD_NAME.test(avd)) throw new EmulatorError(400, "Invalid AVD name");
  const sdk = sdkOr409();
  if (!(await avdNames(sdk)).includes(avd)) throw new EmulatorError(404, `No AVD named ${avd}`);
  if (runningEmulators().some((r) => r.avd === avd)) throw new EmulatorError(409, `${avd} is already running`);
  if (stillStopping(avd)) throw new EmulatorError(409, `${avd} is still shutting down`);
  const prev = launches.get(avd);
  if (prev && prev.exitCode === undefined) throw new EmulatorError(409, `${avd} is already starting`);

  const port = await freeGrpcPort();
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `${avd}.log`);
  const fd = fs.openSync(log, "w");
  let child: ChildProcess;
  try {
    // Detached with its output in a file, so it keeps running when the dashboard restarts. No audio: it isn't streamed.
    child = spawn(emulatorBin(sdk), ["-avd", avd, "-no-window", "-no-boot-anim", "-no-audio", "-grpc", String(port), "-grpc-use-token"], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  const launch: Launch = { child, log, stopRequested: false };
  launches.set(avd, launch);
  child.once("error", (e) => {
    fs.appendFileSync(log, `\nCouldn't start: ${e.message}\n`);
    launch.exitCode = -1;
  });
  child.once("exit", (code) => {
    launch.exitCode = code;
  });
  child.unref();
  return { avd, state: "starting", pid: child.pid, viewable: false };
}

export async function stopEmulator(avd: string): Promise<boolean> {
  if (!AVD_NAME.test(avd)) throw new EmulatorError(400, "Invalid AVD name");
  const launch = launches.get(avd);
  if (launch) launch.stopRequested = true;
  const r = runningEmulators().find((r) => r.avd === avd);
  if (!r) {
    // Still starting up, before its discovery file exists.
    if (launch && launch.exitCode === undefined && launch.child.pid) {
      stopping.set(avd, launch.child.pid);
      kill(launch.child.pid);
      return true;
    }
    return false;
  }
  stopping.set(avd, r.pid);
  if (r.grpcPort && r.token) {
    const ok = await call(r as Running & { grpcPort: number; token: string }, "setVmState", { state: "SHUTDOWN" }).then(
      () => true,
      () => false,
    );
    if (ok) return true;
  }
  const sdk = sdkRoot();
  if (sdk && (await run(adbBin(sdk), ["-s", `emulator-${r.consolePort}`, "emu", "kill"])).code === 0) return true;
  kill(r.pid);
  return true;
}

function kill(pid: number) {
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

// ── Overview ────────────────────────────────────────────────────────────────

async function infoFor(avd: string, r: Running | undefined): Promise<EmulatorInfo> {
  const launch = launches.get(avd);
  if (r) {
    const base = { avd, serial: `emulator-${r.consolePort}`, pid: r.pid };
    if (stopping.get(avd) === r.pid) return { ...base, state: "stopping", viewable: false };
    if (!r.grpcPort || !r.token)
      return {
        ...base,
        state: "running",
        viewable: false,
        message: "Started outside the dashboard (by Android Studio?), so its screen can't be shown here. Stop it and start it from here instead.",
      };
    const status = await statusOf(r as Running & { grpcPort: number; token: string }).catch(() => undefined);
    return { ...base, state: status?.booted ? "running" : "booting", viewable: !!status, screen: status?.screen };
  }
  if (stillStopping(avd)) return { avd, state: "stopping", pid: stopping.get(avd), viewable: false };
  if (launch?.exitCode === undefined && launch) return { avd, state: "starting", pid: launch.child.pid, viewable: false };
  if (launch && !launch.stopRequested && launch.exitCode !== 0)
    return { avd, state: "crashed", viewable: false, message: logTail(launch.log) || `Exited with code ${launch.exitCode}` };
  return { avd, state: "stopped", viewable: false };
}

export async function emulatorOverview(): Promise<EmulatorOverview> {
  const sdk = sdkRoot();
  if (!sdk) return { error: "No Android SDK with an emulator found. Set ANDROID_HOME, or install the SDK from Android Studio.", avds: [] };
  const [names, running] = await Promise.all([avdNames(sdk), Promise.resolve(runningEmulators())]);
  pruneClients(running);
  // Running ones from another AVD folder still show up.
  const all = [...new Set([...names, ...running.map((r) => r.avd)])];
  return { sdk, avds: await Promise.all(all.map((avd) => infoFor(avd, running.find((r) => r.avd === avd)))) };
}

// ── Screen ──────────────────────────────────────────────────────────────────

const ROTATIONS = ["PORTRAIT", "LANDSCAPE", "REVERSE_PORTRAIT", "REVERSE_LANDSCAPE"];

interface Frame {
  format: { width: number; height: number; rotation?: { rotation: string } };
  image: Buffer;
}

/** What the Android tab sends over its WebSocket. Positions are 0–1 across the frame as shown. */
export type ScreenInput =
  | { type: "size"; width: number; height: number }
  | { type: "touch"; x: number; y: number; down: boolean }
  | { type: "key"; key: string; eventType?: "keydown" | "keyup" | "keypress" }
  | { type: "text"; text: string }
  /** Scroll by `dy` (a fraction of the frame's height, positive is down) with the pointer at `x`, `y`. */
  | { type: "wheel"; x: number; y: number; dy: number };

/**
 * One viewer of an emulator's screen. Frames go to `send` as `[width u32][height u32][rotation u8][3 spare]` then RGB
 * bytes, scaled by the emulator to fit the size the viewer asked for. Only changed frames are sent.
 */
export function openScreen(avd: string, send: (frame: Uint8Array<ArrayBuffer>) => void, onError: (message: string) => void) {
  const r = runningOr409(avd);
  const { client, md } = controller(r);
  let stream: grpc.ClientReadableStream<Frame> | undefined;
  // One ordered stream for all input: separate calls can overtake each other, turning a tap into a long press.
  let events: grpc.ClientWritableStream<unknown> | undefined;
  let rotation = 0;
  let closed = false;
  let touching = false;
  let scrolling = false;

  const watch = (width: number, height: number) => {
    stream?.cancel();
    const s = client.streamScreenshot({ format: "RGB888", width, height }, md) as grpc.ClientReadableStream<Frame>;
    stream = s;
    s.on("data", (img: Frame) => {
      rotation = Math.max(0, ROTATIONS.indexOf(img.format.rotation?.rotation ?? "PORTRAIT"));
      const out = new Uint8Array(12 + img.image.length);
      const view = new DataView(out.buffer);
      view.setUint32(0, img.format.width);
      view.setUint32(4, img.format.height);
      out[8] = rotation;
      out.set(img.image, 12);
      send(out);
    });
    s.on("error", (e: grpc.ServiceError) => {
      if (s === stream && !closed && e.code !== grpc.status.CANCELLED) onError(e.details || e.message);
    });
  };

  const screen = () => screens.get(r.pid);
  // Turns a spot on the frame as shown into device pixels: touches always use the portrait coordinates.
  const toDevice = (x: number, y: number) => {
    const size = screen();
    if (!size) return undefined;
    const [u, v] = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
    const [nx, ny] = rotation === 1 ? [1 - v, u] : rotation === 2 ? [1 - u, 1 - v] : rotation === 3 ? [v, 1 - u] : [u, v];
    return { x: Math.round(nx * (size.width - 1)), y: Math.round(ny * (size.height - 1)) };
  };
  const ignore = () => {};
  const sendEvent = (event: Record<string, unknown>) => {
    if (!events) {
      const e = client.streamInputEvent(md, ignore) as grpc.ClientWritableStream<unknown>;
      e.on("error", () => events === e && (events = undefined));
      events = e;
    }
    events.write(event);
  };

  // The screen size comes with the status; fetch it now if the overview hasn't yet.
  if (!screen()) statusOf(r).catch(ignore);

  return {
    input(msg: ScreenInput) {
      if (closed) return;
      if (msg.type === "size") {
        const w = Math.round(msg.width), h = Math.round(msg.height);
        if (w > 0 && h > 0) watch(Math.min(w, 4096), Math.min(h, 4096));
      } else if (msg.type === "touch") {
        const p = toDevice(msg.x, msg.y);
        touching = msg.down;
        if (p) sendEvent({ touch_event: { touches: [{ ...p, identifier: 0, pressure: msg.down ? 1 : 0 }] } });
      } else if (msg.type === "key") {
        sendEvent({ key_event: { eventType: msg.eventType ?? "keypress", key: msg.key } });
      } else if (msg.type === "text") {
        sendEvent({ key_event: { eventType: "keypress", text: msg.text } });
      } else if (msg.type === "wheel") {
        // Most system images have no mouse wheel wired up (injectWheel does nothing on them), so scroll with a short
        // drag instead: content follows the finger, hence the drag goes the opposite way. Skipped mid-drag or mid-scroll.
        if (touching || scrolling || !msg.dy) return;
        scrolling = true;
        const y0 = Math.min(0.95, Math.max(0.05, msg.y));
        const y1 = Math.min(0.98, Math.max(0.02, y0 - msg.dy));
        const steps = 6;
        let i = 0;
        const tick = () => {
          if (closed) return;
          const y = y0 + ((y1 - y0) * i) / steps;
          const p = toDevice(msg.x, y);
          if (p) sendEvent({ touch_event: { touches: [{ ...p, identifier: 0, pressure: i < steps ? 1 : 0 }] } });
          if (i++ < steps) setTimeout(tick, 12);
          else scrolling = false;
        };
        tick();
      }
    },
    close() {
      closed = true;
      stream?.cancel();
      events?.end();
    },
  };
}

export async function screenshot(avd: string): Promise<Buffer> {
  const img = await call<Frame>(runningOr409(avd), "getScreenshot", { format: "PNG" }, 15_000);
  return img.image;
}

/** Turns the device a quarter turn, like the emulator window's rotate button. */
export async function rotate(avd: string) {
  const r = runningOr409(avd);
  const res = await run(adbBin(sdkOr409()), ["-s", `emulator-${r.consolePort}`, "emu", "rotate"]);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "adb couldn't rotate the emulator");
}

/**
 * NDJSON stream of the emulator's logcat (`{"text": "..."}` per line, the last 500 first) until the client disconnects.
 * Heartbeat newlines every 10s like the Dev tab's log stream. Through adb: newer system images send nothing over the
 * emulator's own streamLogcat.
 */
export function logcatStream(avd: string): ReadableStream<Uint8Array> {
  const r = runningEmulators().find((r) => r.avd === avd);
  if (!r) throw new EmulatorError(409, `${avd} isn't running`);
  const adb = adbBin(sdkOr409());
  const enc = new TextEncoder();
  let child: ChildProcess | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (bytes: Uint8Array) => {
        try {
          controller.enqueue(bytes);
        } catch {
          // Client went away; cancel() cleans up.
        }
      };
      const end = () => {
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      child = spawn(adb, ["-s", `emulator-${r.consolePort}`, "logcat", "-v", "threadtime", "-T", "500"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const decoder = new StringDecoder("utf8");
      let rest = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        const parts = (rest + decoder.write(chunk)).split(/\r?\n/);
        rest = parts.pop() ?? "";
        const lines = parts.filter((p) => p.length && !p.startsWith("--------- beginning of")).map((text) => JSON.stringify({ text })).join("\n");
        if (lines) enqueue(enc.encode(lines + "\n"));
      });
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("error", (e) => {
        enqueue(enc.encode(JSON.stringify({ error: `Couldn't run adb: ${e.message}` }) + "\n"));
        end();
      });
      child.once("close", (code) => {
        if (code) enqueue(enc.encode(JSON.stringify({ error: stderr.trim() || `adb logcat exited with code ${code}` }) + "\n"));
        end();
      });
      keepAlive = setInterval(() => enqueue(new Uint8Array([10])), 10_000);
    },
    cancel() {
      clearInterval(keepAlive);
      child?.kill();
    },
  });
}

// ── Projects ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", ".gradle", ".idea", ".claude", ".dashboard", "intermediates", "tmp"]);

/** Whether the project looks like an Android one, and the APKs its builds left. */
export function androidProject(dir: string): AndroidProjectInfo {
  const has = (...p: string[]) => fs.existsSync(path.join(dir, ...p));
  // At the root, or in android/ for React Native, Expo and Flutter apps.
  const gradle = ["", "android"].some((d) => ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"].some((f) => has(d, f)));
  const apks: Array<AndroidProjectInfo["apks"][number] & { mtime: number }> = [];

  const collect = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 6) collect(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(".apk")) {
        const st = fs.statSync(full);
        apks.push({ path: path.relative(dir, full).split(path.sep).join("/"), size: st.size, modifiedAt: st.mtime.toISOString(), mtime: st.mtimeMs });
      }
    }
  };
  // Looks for `<module>/build/outputs/apk` a few folders down, without walking into dependencies.
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.name === "build") {
        const out = path.join(full, "outputs", "apk");
        if (fs.existsSync(out)) collect(out, 0);
      } else if (depth < 4) walk(full, depth + 1);
    }
  };
  walk(dir, 0);

  const manifest = has("AndroidManifest.xml") || has("app", "src", "main", "AndroidManifest.xml");
  apks.sort((a, b) => b.mtime - a.mtime);
  return { isAndroid: gradle || manifest || apks.length > 0, apks: apks.map(({ mtime: _, ...a }) => a) };
}

export async function installApk(dir: string, apk: string, avd: string): Promise<string> {
  if (!androidProject(dir).apks.some((a) => a.path === apk)) throw new EmulatorError(404, `No built APK at ${apk}`);
  const r = runningEmulators().find((r) => r.avd === avd);
  if (!r) throw new EmulatorError(409, `${avd} isn't running`);
  const res = await run(adbBin(sdkOr409()), ["-s", `emulator-${r.consolePort}`, "install", "-r", "-t", path.join(dir, apk)], 180_000);
  const out = (res.stdout + res.stderr).trim();
  if (res.code !== 0 || !/Success/.test(out)) throw new Error(out || "adb install failed");
  return out;
}
