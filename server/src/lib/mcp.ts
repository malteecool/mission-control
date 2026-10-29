// An MCP server inside the dashboard, over MCP's Streamable HTTP transport (stateless: one JSON reply per POST, no
// SSE), handed to every Claude session it starts through --mcp-config. Its tools let Claude see and drive an Android
// emulator or device (androidControl.ts), so it can try the app UI it just changed.
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../db.ts";
import { EmulatorError, adbPath } from "./emulator.ts";
import { KEYS, listTargets, logcat, pressKey, screenshot, startAndWait, swipe, tap, typeText } from "./androidControl.ts";

// Not plain PORT: dev tools often set that for the web app, which would make both servers fight over one port.
export const API_PORT = Number(process.env.DASHBOARD_API_PORT ?? 4317);

/** The server's name in Claude Code, so its tools are `mcp__dashboard__android_tap` and so on. */
const SERVER = "dashboard";

/** Tools that only look, which sessions may use without asking. */
const READ_ONLY = ["android_devices", "android_screenshot", "android_logcat"];

/**
 * The --mcp-config file for a Claude session, and the tools it may use without asking. Undefined without adb: then
 * there's nothing the tools could reach.
 */
export function mcpLaunchArgs(): string[] {
  if (!adbPath()) return [];
  const file = path.join(dataDir, "mcp.json");
  const config = JSON.stringify(
    // The header is what the API's guard asks of every non-GET call (index.ts).
    { mcpServers: { [SERVER]: { type: "http", url: `http://127.0.0.1:${API_PORT}/api/mcp`, headers: { "x-dashboard": "1" } } } },
    null,
    2,
  );
  if (fs.readFileSync(file, { encoding: "utf8", flag: "a+" }) !== config) fs.writeFileSync(file, config);
  return ["--mcp-config", file, "--allowedTools", READ_ONLY.map((t) => `mcp__${SERVER}__${t}`).join(",")];
}

// ── Tools ───────────────────────────────────────────────────────────────────

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface Tool {
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  run: (args: Record<string, any>) => Promise<Content[] | string>;
}

const device = {
  type: "string",
  description: "The emulator's AVD name or the device's adb serial (see android_devices). Optional when only one is running.",
};
const coord = (what: string) => ({ type: "number", description: `${what}, in pixels of the latest android_screenshot` });

