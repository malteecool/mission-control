// Runs the Android SDK's emulator headless and shows it in the Android tab, the way Android Studio's Running Devices
// pane does: the emulator is started with `-no-window -grpc <port> -grpc-use-token`, and its gRPC API
// (emulator/lib/emulator_controller.proto, loaded from the installed SDK so it always matches the emulator) streams
// the screen and takes touches and keys. Running emulators are found through the discovery files each one writes
// (`<temp>/avd/running/pid_<pid>.ini`), so they outlive a dashboard restart and ones started elsewhere show up too.
// Android Studio starts its emulators with `-grpc-use-jwt` instead; those are reached by signing JWTs with a key we
// hand them, as Studio does.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { dataDir } from "../db.ts";
import type { AndroidProjectInfo, AndroidRunEvent, EmulatorInfo, EmulatorOverview } from "../types.ts";

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

function sdkCandidates(): string[] {
  const home = os.homedir();
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk") : undefined,
    process.platform === "darwin" ? path.join(home, "Library", "Android", "sdk") : undefined,
    process.platform === "linux" ? path.join(home, "Android", "Sdk") : undefined,
  ].filter((c): c is string => !!c);
}

/** The Android SDK folder: ANDROID_HOME, ANDROID_SDK_ROOT or where Android Studio puts it. */
export function sdkRoot(): string | undefined {
  return sdkCandidates().find((c) => fs.existsSync(path.join(c, "emulator", exe("emulator"))));
}

/** adb from the SDK's platform-tools, or from PATH (physical devices don't need the emulator). */
export function adbPath(): string | undefined {
  const inSdk = sdkCandidates().map(adbBin).find((p) => fs.existsSync(p));
  if (inSdk) return inSdk;
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => path.join(d, exe("adb")))
    .find((p) => fs.existsSync(p));
}

export function adbOr409(): string {
  const adb = adbPath();
  if (!adb) throw new EmulatorError(409, "adb not found. Install the Android SDK's platform tools, or set ANDROID_HOME.");
  return adb;
}

function sdkOr409(): string {
  const sdk = sdkRoot();
  if (!sdk) throw new EmulatorError(409, "No Android SDK with an emulator found. Set ANDROID_HOME or install it from Android Studio.");
  return sdk;
}

const emulatorBin = (sdk: string) => path.join(sdk, "emulator", exe("emulator"));
const adbBin = (sdk: string) => path.join(sdk, "platform-tools", exe("adb"));

export function run(file: string, args: string[], timeout = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
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
  /** With `-grpc-use-token` (started from the dashboard): sent as is. */
  token?: string;
  /**
   * With `-grpc-use-jwt` (started by Android Studio): the folder it loads public keys from, and the file it lists the
   * loaded ones in. Calls carry a JWT signed with our own key, the way Studio does it.
   */
  jwks?: { dir: string; active: string };
}

/** An emulator whose gRPC API the dashboard can call. */
type Reachable = Running & { grpcPort: number };

const reachable = (r: Running): r is Reachable => !!r.grpcPort && !!(r.token || r.jwks);

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
        jwks: ini["grpc.jwks"] && ini["grpc.jwk_active"] ? { dir: ini["grpc.jwks"], active: ini["grpc.jwk_active"] } : undefined,
      });
    }
  }
  return found;
}

function runningOr409(avd: string): Reachable {
  const r = runningEmulators().find((r) => r.avd === avd);
  if (!r) throw new EmulatorError(409, `${avd} isn't running`);
  if (!reachable(r)) throw new EmulatorError(409, `${avd} runs without a gRPC endpoint the dashboard can use, so its screen can't be shown here`);
  return r;
}

// ── gRPC ────────────────────────────────────────────────────────────────────

// The generated client: a method per rpc in emulator_controller.proto.
type Controller = grpc.Client & Record<string, (...args: unknown[]) => unknown>;
type ControllerCtor = new (address: string, creds: grpc.ChannelCredentials, options?: grpc.ChannelOptions) => Controller;

let ctor: ControllerCtor | undefined;

interface Connection {
  client: Controller;
  /** Settles once calls can be authorized (a JWT emulator has loaded our key). */
  ready: Promise<void>;
  /** Metadata for a call starting now. */
  md: () => grpc.Metadata;
}
const clients = new Map<string, Connection>();

