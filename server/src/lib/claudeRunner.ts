// Runs one Claude Code process in headless mode and normalises its stream-json output into ChatEvents.
// Who listens to those events (chat UI, task automation) is the run manager's business (runs.ts).
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { ChatEvent, ClaudeInfo, PermissionMode, PermissionReply } from "../types.ts";
import { toolResultImages, toolResultText, toolSummary } from "./claudeSessions.ts";
import { getSettings } from "./settings.ts";
import { mcpLaunchArgs } from "./mcp.ts";

export { PERMISSION_MODES } from "./settings.ts";

let resolved: { command: string; shell: boolean } | undefined;
let resolvedFor: string | undefined;

/**
 * On Windows `claude` is usually a .cmd shim, which Node can only spawn through a shell.
 * Prefer the real claude.exe the shim points at; fall back to the shim via the shell.
 */
function claudeCommand(): { command: string; shell: boolean } {
  // The path set on the settings page wins, then CLAUDE_BIN, then whatever is on PATH.
  const configured = getSettings().claudePath;
  if (resolved && resolvedFor === configured) return resolved;
  resolvedFor = configured;
  if (configured) return (resolved = { command: configured, shell: /\.(cmd|bat)$/i.test(configured) });
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

/** Which claude the dashboard will run, and its version, so the settings page can show whether it works. */
export function claudeInfo(): ClaudeInfo {
  const { command, shell } = claudeCommand();
  try {
    const out = execFileSync(shell ? `"${command}"` : command, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      shell,
    });
    return { command, version: out.trim().split(/\r?\n/)[0] };
  } catch (err) {
    return { command, error: (err as Error).message.split(/\r?\n/)[0] };
  }
}

interface PendingPermission {
  input: unknown;
  suggestions?: unknown[];
}

interface Proc {
  child: ChildProcess;
  stopped: boolean;
  pending: Map<string, PendingPermission>;
  permissionMode: PermissionMode;
  emit: (ev: ChatEvent) => void;
  onPlan?: (plan: string) => void;
  readOnly?: boolean;
}
const procs = new Map<string, Proc>();

// Don't leave Claude processes running (and editing files) after the dashboard server goes away.
function killAll() {
  for (const p of procs.values()) p.child.kill();
}
process.on("exit", killAll);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    killAll();
    process.exit(0);
  });

export function stopProcess(runId: string): boolean {
  const p = procs.get(runId);
  if (!p) return false;
  p.stopped = true;
  p.child.kill();
  return true;
}

function writeLine(child: ChildProcess, msg: unknown) {
  if (child.stdin?.writable) child.stdin.write(JSON.stringify(msg) + "\n");
}

/** Sends the user's decision back to Claude Code. Returns false if the request is no longer pending. */
export function answerPermission(runId: string, reply: PermissionReply): boolean {
  const p = procs.get(runId);
  const req = p?.pending.get(reply.requestId);
  if (!p || !req) return false;
  p.pending.delete(reply.requestId);
  const response = reply.allow
    ? {
        behavior: "allow",
        // AskUserQuestion reads the user's choices from `answers` in its (updated) input.
        updatedInput: reply.answers ? { ...(req.input as object), answers: reply.answers } : req.input,
        ...(reply.always && req.suggestions?.length ? { updatedPermissions: req.suggestions } : {}),
      }
    : { behavior: "deny", message: reply.message?.trim() || "The user denied this tool call from the dashboard." };
  writeLine(p.child, {
    type: "control_response",
    response: { subtype: "success", request_id: reply.requestId, response },
  });
  p.emit({ type: "permission_resolved", requestId: reply.requestId });
  return true;
}

export interface LaunchOptions {
  cwd: string;
  prompt: string;
  sessionId?: string;
  model?: string;
  permissionMode: PermissionMode;
  /**
   * Takes the plan from Claude's ExitPlanMode call instead of asking you, and tells Claude to stop there
   * (a plan-first task shows the plan on its card for approval).
   */
  onPlan?: (plan: string) => void;
  /**
   * Look, don't touch (the review agent): calls that would need approval are refused instead of asked about, except
   * git commands that only read.
   */
  readOnly?: boolean;
}

