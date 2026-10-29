// Mirrors physical Android devices (USB or Wi-Fi adb) in the Android tab, the way scrcpy does it: scrcpy's server jar
// is pushed to the device and run with app_process, it encodes the screen as H.264 and streams it over an adb forward
// tunnel, and the page decodes it with WebCodecs. Touches and keys go back over a second socket in scrcpy's control
// protocol. The protocol is internal to scrcpy and changes between versions (the server refuses a client of another
// version), so the jar is pinned: downloaded once from scrcpy's GitHub release and checked against its SHA-256.
// See doc/develop.md in the scrcpy repository (v5.0.1) for the wire format used below.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { dataDir } from "../db.ts";
import { EmulatorError, adbLogcatStream, adbOr409, adbPath, run } from "./emulator.ts";
import type { ScreenInput } from "./emulator.ts";
import type { DeviceInfo, DeviceOverview } from "../types.ts";

/** adb serials: USB ids, `host:port`, mDNS names (`adb-R58M-x._adb-tls-connect._tcp`) and `emulator-5554`. */
export const SERIAL = /^[\w.:-]+$/;
/** What `adb connect` and `adb pair` take: a host name or IPv4 address and a port. */
const ADDRESS = /^[\w.-]+:\d{1,5}$/;

const VERSION = "5.0.1";
const SHA256 = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";
const RELEASE_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`;
const DEVICE_JAR = "/data/local/tmp/scrcpy-server-dashboard.jar";
/** Longest side of the video. The page scales it to fit; this keeps the encoder's work and the bit rate down. */
const MAX_SIZE = 1920;

// ── Devices ─────────────────────────────────────────────────────────────────

const HINTS: Record<string, string> = {
  unauthorized: "Allow USB debugging in the prompt on the device's screen.",
  offline: "adb sees the device but can't talk to it. Unplug it and plug it back in, or reconnect over Wi-Fi.",
  "no permissions": "adb isn't allowed to open the USB device. Add a udev rule for it (see Android's \"Run apps on a hardware device\").",
  authorizing: "Waiting for the device to accept this computer…",
  connecting: "Connecting…",
};

/** Parses `adb devices -l`. The SDK's emulators are left out: the emulator path shows those. */
function parseDevices(out: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    // `serial  state  usb:1-1 product:x model:Pixel_8 device:shiba transport_id:1`; state can be "no permissions (…)".
    const m = /^(\S+)\s+(no permissions|\S+)(.*)$/.exec(line.trim());
    if (!m || line.startsWith("List of devices") || line.startsWith("*")) continue;
    const [, serial, state, rest] = m;
    if (/^emulator-\d+$/.test(serial) || !SERIAL.test(serial)) continue;
    const model = /\bmodel:(\S+)/.exec(rest)?.[1];
    devices.push({
      serial,
      state,
      name: model ? model.replace(/_/g, " ") : serial,
      transport: serial.includes(":") || serial.includes("._adb-tls-") ? "wifi" : "usb",
      ready: state === "device",
      message: state === "device" ? undefined : (HINTS[state] ?? `adb reports it as ${state}.`),
    });
  }
  return devices;
}

export async function deviceOverview(): Promise<DeviceOverview> {
  const adb = adbPath();
  if (!adb) return { error: "adb not found. Install the Android SDK's platform tools, or set ANDROID_HOME.", devices: [] };
  const res = await run(adb, ["devices", "-l"]);
  if (res.code !== 0) return { error: res.stderr.trim() || `adb devices exited with code ${res.code}`, devices: [] };
  return { devices: parseDevices(res.stdout) };
}

/**
 * `adb connect host:port`, or with a pairing code `adb pair host:port code` (Android 11+'s Wireless debugging, which
 * pairs on one port and then connects on another; paired devices usually connect by themselves over mDNS).
 */
export async function connectDevice(address: string, code?: string): Promise<string> {
  if (!ADDRESS.test(address)) throw new EmulatorError(400, "Give the address as host:port, as shown under Wireless debugging");
  if (code !== undefined && !/^\d{6}$/.test(code)) throw new EmulatorError(400, "The pairing code is six digits");
  const res = await run(adbOr409(), code ? ["pair", address, code] : ["connect", address], 30_000);
  const out = (res.stdout + res.stderr).trim();
  // adb connect exits 0 even when it fails, so go by what it says.
  const ok = code ? /Successfully paired/i.test(out) : /^(connected|already connected)/im.test(out);
  if (!ok) throw new EmulatorError(409, out || `adb ${code ? "pair" : "connect"} failed`);
  return out;
}

export async function disconnectDevice(serial: string): Promise<void> {
  const res = await run(adbOr409(), ["disconnect", serial]);
  if (res.code !== 0) throw new EmulatorError(409, (res.stdout + res.stderr).trim() || "adb disconnect failed");
}

export function deviceLogcat(serial: string): ReadableStream<Uint8Array> {
  return adbLogcatStream(adbOr409(), serial);
}

export function deviceScreenshot(serial: string): Promise<Buffer> {
  const adb = adbOr409();
  return new Promise((resolve, reject) => {
    execFile(adb, ["-s", serial, "exec-out", "screencap", "-p"], { encoding: "buffer", timeout: 20_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      // A PNG starts with 0x89 "PNG".
      if (!err && stdout.length > 8 && stdout[1] === 0x50) resolve(stdout);
      else reject(new EmulatorError(409, stderr.toString().trim() || err?.message || "screencap failed"));
    });
  });
}

// ── Server jar ──────────────────────────────────────────────────────────────

let jarPromise: Promise<string> | undefined;

/** The pinned scrcpy server, downloaded on first use into data/scrcpy. */
function serverJar(): Promise<string> {
  jarPromise ??= (async () => {
    const dir = path.join(dataDir, "scrcpy");
    const file = path.join(dir, `scrcpy-server-v${VERSION}`);
    const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
    if (fs.existsSync(file) && sha(fs.readFileSync(file)) === SHA256) return file;
    let res: Response;
    try {
      res = await fetch(RELEASE_URL, { signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new Error(`Couldn't download scrcpy's server (${RELEASE_URL}): ${(e as Error).message}`);
    }
    if (!res.ok) throw new Error(`Couldn't download scrcpy's server: ${RELEASE_URL} answered ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    if (sha(body) !== SHA256) throw new Error("The downloaded scrcpy server doesn't match its published SHA-256, so it wasn't used");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.part`, body);
    fs.renameSync(`${file}.part`, file);
    return file;
  })();
  // Try again next time after a failure (offline, say).
  jarPromise.catch(() => (jarPromise = undefined));
  return jarPromise;
}

// ── Mirroring ───────────────────────────────────────────────────────────────

/** Bytes arriving on a socket, read in whole messages. */
class Incoming {
  private chunks: Buffer[] = [];
  length = 0;
  push(b: Buffer) {
    this.chunks.push(b);
    this.length += b.length;
  }
  /** The first `n` bytes without consuming them, once they've all arrived. */
  peek(n: number): Buffer | undefined {
    if (this.length < n) return undefined;
    if (this.chunks[0].length < n) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0].subarray(0, n);
  }
  skip(n: number) {
    this.length -= n;
    while (n > 0) {
      const head = this.chunks[0];
      if (head.length <= n) {
        n -= head.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(n);
        n = 0;
      }
    }
  }
}

const H264 = 0x68323634;
// Control message types (server/src/main/java/com/genymobile/scrcpy/control/ControlMessage.java).
const MSG_KEYCODE = 0, MSG_TEXT = 1, MSG_TOUCH = 2, MSG_SCROLL = 3, MSG_ROTATE = 11, MSG_RESET_VIDEO = 17;
// MotionEvent and KeyEvent actions.
const DOWN = 0, UP = 1, MOVE = 2;
/** scrcpy's id for a touch from the client that isn't a mouse (so Android sees a finger). */
const GENERIC_FINGER = -2n;

/** The key names the Android tab sends (the emulator's, and the browser's `KeyboardEvent.key`) as Android keycodes. */
const KEYCODES: Record<string, number> = {
  GoHome: 3,
  GoBack: 4,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  AudioVolumeUp: 24,
  AudioVolumeDown: 25,
  Power: 26,
  Tab: 61,
  Enter: 66,
  Backspace: 67,
  PageUp: 92,
  PageDown: 93,
  Escape: 111,
  Delete: 112,
  Home: 122,
  End: 123,
  AppSwitch: 187,
};

/** The last lines of the server's output that say what went wrong. */
function serverError(log: string): string | undefined {
  const lines = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => /ERROR|Exception|Aborted|not found|denied/i.test(l));
  return (bad.length ? bad : lines).slice(-4).join("\n") || undefined;
}

/**
 * Connects to the server through the forward tunnel. Until the server listens, adb accepts the connection and closes
 * it straight away, so wait for the dummy byte the server sends first and retry until it comes.
 */
async function connectVideo(port: number, gone: () => boolean): Promise<{ socket: net.Socket; rest: Buffer }> {
  for (let attempt = 0; attempt < 100 && !gone(); attempt++) {
    const got = await new Promise<{ socket: net.Socket; rest: Buffer } | undefined>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      const fail = () => {
        socket.destroy();
        resolve(undefined);
      };
      socket.once("error", fail);
      socket.once("close", fail);
      socket.once("data", (chunk: Buffer) => {
        socket.pause();
        socket.removeListener("error", fail);
        socket.removeListener("close", fail);
        resolve({ socket, rest: chunk.subarray(1) });
      });
    });
    if (got) return got;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("scrcpy's server didn't start on the device");
}

function connectControl(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.removeListener("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/**
 * One viewer of a device's screen, with its own scrcpy server (several can run on a device at once). `send` gets a
 * JSON `{ "type": "hello", "name", "codec": "h264" }` first, then each of scrcpy's video packets as a binary message,
 * unchanged: 12-byte session packets (`[0x80…][width u32][height u32]`, on start and on each rotation) and media
 * packets (`[flags + PTS u64][size u32]` then the H.264 data in Annex B; config packets hold the SPS and PPS).
 * Input is the same as for the emulator's screen, plus `{ "type": "rotate" }` and `{ "type": "reset" }` (asks for a
 * new key frame, after a decoder error).
 */
export function openDeviceScreen(
  serial: string,
  send: (msg: Uint8Array<ArrayBuffer> | string) => void,
  onError: (message: string) => void,
) {
  if (!SERIAL.test(serial)) throw new EmulatorError(400, "Invalid device serial");
  const adb = adbOr409();
  let closed = false;
  let server: ChildProcess | undefined;
  let video: net.Socket | undefined;
  let control: net.Socket | undefined;
  let port: number | undefined;
  let log = "";
  /** The video's size: touch positions are given in it, and the server ignores ones for another size. */
  let size: { width: number; height: number } | undefined;
  let touching = false;

  const close = () => {
    if (closed) return;
    closed = true;
    video?.destroy();
    control?.destroy();
    // The server stops by itself once its sockets close; this ends the adb shell running it.
    server?.kill();
    if (port) void run(adb, ["-s", serial, "forward", "--remove", `tcp:${port}`]);
  };
  const fail = (message: string) => {
    if (closed) return;
    onError(message);
    close();
  };

  const readVideo = (socket: net.Socket, first: Buffer) => {
    const inc = new Incoming();
    let stage: "meta" | "codec" | "packets" = "meta";
    const parse = () => {
      for (;;) {
        if (stage === "meta") {
          const meta = inc.peek(64);
          if (!meta) return;
          const name = meta.subarray(0, Math.max(0, meta.indexOf(0))).toString("utf8");
          inc.skip(64);
          send(JSON.stringify({ type: "hello", name, codec: "h264" }));
          stage = "codec";
        } else if (stage === "codec") {
          const id = inc.peek(4);
          if (!id) return;
          const codec = id.readUInt32BE(0);
          inc.skip(4);
          // 0 and 1 mean the device couldn't start the stream; the server's output says why.
          if (codec !== H264) return fail(serverError(log) ?? "The device couldn't start encoding its screen");
          stage = "packets";
        } else {
          const header = inc.peek(12);
          if (!header) return;
          if (header[0] & 0x80) {
            size = { width: header.readUInt32BE(4), height: header.readUInt32BE(8) };
            send(new Uint8Array(header));
            inc.skip(12);
            continue;
          }
          const total = 12 + header.readUInt32BE(8);
          const packet = inc.peek(total);
          if (!packet) return;
          send(new Uint8Array(packet));
          inc.skip(total);
        }
      }
    };
    socket.on("data", (chunk: Buffer) => {
      inc.push(chunk);
      parse();
    });
    socket.on("close", () => fail(serverError(log) ?? "The device stopped sending its screen (unplugged?)"));
    socket.on("error", () => {});
    if (first.length) inc.push(first);
    parse();
    socket.resume();
  };

  const start = async () => {
    const jar = await serverJar();
    if (closed) return;
    const push = await run(adb, ["-s", serial, "push", jar, DEVICE_JAR], 60_000);
    if (push.code !== 0) throw new Error((push.stdout + push.stderr).trim() || "adb push failed");
    if (closed) return;
    // A random id, so several viewers (or a real scrcpy) on the same device don't collide.
    const scid = crypto.randomInt(0, 0x7fffffff).toString(16).padStart(8, "0");
    // tcp:0 lets adb pick a free port and print it.
    const fwd = await run(adb, ["-s", serial, "forward", "tcp:0", `localabstract:scrcpy_${scid}`]);
    port = Number(fwd.stdout.trim());
    if (fwd.code !== 0 || !port) throw new Error((fwd.stdout + fwd.stderr).trim() || "adb forward failed");
    if (closed) {
      void run(adb, ["-s", serial, "forward", "--remove", `tcp:${port}`]);
      return;
    }
    const args = [
      `CLASSPATH=${DEVICE_JAR}`,
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      VERSION,
      `scid=${scid}`,
      "log_level=info",
      "tunnel_forward=true",
      "audio=false",
      "video_codec=h264",
      `max_size=${MAX_SIZE}`,
      // Device messages would only be clipboard changes; nothing here reads them.
      "clipboard_autosync=false",
    ];
    server = spawn(adb, ["-s", serial, "shell", ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (b: Buffer) => (log = (log + b.toString()).slice(-8000));
    server.stdout!.on("data", collect);
    server.stderr!.on("data", collect);
    server.once("error", (e) => fail(`Couldn't run adb: ${e.message}`));
    server.once("exit", (code) => fail(serverError(log) ?? `scrcpy's server exited with code ${code}`));

    const v = await connectVideo(port, () => closed);
    if (closed) return v.socket.destroy();
    video = v.socket;
    const c = await connectControl(port);
    if (closed) return c.destroy();
    control = c;
    // Device messages (clipboard, acks) aren't used, but must be read so the server never blocks writing them.
    control.on("data", () => {});
    control.on("error", () => {});
    readVideo(video, v.rest);
  };
  // A server that exited has already reported why.
  start().catch((e: Error) => fail(e.message));

  const write = (b: Buffer) => {
    if (control && !control.destroyed) control.write(b);
  };
  const position = (b: Buffer, at: number, x: number, y: number) => {
    const { width, height } = size!;
    b.writeInt32BE(Math.round(Math.min(1, Math.max(0, x)) * (width - 1)), at);
    b.writeInt32BE(Math.round(Math.min(1, Math.max(0, y)) * (height - 1)), at + 4);
    b.writeUInt16BE(width, at + 8);
    b.writeUInt16BE(height, at + 10);
  };
  const touch = (action: number, x: number, y: number) => {
    if (!size) return;
    const b = Buffer.alloc(32);
    b[0] = MSG_TOUCH;
    b[1] = action;
    b.writeBigInt64BE(GENERIC_FINGER, 2);
    position(b, 10, x, y);
    b.writeUInt16BE(action === UP ? 0 : 0xffff, 22); // Pressure, 0–1 in 16-bit fixed point.
    // Action button and buttons (bytes 24–31) stay 0 for a finger.
    write(b);
  };
  const key = (action: number, keycode: number) => {
    const b = Buffer.alloc(14);
    b[0] = MSG_KEYCODE;
    b[1] = action;
    b.writeInt32BE(keycode, 2);
    // Repeat count and meta state stay 0.
    write(b);
  };

  return {
    input(msg: ScreenInput | { type: "rotate" } | { type: "reset" }) {
      if (closed) return;
      switch (msg.type) {
        case "touch": {
          const action = !msg.down ? UP : touching ? MOVE : DOWN;
          if (action === UP && !touching) return;
          touching = msg.down;
          touch(action, msg.x, msg.y);
          break;
        }
        case "key": {
          const code = KEYCODES[msg.key];
          if (code === undefined) return;
          if (msg.eventType !== "keyup") key(DOWN, code);
          if (msg.eventType !== "keydown") key(UP, code);
          break;
        }
        case "text": {
          // The server takes at most 300 bytes of text per message.
          const text = Buffer.from(msg.text.slice(0, 100), "utf8");
          if (!text.length) return;
          const b = Buffer.alloc(5 + text.length);
          b[0] = MSG_TEXT;
          b.writeUInt32BE(text.length, 1);
          text.copy(b, 5);
          write(b);
          break;
        }
        case "wheel": {
          // Real devices take scroll events (the emulator needs a drag instead). In wheel notches, ±16, positive is up;
          // sent as 16-bit fixed point over that range.
          if (!size || !msg.dy) return;
          const notches = Math.max(-16, Math.min(16, -msg.dy * 8));
          const b = Buffer.alloc(21);
          b[0] = MSG_SCROLL;
          position(b, 1, msg.x, msg.y);
          b.writeInt16BE(0, 13);
          b.writeInt16BE(Math.max(-0x8000, Math.min(0x7fff, Math.round((notches / 16) * 0x8000))), 15);
          write(b);
          break;
        }
        case "rotate":
          write(Buffer.from([MSG_ROTATE]));
          break;
        case "reset":
          write(Buffer.from([MSG_RESET_VIDEO]));
          break;
        // "size": the page scales the video itself.
      }
    },
    close,
  };
}