function controller(r: Reachable): Connection {
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
  const bearer = (token: string) => {
    const md = new grpc.Metadata();
    md.set("authorization", `Bearer ${token}`);
    return md;
  };
  if (r.token) {
    const md = bearer(r.token);
    c = { client, ready: Promise.resolve(), md: () => md };
  } else {
    const ready = registerKey(r.jwks!);
    // Try again next time rather than keeping a connection that can't authorize.
    ready.catch(() => {
      if (clients.get(key) !== c) return;
      clients.delete(key);
      client.close();
    });
    c = { client, ready, md: () => bearer(jwt()) };
  }
  clients.set(key, c);
  return c;
}

async function call<T>(r: Reachable, method: string, req: unknown, timeoutMs = 5000): Promise<T> {
  const { client, ready, md } = controller(r);
  await ready;
  return new Promise((resolve, reject) => {
    client[method](req, md(), { deadline: Date.now() + timeoutMs }, (err: Error | null, res: T) => (err ? reject(err) : resolve(res)));
  });
}

// ── JWT (emulators started by Android Studio) ───────────────────────────────

/** This process's signing key, made on first use. The emulator gets its public half as a JWK. */
let signer: { kid: string; privateKey: crypto.KeyObject; jwk: object } | undefined;
let token: { jwt: string; exp: number } | undefined;

function signingKey() {
  if (!signer) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const kid = crypto.randomUUID();
    signer = { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" } };
  }
  return signer;
}

/**
 * Drops our public key in the emulator's JWKS folder, then waits for it to show up in the emulator's list of loaded
 * keys (it watches the folder, so this takes a moment).
 */
async function registerKey(jwks: { dir: string; active: string }) {
  const { kid, jwk } = signingKey();
  const loaded = () => {
    try {
      return (JSON.parse(fs.readFileSync(jwks.active, "utf8")) as { keys?: Array<{ kid?: string }> }).keys?.some((k) => k.kid === kid) ?? false;
    } catch {
      return false; // Missing or mid-write.
    }
  };
  if (loaded()) return;
  fs.writeFileSync(path.join(jwks.dir, `dashboard-${kid}.jwk`), JSON.stringify({ keys: [jwk] }));
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (loaded()) return;
  }
  throw new Error("The emulator didn't pick up the dashboard's key");
}

/**
 * A JWT for any call, renewed well before it expires. The emulator only accepts issuers in its
 * emulator/lib/emulator_access.json; "android-studio" may call everything on EmulatorController without an `aud`.
 */
