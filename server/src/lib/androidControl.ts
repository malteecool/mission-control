// What Claude sessions use to look at and drive an Android screen (the tools in mcp.ts). Emulators with a gRPC API the
// dashboard can call (its own and Android Studio's) go through it (emulator.ts); anything else adb sees (physical
// devices, emulators without one) goes through adb: screencap, input, logcat.
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import {
  EmulatorError,
  adbOr409,
  adbPath,
  emulatorOverview,
  keyInput,
  run,
  runningEmulatorTargets,
  scaledScreenshot,
  startEmulator,
  touchPath,
} from "./emulator.ts";
import { deviceOverview } from "./scrcpy.ts";

/**
 * Screenshots are scaled to fit this box, so Claude sees them without the API shrinking them again (which would
 * throw its coordinates off) and they cost around a thousand tokens.
 */
const MAX_SIDE = 1280;

interface Target {
  /** The adb serial. */
  serial: string;
  /** The AVD, for an emulator. */
  avd?: string;
  /** Driven over the emulator's gRPC API rather than adb. */
  grpc: boolean;
  name: string;
}

/** The last screenshot of each target, by serial: what tap and swipe coordinates refer to. */
interface Geometry {
  width: number;
  height: number;
  /** gRPC: how the frame was rotated. */
  rotation: number;
  /** adb: the screen size in pixels as captured (what `input tap` takes). */
  sourceWidth: number;
  sourceHeight: number;
}
const geometries = new Map<string, Geometry>();

export async function listTargets(): Promise<{ targets: Target[]; avds: string[]; error?: string }> {
  const emulators = runningEmulatorTargets();
  const [devices, overview] = await Promise.all([
    adbPath() ? deviceOverview() : Promise.resolve({ devices: [], error: undefined }),
    emulatorOverview().catch(() => ({ avds: [], error: undefined })),
  ]);
  const targets: Target[] = [
    ...emulators.map((e) => ({ serial: e.serial, avd: e.avd, grpc: e.grpc, name: `${e.avd} (emulator)` })),
    ...devices.devices.filter((d) => d.ready).map((d) => ({ serial: d.serial, grpc: false, name: d.name })),
  ];
  return { targets, avds: overview.avds.filter((a) => a.state === "stopped" || a.state === "crashed").map((a) => a.avd), error: devices.error };
}

/** The device by AVD name or adb serial, or the only one there is. */
async function resolve(device: string | undefined): Promise<Target> {
  const { targets, avds } = await listTargets();
  if (device) {
    const t = targets.find((t) => t.serial === device || t.avd === device);
    if (t) return t;
    if (avds.includes(device)) throw new EmulatorError(409, `${device} isn't running. Start it with android_start_emulator.`);
    throw new EmulatorError(404, `No running emulator or device called ${device}. Running: ${targets.map((t) => t.avd ?? t.serial).join(", ") || "none"}`);
  }
  if (targets.length === 1) return targets[0];
  if (!targets.length)
    throw new EmulatorError(
      409,
      `No emulator or device is running.${avds.length ? ` Start one with android_start_emulator (AVDs: ${avds.join(", ")}).` : ""}`,
    );
  throw new EmulatorError(400, `Several are running; say which with "device": ${targets.map((t) => t.avd ?? t.serial).join(", ")}`);
}

// ── Screen ──────────────────────────────────────────────────────────────────

export async function screenshot(device?: string) {
  const t = await resolve(device);
  if (t.grpc) {
    const shot = await scaledScreenshot(t.avd!, MAX_SIDE, MAX_SIDE);
    geometries.set(t.serial, { width: shot.width, height: shot.height, rotation: shot.rotation, sourceWidth: 0, sourceHeight: 0 });
    return { target: t, png: shot.png, width: shot.width, height: shot.height };
  }
  const raw = await screencapRaw(t.serial);
  const scaled = downscale(raw, MAX_SIDE);
  geometries.set(t.serial, { width: scaled.width, height: scaled.height, rotation: 0, sourceWidth: raw.width, sourceHeight: raw.height });
  return { target: t, png: encodePng(scaled), width: scaled.width, height: scaled.height };
}

async function geometry(t: Target): Promise<Geometry> {
  const g = geometries.get(t.serial);
  if (g) return g;
  await screenshot(t.serial);
  return geometries.get(t.serial)!;
}

