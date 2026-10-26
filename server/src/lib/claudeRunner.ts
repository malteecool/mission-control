// Runs one chat turn through Claude Code's headless mode and normalises its stream-json output.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { ChatEvent, PermissionMode, PermissionReply } from "../types.ts";
import { toolResultText, toolSummary } from "./claudeSessions.ts";

export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

let resolved: { command: string; shell: boolean } | undefined;

/**
 * On Windows `claude` is usually a .cmd shim, which Node can only spawn through a shell.
 * Prefer the real claude.exe the shim points at; fall back to the shim via the shell.
 */
function claudeCommand(): { command: string; shell: boolean } {
  if (resolved) return resolved;
  if (process.env.CLAUDE_BIN) return (resolved = { command: process.env.CLAUDE_BIN, shell: false });
  if (process.platform !== "win32") return (resolved = { command: "claude", shell: false });

  let candidates: string[] = [];
  try {
    candidates = execFileSync("where", ["claude"], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    /* not on PATH */
  }
  for (const c of candidates) {
    if (c.toLowerCase().endsWith(".exe")) return (resolved = { command: c, shell: false });
    const exe = path.join(path.dirname(c), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (fs.existsSync(exe)) return (resolved = { command: exe, shell: false });
  }
  return (resolved = { command: "claude", shell: true });
}

interface PendingPermission {
  input: unknown;
  suggestions?: unknown[];
}

interface Run {
  child: ChildProcess;
  stopped: boolean;
  pending: Map<string, PendingPermission>;
  send: (ev: ChatEvent) => void;
}
const runs = new Map<string, Run>();

export function stopRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run) return false;
  run.stopped = true;
  run.child.kill();
  return true;
}

function writeLine(child: ChildProcess, msg: unknown) {
  if (child.stdin?.writable) child.stdin.write(JSON.stringify(msg) + "\n");
}

/** Sends the user's decision back to Claude Code. Returns false if the request is no longer pending. */
export function answerPermission(runId: string, reply: PermissionReply): boolean {
  const run = runs.get(runId);
  const req = run?.pending.get(reply.requestId);
  if (!run || !req) return false;
  run.pending.delete(reply.requestId);
  const response = reply.allow
    ? {
        behavior: "allow",
        // AskUserQuestion reads the user's choices from `answers` in its (updated) input.
        updatedInput: reply.answers ? { ...(req.input as object), answers: reply.answers } : req.input,
        ...(reply.always && req.suggestions?.length ? { updatedPermissions: req.suggestions } : {}),
      }
    : { behavior: "deny", message: reply.message?.trim() || "The user denied this tool call from the dashboard." };
  writeLine(run.child, {
    type: "control_response",
    response: { subtype: "success", request_id: reply.requestId, response },
  });
  run.send({ type: "permission_resolved", requestId: reply.requestId });
  return true;
}

export interface RunOptions {
  cwd: string;
  prompt: string;
  sessionId?: string;
  model?: string;
  permissionMode: PermissionMode;
}