const TOOLS: Record<string, Tool> = {
  android_devices: {
    description: "Lists the running Android emulators and connected devices these tools can drive, and the emulators (AVDs) that could be started.",
    properties: {},
    async run() {
      const { targets, avds, error } = await listTargets();
      const lines = targets.map((t) => `- ${t.avd ?? t.serial}: ${t.name}, adb serial ${t.serial}`);
      return [
        targets.length ? `Running:\n${lines.join("\n")}` : "Nothing is running.",
        avds.length ? `Emulators that can be started (android_start_emulator): ${avds.join(", ")}` : "",
        error ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  },
  android_start_emulator: {
    description: "Starts an Android emulator (AVD) headless, the same way the dashboard's Android tab does, and waits until it has booted.",
    properties: { avd: { type: "string", description: "The AVD name, from android_devices" } },
    required: ["avd"],
    run: (a) => startAndWait(String(a.avd)),
  },
  android_screenshot: {
    description:
      "Takes a screenshot of the emulator or device screen. Tap and swipe coordinates are in this image's pixels, so take a new one after the screen rotates.",
    properties: { device },
    async run(a) {
      const shot = await screenshot(a.device);
      return [
        { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
        { type: "text", text: `${shot.target.avd ?? shot.target.serial}: ${shot.width}×${shot.height} pixels` },
      ];
    },
  },
  android_tap: {
    description: "Taps the screen at a point of the latest screenshot. Give duration_ms (e.g. 800) for a long press.",
    properties: { device, x: coord("Across"), y: coord("Down"), duration_ms: { type: "number", description: "How long to hold, default 60" } },
    required: ["x", "y"],
    async run(a) {
      await tap(a.device, Number(a.x), Number(a.y), clampMs(a.duration_ms, 60));
      return "Tapped. Take a screenshot to see the result.";
    },
  },
  android_swipe: {
    description: "Drags a finger across the screen, e.g. to scroll (content follows the finger: swipe up to scroll down).",
    properties: {
      device,
      x1: coord("Start, across"),
      y1: coord("Start, down"),
      x2: coord("End, across"),
      y2: coord("End, down"),
      duration_ms: { type: "number", description: "How long the drag takes, default 300" },
    },
    required: ["x1", "y1", "x2", "y2"],
    async run(a) {
      await swipe(a.device, { x: Number(a.x1), y: Number(a.y1) }, { x: Number(a.x2), y: Number(a.y2) }, clampMs(a.duration_ms, 300));
      return "Swiped. Take a screenshot to see the result.";
    },
  },
  android_type: {
    description: "Types text into the focused field (tap the field first).",
    properties: { device, text: { type: "string" } },
    required: ["text"],
    async run(a) {
      await typeText(a.device, String(a.text ?? ""));
      return "Typed.";
    },
  },
  android_key: {
    description: "Presses a key, e.g. back, home or enter.",
    properties: { device, key: { type: "string", enum: Object.keys(KEYS) } },
    required: ["key"],
    async run(a) {
      await pressKey(a.device, String(a.key));
      return `Pressed ${a.key}.`;
    },
  },
  android_logcat: {
    description:
      "Reads the device log (adb logcat -d, threadtime format): the latest lines, optionally only one app's, by tag/priority or containing some text. clear: true empties the log instead, to read only what an action logs next.",
    properties: {
      device,
      lines: { type: "number", description: "How many of the latest lines, default 200, at most 2000" },
      package: { type: "string", description: "Only lines from this app's running process, e.g. com.example.app" },
      filter: { type: "string", description: 'logcat filter specs, e.g. "MyTag:D AndroidRuntime:E" (everything else is silenced) or "*:E"' },
      grep: { type: "string", description: "Only lines containing this text (case-insensitive)" },
      clear: { type: "boolean" },
    },
    async run(a) {
      const res = await logcat(a.device, {
        lines: a.lines === undefined ? undefined : Number(a.lines),
        packageName: a.package,
        filter: a.filter,
        grep: a.grep,
        clear: !!a.clear,
      });
      return res.text;
    },
  },
};

const clampMs = (v: unknown, fallback: number) => (typeof v === "number" && v > 0 ? Math.min(v, 10_000) : fallback);

// ── JSON-RPC ────────────────────────────────────────────────────────────────

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

const instructions =
  "Tools to see and drive the Android emulator or device the dashboard shows in its Android tab: take a screenshot, " +
  "tap/swipe/type/press keys at screenshot coordinates, and read logcat. Use them to check the app's UI after changing it " +
  "(build and install it first, e.g. with Gradle's installDebug).";

async function handle(req: Request): Promise<unknown> {
  switch (req.method) {
    case "initialize": {
      const asked = req.params?.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "project-dashboard", version: "1.0.0" },
        instructions,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: { type: "object", properties: t.properties, required: t.required ?? [] },
          annotations: { readOnlyHint: READ_ONLY.includes(name) },
        })),
      };
    case "tools/call": {
      const tool = TOOLS[req.params?.name];
      if (!tool) throw new RpcError(-32602, `Unknown tool ${req.params?.name}`);
      try {
        const out = await tool.run(req.params?.arguments ?? {});
        return { content: typeof out === "string" ? [{ type: "text", text: out }] : out };
      } catch (err) {
        // Tool failures go back to Claude as results it can act on, not as protocol errors.
        if (!(err instanceof EmulatorError)) console.error(`MCP ${req.params?.name}:`, err);
        return { content: [{ type: "text", text: (err as Error).message || String(err) }], isError: true };
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${req.method}`);
  }
}

class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

async function reply(req: Request) {
  try {
    return { jsonrpc: "2.0", id: req.id, result: await handle(req) };
  } catch (err) {
    return { jsonrpc: "2.0", id: req.id, error: { code: err instanceof RpcError ? err.code : -32603, message: (err as Error).message } };
  }
}

/** Handles a POST body: one message or a batch. Undefined when there's nothing to answer (replied to with 202). */
export async function mcpPost(body: unknown): Promise<unknown> {
  const messages = Array.isArray(body) ? body : [body];
  if (!messages.length || !messages.every((m) => m && typeof m === "object"))
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  // Notifications (no id) and responses (no method; we send no requests) need no answer.
  const requests = messages.filter((m): m is Request => typeof m.method === "string" && m.id !== undefined);
  if (!requests.length) return undefined;
  const replies = await Promise.all(requests.map(reply));
  return Array.isArray(body) ? replies : replies[0];
}