/** A path of points in screenshot pixels, the finger down the whole way, then lifted at the end. */
async function touch(device: string | undefined, path: Array<{ x: number; y: number }>, durationMs: number) {
  const t = await resolve(device);
  const g = await geometry(t);
  for (const p of path)
    if (!(p.x >= 0 && p.y >= 0 && p.x < g.width && p.y < g.height))
      throw new EmulatorError(400, `(${p.x}, ${p.y}) is outside the ${g.width}×${g.height} screenshot`);
  if (t.grpc) {
    const steps = Math.max(1, Math.round(durationMs / 16));
    const points: Array<{ x: number; y: number; down: boolean }> = [];
    // A tap (one point) is down then up; a swipe moves through evenly spaced points.
    for (let i = 0; i <= steps; i++) {
      const f = path.length === 1 ? 0 : i / steps;
      const x = path[0].x + (path[path.length - 1].x - path[0].x) * f;
      const y = path[0].y + (path[path.length - 1].y - path[0].y) * f;
      points.push({ x: x / g.width, y: y / g.height, down: true });
    }
    points.push({ ...points[points.length - 1], down: false });
    return touchPath(t.avd!, g.rotation, path.length === 1 ? [points[0], points[points.length - 1]] : points, path.length === 1 ? durationMs : durationMs / steps);
  }
  const px = (p: { x: number; y: number }) => [
    String(Math.round((p.x / g.width) * g.sourceWidth)),
    String(Math.round((p.y / g.height) * g.sourceHeight)),
  ];
  const [a, b] = [path[0], path[path.length - 1]];
  // `input swipe` from a point to itself is a long press.
  await adbShell(t.serial, ["input", "swipe", ...px(a), ...px(b), String(Math.round(durationMs))]);
}

export const tap = (device: string | undefined, x: number, y: number, durationMs = 60) => touch(device, [{ x, y }], durationMs);

export const swipe = (device: string | undefined, from: { x: number; y: number }, to: { x: number; y: number }, durationMs = 300) =>
  touch(device, [from, to], durationMs);

/** Key names Claude can press: the emulator's name and Android's key code for each. */
export const KEYS: Record<string, [string, string]> = {
  back: ["GoBack", "KEYCODE_BACK"],
  home: ["GoHome", "KEYCODE_HOME"],
  recents: ["AppSwitch", "KEYCODE_APP_SWITCH"],
  enter: ["Enter", "KEYCODE_ENTER"],
  backspace: ["Backspace", "KEYCODE_DEL"],
  tab: ["Tab", "KEYCODE_TAB"],
  escape: ["Escape", "KEYCODE_ESCAPE"],
  up: ["ArrowUp", "KEYCODE_DPAD_UP"],
  down: ["ArrowDown", "KEYCODE_DPAD_DOWN"],
  left: ["ArrowLeft", "KEYCODE_DPAD_LEFT"],
  right: ["ArrowRight", "KEYCODE_DPAD_RIGHT"],
  power: ["Power", "KEYCODE_POWER"],
  volume_up: ["AudioVolumeUp", "KEYCODE_VOLUME_UP"],
  volume_down: ["AudioVolumeDown", "KEYCODE_VOLUME_DOWN"],
};

export async function pressKey(device: string | undefined, key: string) {
  const k = KEYS[key];
  if (!k) throw new EmulatorError(400, `Unknown key ${key}. Known: ${Object.keys(KEYS).join(", ")}`);
  const t = await resolve(device);
  if (t.grpc) await keyInput(t.avd!, { key: k[0] });
  else await adbShell(t.serial, ["input", "keyevent", k[1]]);
}