/** Starts a turn and returns an NDJSON stream of ChatEvents. Cancelling the stream kills the process. */
export function startRun(opts: RunOptions): ReadableStream<Uint8Array> {
  const runId = randomUUID();
  const encoder = new TextEncoder();
  let child: ChildProcess;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (ev: ChatEvent) => {
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        runs.delete(runId);
        controller.close();
      };

      // stream-json input keeps stdin open as a control channel: with `--permission-prompt-tool stdio`
      // Claude Code sends a can_use_tool control_request for every call that needs approval and waits
      // for our control_response.
      const args = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
        opts.permissionMode,
      ];
      if (opts.sessionId) args.push("--resume", opts.sessionId);
      if (opts.model) args.push("--model", opts.model);

      // Don't let the child think it is nested inside another Claude Code session.
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;

      const { command, shell } = claudeCommand();
      child = spawn(command, args, { cwd: opts.cwd, env, shell, windowsHide: true });
      const run: Run = { child, stopped: false, pending: new Map(), send };
      runs.set(runId, run);
      send({ type: "run", runId });

      // The prompt goes over stdin so it never needs shell escaping.
      writeLine(child, {
        type: "user",
        session_id: "",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: opts.prompt }] },
      });

      let stderr = "";
      let sawResult = false;
      child.stderr!.on("data", (d) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });

      const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          return;
        }
        if (e.type === "control_request") return handleControlRequest(run, e);
        if (e.type === "control_cancel_request") {
          // Claude Code gave up on a request (e.g. the turn was interrupted); drop the prompt from the UI.
          if (run.pending.delete(e.request_id)) send({ type: "permission_resolved", requestId: e.request_id });
          return;
        }
        if (e.type === "result") {
          sawResult = true;
          // In stream-json input mode the CLI waits for another message after each turn;
          // closing stdin is what lets it exit.
          child.stdin?.end();
        }
        for (const ev of normalise(e)) send(ev);
      });

      child.on("error", (err) => {
        send({ type: "error", message: `Could not start Claude Code (${command}): ${err.message}` });
        close();
      });
      child.on("close", (code) => {
        // Let readline flush the last lines before we close the stream.
        setImmediate(() => {
          if (run.stopped && !sawResult) send({ type: "error", message: "Stopped" });
          else if (!sawResult)
            send({ type: "error", message: `Claude Code exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}` });
          close();
        });
      });
    },
    cancel() {
      child?.kill();
      runs.delete(runId);
    },
  });
}

function handleControlRequest(run: Run, e: any) {
  const req = e.request ?? {};
  if (req.subtype !== "can_use_tool") {
    // Anything else (hook callbacks, MCP messages) isn't something the dashboard registers for;
    // answer with an error so the CLI doesn't wait on it forever.
    writeLine(run.child, {
      type: "control_response",
      response: { subtype: "error", request_id: e.request_id, error: `Unsupported control request: ${req.subtype}` },
    });
    return;
  }
  const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : undefined;
  run.pending.set(e.request_id, { input: req.input, suggestions });
  run.send({
    type: "permission",
    request: {
      requestId: e.request_id,
      toolName: req.tool_name,
      toolUseId: req.tool_use_id,
      summary: req.description || toolSummary(req.tool_name, req.input),
      input: req.input,
      canAlways: !!suggestions?.length,
    },
  });
}

function normalise(e: any): ChatEvent[] {
  // Messages from subagents carry a parent_tool_use_id; the main transcript only shows their tool call.
  if (e.parent_tool_use_id) return [];

  switch (e.type) {
    case "system":
      if (e.subtype === "init") return [{ type: "init", sessionId: e.session_id, model: e.model, cwd: e.cwd }];
      if (e.subtype === "compact_boundary")
        return [{ type: "item", item: { kind: "system", id: randomUUID(), text: "Conversation compacted" } }];
      return [];

    case "stream_event": {
      const ev = e.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta")
        return [{ type: "delta", text: ev.delta.text }];
      return [];
    }

    case "assistant": {
      const out: ChatEvent[] = [];
      for (const [i, b] of (e.message?.content ?? []).entries()) {
        if (b.type === "text" && b.text?.trim())
          out.push({ type: "item", item: { kind: "assistant", id: `${e.message.id}:${i}`, text: b.text } });
        else if (b.type === "tool_use")
          out.push({
            type: "item",
            item: { kind: "tool", id: b.id, name: b.name, summary: toolSummary(b.name, b.input), input: b.input },
          });
      }
      return out;
    }

    case "user": {
      const content = e.message?.content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((b: any) => b?.type === "tool_result")
        .map((b: any) => ({
          type: "tool_result" as const,
          toolUseId: b.tool_use_id,
          result: toolResultText(b.content),
          isError: !!b.is_error,
        }));
    }

    case "result":
      return [
        {
          type: "done",
          sessionId: e.session_id,
          isError: !!e.is_error,
          costUsd: e.total_cost_usd,
          durationMs: e.duration_ms,
          numTurns: e.num_turns,
          permissionDenials: (e.permission_denials ?? []).map(
            (d: any) => `${d.tool_name}${d.tool_input ? `: ${toolSummary(d.tool_name, d.tool_input)}` : ""}`,
          ),
          text: e.is_error ? (e.result ?? e.subtype) : undefined,
        },
      ];

    default:
      return [];
  }
}