function jwt(): string {
  const now = Math.floor(Date.now() / 1000);
  if (token && token.exp - now > 600) return token.jwt;
  const { kid, privateKey } = signingKey();
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  // No `typ` in the header: the emulator's validator rejects it.
  const body = `${part({ alg: "ES256", kid })}.${part({ iss: "android-studio", iat: now - 60, exp: now + 3600 })}`;
  const sig = crypto.sign("sha256", Buffer.from(body), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  token = { jwt: `${body}.${sig}`, exp: now + 3600 };
  return token.jwt;
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

async function statusOf(r: Reachable) {
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
  if (reachable(r)) {
    const ok = await call(r, "setVmState", { state: "SHUTDOWN" }).then(
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
    if (!reachable(r))
      return {
        ...base,
        state: "running",
        viewable: false,
        message: "Started without a gRPC endpoint the dashboard can use, so it's mirrored through scrcpy instead of the emulator's own API.",
      };
    let failure: string | undefined;
    const status = await statusOf(r).catch((e: Error) => void (failure = (e as grpc.ServiceError).details || e.message));
    // One of Studio's that won't take our key: mirror it instead (one of ours just isn't up yet).
    if (!status && r.jwks)
      return { ...base, state: "running", viewable: false, message: `Couldn't reach the emulator's own API (${failure}), so it's mirrored through scrcpy.` };
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
  const { client, ready, md } = controller(r);
  let stream: grpc.ClientReadableStream<Frame> | undefined;
  /** Counts size requests, so only the latest one starts a stream once calls can be authorized. */
  let sizes = 0;
  // One ordered stream for all input: separate calls can overtake each other, turning a tap into a long press.
  let events: grpc.ClientWritableStream<unknown> | undefined;
  let rotation = 0;
  let closed = false;
  let authorized = false;
  let touching = false;
  let scrolling = false;
  const ignore = () => {};

  ready.then(
    () => (authorized = true),
    (e: Error) => !closed && onError(e.message),
  );

  const watch = (width: number, height: number) => {
    stream?.cancel();
    stream = undefined;
    const asked = ++sizes;
    // A rejected `ready` was reported above.
    ready.then(() => asked === sizes && !closed && startStream(width, height), ignore);
  };
  const startStream = (width: number, height: number) => {
    const s = client.streamScreenshot({ format: "RGB888", width, height }, md()) as grpc.ClientReadableStream<Frame>;
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
  const toDevice = (x: number, y: number) => portraitPoint(screen(), rotation, x, y);
  const sendEvent = (event: Record<string, unknown>) => {
    if (!authorized) return; // Nothing is on screen yet to aim at.
    if (!events) {
      const e = client.streamInputEvent(md(), ignore) as grpc.ClientWritableStream<unknown>;
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

/** Turns a spot (0–1) on a frame shown at `rotation` into device pixels: touches always use the portrait coordinates. */
function portraitPoint(size: { width: number; height: number } | undefined, rotation: number, x: number, y: number) {
  if (!size) return undefined;
  const [u, v] = [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))];
  const [nx, ny] = rotation === 1 ? [1 - v, u] : rotation === 2 ? [1 - u, 1 - v] : rotation === 3 ? [v, 1 - u] : [u, v];
  return { x: Math.round(nx * (size.width - 1)), y: Math.round(ny * (size.height - 1)) };
}

export async function screenshot(avd: string): Promise<Buffer> {
  const img = await call<Frame>(runningOr409(avd), "getScreenshot", { format: "PNG" }, 15_000);
  return img.image;
}

// ── For Claude sessions (mcp.ts) ───────────────────────────────────────────

/** Running emulators: their adb serial, and whether the dashboard can drive them over gRPC. */
export function runningEmulatorTargets(): Array<{ avd: string; serial: string; grpc: boolean }> {
  return runningEmulators().map((r) => ({ avd: r.avd, serial: `emulator-${r.consolePort}`, grpc: reachable(r) }));
}

/** A PNG of the screen as shown (rotated), scaled by the emulator to fit `maxWidth`×`maxHeight`. */
export async function scaledScreenshot(avd: string, maxWidth: number, maxHeight: number) {
  const r = runningOr409(avd);
  if (!screens.has(r.pid)) await statusOf(r).catch(() => undefined);
  const img = await call<Frame>(r, "getScreenshot", { format: "PNG", width: maxWidth, height: maxHeight }, 15_000);
  const rotation = Math.max(0, ROTATIONS.indexOf(img.format.rotation?.rotation ?? "PORTRAIT"));
  return { png: img.image, width: img.format.width, height: img.format.height, rotation };
}

/**
 * Touches at spots (0–1 across a frame shown at `rotation`), `stepMs` apart, through one ordered input stream. The
 * finger stays down until a point with `down: false`.
 */
export async function touchPath(avd: string, rotation: number, points: Array<{ x: number; y: number; down: boolean }>, stepMs: number) {
  const r = runningOr409(avd);
  if (!screens.has(r.pid)) await statusOf(r);
  const size = screens.get(r.pid);
  if (!size) throw new EmulatorError(409, `Couldn't read ${avd}'s screen size`);
  await inputEvents(
    r,
    points.map((p) => ({ touch_event: { touches: [{ ...portraitPoint(size, rotation, p.x, p.y)!, identifier: 0, pressure: p.down ? 1 : 0 }] } })),
    stepMs,
  );
}

/** A key press (by the emulator's key name, e.g. `GoBack`, `Enter`) or typed text. */
export async function keyInput(avd: string, input: { key: string } | { text: string }) {
  await inputEvents(runningOr409(avd), [{ key_event: { eventType: "keypress", ...input } }], 0);
}

async function inputEvents(r: Reachable, events: unknown[], stepMs: number): Promise<void> {
  const { client, ready, md } = controller(r);
  await ready;
  return new Promise((resolve, reject) => {
    const stream = client.streamInputEvent(md(), (err: Error | null) => (err ? reject(err) : resolve())) as grpc.ClientWritableStream<unknown>;
    let i = 0;
    const next = () => {
      if (i >= events.length) return stream.end();
      stream.write(events[i++]);
      if (stepMs > 0) setTimeout(next, stepMs);
      else next();
    };
    next();
  });
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
  return adbLogcatStream(adbBin(sdkOr409()), `emulator-${r.consolePort}`);
}

/** `adb logcat` for any device, in the format above. */
export function adbLogcatStream(adb: string, serial: string): ReadableStream<Uint8Array> {
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
      child = spawn(adb, ["-s", serial, "logcat", "-v", "threadtime", "-T", "500"], {
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
  const wrapper = gradleDir(dir);
  return {
    isAndroid: gradle || manifest || apks.length > 0,
    apks: apks.map(({ mtime: _, ...a }) => a),
    gradlew: wrapper === undefined ? undefined : path.posix.join(wrapper, "gradlew"),
  };
}

type Target = { avd: string } | { serial: string };

function serialFor(target: Target): string {
  if (!("avd" in target)) return target.serial;
  const r = runningEmulators().find((r) => r.avd === target.avd);
  if (!r) throw new EmulatorError(409, `${target.avd} isn't running`);
  return `emulator-${r.consolePort}`;
}

async function adbInstall(adb: string, serial: string, file: string): Promise<string> {
  const res = await run(adb, ["-s", serial, "install", "-r", "-t", file], 180_000);
  const out = (res.stdout + res.stderr).trim();
  if (res.code !== 0 || !/Success/.test(out)) throw new Error(out || "adb install failed");
  return out;
}

/** Installs one of the project's APKs on an emulator (by AVD) or a device (by adb serial). */
export async function installApk(dir: string, apk: string, target: Target): Promise<string> {
  if (!androidProject(dir).apks.some((a) => a.path === apk)) throw new EmulatorError(404, `No built APK at ${apk}`);
  return adbInstall(adbOr409(), serialFor(target), path.join(dir, apk));
}

// ── Build & run ─────────────────────────────────────────────────────────────

/** Where the Gradle wrapper is, relative to the project ("" or "android"). */
function gradleDir(dir: string): string | undefined {
  return ["", "android"].find((d) => ["gradlew", "gradlew.bat"].some((f) => fs.existsSync(path.join(dir, d, f))));
}

/** The JDK bundled with Android Studio, which is what Studio builds with unless told otherwise. */
function studioJdk(): string | undefined {
  const home = os.homedir();
  const candidates =
    process.platform === "win32"
      ? [process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]
          .filter((d): d is string => !!d)
          .map((d) => path.join(d, "Android", "Android Studio", "jbr"))
      : process.platform === "darwin"
        ? ["/Applications/Android Studio.app/Contents/jbr/Contents/Home", path.join(home, "Applications", "Android Studio.app", "Contents", "jbr", "Contents", "Home")]
        : ["/opt/android-studio/jbr", path.join(home, "android-studio", "jbr"), "/snap/android-studio/current/jbr"];
  return candidates.find((c) => fs.existsSync(path.join(c, "bin", exe("java"))));
}

/** The package an APK installs: from the output-metadata.json Gradle writes beside it, else from aapt2. */
async function packageOf(apkFile: string): Promise<string | undefined> {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(apkFile), "output-metadata.json"), "utf8")) as { applicationId?: unknown };
    if (typeof meta.applicationId === "string" && meta.applicationId) return meta.applicationId;
  } catch {
    // Older Android Gradle Plugin, or not written by Gradle.
  }
  const sdk = sdkCandidates().find((c) => fs.existsSync(path.join(c, "build-tools")));
  if (!sdk) return undefined;
  const versions = fs.readdirSync(path.join(sdk, "build-tools")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const aapt2 = versions.map((v) => path.join(sdk, "build-tools", v, exe("aapt2"))).find((p) => fs.existsSync(p));
  if (!aapt2) return undefined;
  const res = await run(aapt2, ["dump", "packagename", apkFile]);
  return res.code === 0 ? res.stdout.trim() || undefined : undefined;
}

/**
 * The debug APK assembleDebug made: one written by this build if any (an up-to-date build leaves the old one), in the
 * `app` module if there are several, preferring a universal APK over ABI splits.
 */
function debugApk(dir: string, since: number): string | undefined {
  const debug = androidProject(dir).apks.filter((a) => /\/outputs\/apk\/(?:[^/]+\/)?debug\/[^/]+$/.test(a.path));
  const fresh = debug.filter((a) => Date.parse(a.modifiedAt) >= since - 2000);
  const pool = fresh.length ? fresh : debug;
  const inApp = pool.filter((a) => /^(?:android\/)?app\//.test(a.path));
  const picks = inApp.length ? inApp : pool;
  return (picks.find((a) => /universal/.test(a.path)) ?? picks[0])?.path;
}

/** Projects with a build going, so a second click doesn't start another Gradle run on the same folder. */
const building = new Set<string>();

/**
 * Builds the project with `gradlew assembleDebug`, installs the APK on the target and launches it, as NDJSON
 * `AndroidRunEvent`s with Gradle's output as it comes. Cancelling the stream stops the build.
 */
export function buildAndRunStream(dir: string, target: Target): ReadableStream<Uint8Array> {
  const wrapper = gradleDir(dir);
  if (wrapper === undefined) throw new EmulatorError(404, "No Gradle wrapper (gradlew) in the project or its android/ folder");
  const adb = adbOr409();
  const serial = serialFor(target);
  const cwd = path.join(dir, wrapper);
  if (building.has(cwd)) throw new EmulatorError(409, "A build is already running for this project");
  building.add(cwd);

  const enc = new TextEncoder();
  let child: ChildProcess | undefined;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: AndroidRunEvent) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
        } catch {
          // Client went away; cancel() cleans up.
        }
      };
      const say = (text: string) => send({ text, stream: "system" });
      try {
        const started = Date.now();
        const env = { ...process.env };
        // Builds like Android Studio's: its JDK, and the SDK even without a local.properties (fresh worktrees).
        const jdk = studioJdk();
        if (jdk) env.JAVA_HOME = jdk;
        const sdk = sdkRoot() ?? sdkCandidates().find((c) => fs.existsSync(c));
        if (sdk && !env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) env.ANDROID_HOME = sdk;
        const windows = process.platform === "win32";
        const args = ["assembleDebug", "--console=plain"];
        say(`> ${path.posix.join(wrapper, "gradlew")} ${args.join(" ")}${jdk ? ` (JDK: ${jdk})` : ""}`);
        const code = await new Promise<number>((resolve, reject) => {
          // gradlew.bat has to go through cmd, by full path: cmd skips the current folder when NoDefaultCurrentDirectoryInExePath
          // is set. `sh gradlew` doesn't need the script to be executable.
          child = windows
            ? spawn(`"${path.join(cwd, "gradlew.bat")}" ${args.join(" ")}`, { cwd, env, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
            : spawn("sh", ["gradlew", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
          for (const stream of ["stdout", "stderr"] as const) {
            const decoder = new StringDecoder("utf8");
            let rest = "";
            // Without the colour codes some plugins (Expo's) print.
            const emit = (parts: string[]) => parts.forEach((text) => send({ text: text.replace(/\x1b\[[\d;]*m/g, ""), stream }));
            child[stream]!.on("data", (chunk: Buffer) => {
              const parts = (rest + decoder.write(chunk)).split(/\r?\n/);
              rest = parts.pop() ?? "";
              emit(parts);
            });
            child[stream]!.on("end", () => rest && emit([rest + decoder.end()]));
          }
          child.once("error", reject);
          child.once("close", (code) => resolve(code ?? 1));
        });
        if (cancelled) return;
        if (code !== 0) throw new Error(`Gradle failed (exit code ${code})`);

        const apk = debugApk(dir, started);
        if (!apk) throw new Error("The build finished, but no debug APK turned up under build/outputs/apk");
        const file = path.join(dir, apk);
        const pkg = await packageOf(file);
        if (!pkg) throw new Error(`Couldn't tell which package ${apk} installs`);

        say(`> adb -s ${serial} install -r -t ${apk}`);
        say(await adbInstall(adb, serial, file));
        if (cancelled) return;

        say(`> adb -s ${serial} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
        const launch = await run(adb, ["-s", serial, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]);
        const out = (launch.stdout + launch.stderr).trim();
        if (launch.code !== 0 || !/Events injected: 1/.test(out)) {
          throw new Error(/No activities found/.test(out) ? `${pkg} has no launcher activity to start` : out || "Launching the app failed");
        }
        send({ done: true, apk, package: pkg });
      } catch (e) {
        if (!cancelled) send({ error: (e as Error).message });
      } finally {
        building.delete(cwd);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
    cancel() {
      cancelled = true;
      if (child?.pid && child.exitCode === null) kill(child.pid);
    },
  });
}