export async function typeText(device: string | undefined, text: string) {
  if (!text) throw new EmulatorError(400, "text is empty");
  const t = await resolve(device);
  if (t.grpc) return keyInput(t.avd!, { text });
  // `input text` only takes ASCII, and reads %s as a space. The device's shell sees the arguments joined up, so the
  // text is single-quoted for it; a quote inside is closed, double-quoted and reopened ('\'' loses its backslash on
  // the way through adb on Windows).
  if (!/^[\x20-\x7e]*$/.test(text)) throw new EmulatorError(400, "This device takes only plain ASCII text through adb");
  await adbShell(t.serial, ["input", "text", `'${text.replace(/ /g, "%s").replace(/'/g, `'"'"'`)}'`]);
}

async function adbShell(serial: string, args: string[]) {
  const res = await run(adbOr409(), ["-s", serial, "shell", ...args]);
  if (res.code !== 0 || /Exception|Error:/.test(res.stderr)) throw new Error((res.stderr || res.stdout).trim() || `adb shell ${args[0]} failed`);
}

// ── Logcat ──────────────────────────────────────────────────────────────────

const FILTER_SPEC = /^[\w.$*-]+:[VDIWEFS]$/i;

export async function logcat(device: string | undefined, opts: { lines?: number; filter?: string; packageName?: string; grep?: string; clear?: boolean }) {
  const t = await resolve(device);
  const adb = adbOr409();
  if (opts.clear) {
    const res = await run(adb, ["-s", t.serial, "logcat", "-c"]);
    if (res.code !== 0) throw new Error(res.stderr.trim() || "adb logcat -c failed");
    return { target: t, text: "Cleared the log." };
  }
  const lines = Math.min(2000, Math.max(1, Math.round(opts.lines ?? 200)));
  const args = ["-s", t.serial, "logcat", "-d", "-v", "threadtime"];
  if (opts.packageName) {
    if (!/^[\w.]+$/.test(opts.packageName)) throw new EmulatorError(400, "Invalid package name");
    const res = await run(adb, ["-s", t.serial, "shell", "pidof", opts.packageName]);
    const pid = res.stdout.trim().split(/\s+/)[0];
    if (!/^\d+$/.test(pid ?? "")) throw new EmulatorError(409, `${opts.packageName} isn't running`);
    args.push(`--pid=${pid}`);
  }
  const specs = (opts.filter ?? "").trim().split(/\s+/).filter(Boolean);
  // -t counts lines before filter specs and --pid apply, so with any filtering read further back for enough matches.
  args.push("-t", String(opts.grep || opts.packageName || specs.length ? 20_000 : lines));
  if (specs.some((s) => !FILTER_SPEC.test(s))) throw new EmulatorError(400, 'filter takes logcat filter specs like "MyTag:D *:E"');
  if (specs.length && !specs.some((s) => s.startsWith("*:"))) specs.push("*:S");
  args.push(...specs);
  const res = await run(adb, args, 30_000);
  if (res.code !== 0) throw new Error(res.stderr.trim() || `adb logcat exited with code ${res.code}`);
  let out = res.stdout.split(/\r?\n/).filter((l) => l && !l.startsWith("--------- beginning of"));
  if (opts.grep) {
    const needle = opts.grep.toLowerCase();
    out = out.filter((l) => l.toLowerCase().includes(needle));
  }
  out = out.slice(-lines);
  let text = out.join("\n");
  // Keeps the result within what Claude Code accepts from a tool.
  if (text.length > 60_000) text = "… (earlier lines cut)\n" + text.slice(-60_000);
  return { target: t, text: text || "No matching log lines." };
}

// ── Emulators ───────────────────────────────────────────────────────────────

/** Starts an AVD and waits (up to `timeoutMs`) until it has booted. */
export async function startAndWait(avd: string, timeoutMs = 180_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const info = (await emulatorOverview()).avds.find((a) => a.avd === avd);
  if (!info) throw new EmulatorError(404, `No AVD named ${avd}`);
  if (info.state !== "running") {
    if (info.state === "stopped" || info.state === "crashed") await startEmulator(avd);
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const now = (await emulatorOverview()).avds.find((a) => a.avd === avd);
      if (now?.state === "running") break;
      if (now?.state === "crashed") throw new Error(`${avd} crashed while starting:\n${now.message ?? ""}`);
      if (now?.state === "stopped") throw new Error(`${avd} stopped while starting`);
      if (Date.now() > deadline) return `${avd} is still ${now?.state ?? "starting"}; check again with android_devices in a bit.`;
    }
  }
  return `${avd} is running.`;
}

// ── Raw screen captures ─────────────────────────────────────────────────────

interface Rgb {
  width: number;
  height: number;
  /** 3 bytes a pixel, rows top to bottom. */
  data: Buffer;
}

/**
 * `screencap` without -p: a 12-byte header (16 from Android 9, with a color space) of width, height and pixel format,
 * then the pixels. Raw, so it can be scaled down here without an image library.
 */
function screencapRaw(serial: string): Promise<Rgb> {
  const adb = adbOr409();
  return new Promise((resolve, reject) => {
    execFile(adb, ["-s", serial, "exec-out", "screencap"], { encoding: "buffer", timeout: 20_000, windowsHide: true, maxBuffer: 128 * 1024 * 1024 }, (err, out, stderr) => {
      if (err || out.length < 12) return reject(new EmulatorError(409, stderr.toString().trim() || err?.message || "screencap failed"));
      const width = out.readUInt32LE(0), height = out.readUInt32LE(4), format = out.readUInt32LE(8);
      // 1 RGBA_8888, 2 RGBX_8888, 3 RGB_888.
      const bpp = format === 1 || format === 2 ? 4 : format === 3 ? 3 : 0;
      const header = out.length - width * height * bpp;
      if (!bpp || (header !== 12 && header !== 16)) return reject(new Error(`Unexpected screencap format ${format} (${width}×${height}, ${out.length} bytes)`));
      const data = Buffer.alloc(width * height * 3);
      for (let i = 0, o = header; i < width * height; i++, o += bpp) out.copy(data, i * 3, o, o + 3);
      resolve({ width, height, data });
    });
  });
}

/** Box-filters the image down to fit `max`×`max`. */
function downscale(img: Rgb, max: number): Rgb {
  const s = Math.min(1, max / img.width, max / img.height);
  if (s === 1) return img;
  const width = Math.max(1, Math.round(img.width * s)), height = Math.max(1, Math.round(img.height * s));
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * img.height) / height), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * img.width) / width), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / width));
      let r = 0, g = 0, b = 0;
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0, o = (sy * img.width + x0) * 3; sx < x1; sx++, o += 3) {
          r += img.data[o];
          g += img.data[o + 1];
          b += img.data[o + 2];
        }
      const n = (y1 - y0) * (x1 - x0), o = (y * width + x) * 3;
      data[o] = r / n;
      data[o + 1] = g / n;
      data[o + 2] = b / n;
    }
  }
  return { width, height, data };
}

function encodePng(img: Rgb): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  // Each row starts with filter type 0 (none).
  const stride = img.width * 3;
  const rows = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) img.data.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