/** A single git command that only reads: no chaining, redirection or substitution. */
const READ_ONLY_GIT = /^\s*git\s+(?:--no-pager\s+)?(?:diff|log|show|status|blame|ls-files|ls-tree|rev-parse|cat-file)\b[^;&|<>`$]*$/;

/**
 * Starts Claude Code for one prompt. Every event goes to `emit`; the last one is always either
 * `done` or `error`, after which `onExit` is called once.
 */
export function launchClaude(runId: string, opts: LaunchOptions, emit: (ev: ChatEvent) => void, onExit: () => void) {
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
  // The dashboard's own tools (an Android screen to look at and tap); a read-only session doesn't get to tap.
  if (!opts.readOnly) args.push(...mcpLaunchArgs());

  // Don't let the child think it is nested inside another Claude Code session.
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const { command, shell } = claudeCommand();
  const child = spawn(command, args, { cwd: opts.cwd, env, shell, windowsHide: true });
  const proc: Proc = { child, stopped: false, pending: new Map(), permissionMode: opts.permissionMode, emit, onPlan: opts.onPlan, readOnly: opts.readOnly };
  procs.set(runId, proc);

  let finished = false;
  const finish = (last?: ChatEvent) => {
    if (finished) return;
    finished = true;
    procs.delete(runId);
    if (last) emit(last);
    onExit();
  };

  // The prompt goes over stdin so it never needs shell escaping.
  writeLine(child, {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text: opts.prompt }] },
  });

  let stderr = "";
  let doneEvent: ChatEvent | undefined;
  child.stderr.on("data", (d) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e.type === "control_request") return handleControlRequest(proc, e);
    if (e.type === "control_cancel_request") {
      // Claude Code gave up on a request (e.g. the turn was interrupted); drop the prompt from the UI.
      if (proc.pending.delete(e.request_id)) emit({ type: "permission_resolved", requestId: e.request_id });
      return;
    }
    for (const ev of normalise(e)) {
      // Hold the result back until the process exits, so listeners see it as the final event.
      if (ev.type === "done") doneEvent = ev;
      else emit(ev);
    }
    if (e.type === "result") {
      // In stream-json input mode the CLI waits for another message after each turn;
      // closing stdin is what lets it exit.
      child.stdin.end();
    }
  });

  child.on("error", (err) => finish({ type: "error", message: `Could not start Claude Code (${command}): ${err.message}` }));
  child.on("close", (code) => {
    // Let readline flush the last lines first.
    setImmediate(() => {
      if (doneEvent) finish(doneEvent);
      else if (proc.stopped) finish({ type: "error", message: "Stopped" });
      else finish({ type: "error", message: `Claude Code exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}` });
    });
  });
}

function handleControlRequest(proc: Proc, e: any) {
  const req = e.request ?? {};
  if (req.subtype !== "can_use_tool") {
    // Anything else (hook callbacks, MCP messages) isn't something the dashboard registers for;
    // answer with an error so the CLI doesn't wait on it forever.
    writeLine(proc.child, {
      type: "control_response",
      response: { subtype: "error", request_id: e.request_id, error: `Unsupported control request: ${req.subtype}` },
    });
    return;
  }
  if (proc.onPlan && req.tool_name === "ExitPlanMode") {
    const plan = typeof req.input?.plan === "string" ? req.input.plan.trim() : "";
    if (plan) proc.onPlan(plan);
    writeLine(proc.child, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: e.request_id,
        response: {
          behavior: "deny",
          message: plan
            ? "The dashboard saved your plan for the user to review. Stop here without changing anything. " +
              "Once they approve it, this session continues and you'll build it."
            : "The plan was empty. Call ExitPlanMode again with your full plan.",
        },
      },
    });
    if (plan) proc.emit({ type: "item", item: { kind: "system", id: randomUUID(), text: "Plan sent to the task card for approval" } });
    return;
  }
  if (proc.readOnly) {
    const allow = req.tool_name === "Bash" && READ_ONLY_GIT.test(String(req.input?.command ?? ""));
    writeLine(proc.child, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: e.request_id,
        response: allow
          ? { behavior: "allow", updatedInput: req.input }
          : {
              behavior: "deny",
              message:
                req.tool_name === "AskUserQuestion"
                  ? "Nobody is watching this session to answer. Use your own judgement."
                  : "This session is read-only: read files and use git diff/log/show/status/blame, but don't change or run anything else.",
            },
      },
    });
    return;
  }
  // Even in bypassPermissions mode Claude Code still asks before some calls (e.g. edits under
  // .claude/ or .git/). Full access means no prompts, so approve those here; questions still go to the user.
  if (proc.permissionMode === "bypassPermissions" && req.tool_name !== "AskUserQuestion") {
    writeLine(proc.child, {
      type: "control_response",
      response: { subtype: "success", request_id: e.request_id, response: { behavior: "allow", updatedInput: req.input } },
    });
    return;
  }
  const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : undefined;
  proc.pending.set(e.request_id, { input: req.input, suggestions });
  proc.emit({
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
          images: toolResultImages(b.content),
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
          result: typeof e.result === "string" ? e.result : undefined,
        },
      ];

    default:
      return [];
  }
}
