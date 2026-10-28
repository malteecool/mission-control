// The chat view per project. Runs themselves live on the server; this store attaches to one run at a time,
// replays its events and follows it live. Detaching (switching view, leaving the page) never stops a run.
import { useSyncExternalStore } from "react";
import {
  api,
  type ChatEvent,
  type ChatItem,
  type PermissionMode,
  type PermissionReply,
  type PermissionRequest,
  type RunInfo,
} from "./api.ts";

export interface RunSummary {
  isError: boolean;
  costUsd?: number;
  durationMs?: number;
  numTurns?: number;
  permissionDenials: string[];
}

export interface ChatState {
  sessionId?: string;
  sessionTitle?: string;
  /** Set while viewing a task's run. */
  taskId?: string;
  items: ChatItem[];
  /** Text of the assistant block currently streaming in. */
  draft: string;
  /** The attached run is still going. */
  running: boolean;
  runId?: string;
  /** Tool calls waiting for you to allow or deny them. */
  permissions: PermissionRequest[];
  lastRun?: RunSummary;
  error?: string;
  composer: string;
  model: string;
  permissionMode: PermissionMode;
}

// New chats start with these; the settings page changes them.
let defaults: { model: string; permissionMode: PermissionMode } = { model: "", permissionMode: "default" };

const initial = (): ChatState => ({
  items: [],
  draft: "",
  running: false,
  permissions: [],
  composer: "",
  ...defaults,
});

const states = new Map<number, ChatState>();
const subscriptions = new Map<number, AbortController>();
const listeners = new Set<() => void>();
let onTurnFinished: ((projectId: number) => void) | undefined;

export function setOnTurnFinished(fn: (projectId: number) => void) {
  onTurnFinished = fn;
}

function get(projectId: number): ChatState {
  let s = states.get(projectId);
  if (!s) states.set(projectId, (s = initial()));
  return s;
}

function set(projectId: number, patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) {
  const prev = get(projectId);
  states.set(projectId, { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) });
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Apply new defaults, also to chats you haven't started yet (so a changed setting shows straight away). */
export function setChatDefaults(next: { model: string; permissionMode: PermissionMode }) {
  const prev = defaults;
  defaults = next;
  for (const [id, s] of states) {
    const untouched = !s.items.length && !s.sessionId && !s.running;
    if (untouched && s.model === prev.model && s.permissionMode === prev.permissionMode) set(id, next);
  }
}

export function useChat(projectId: number): ChatState {
  return useSyncExternalStore(subscribe, () => get(projectId));
}

/** Stop following the current run (the run keeps going on the server). */
function detach(projectId: number) {
  subscriptions.get(projectId)?.abort();
  subscriptions.delete(projectId);
}

/** A fresh view that keeps your model and permission choices. */
function fresh(projectId: number, patch: Partial<ChatState> = {}) {
  const s = get(projectId);
  detach(projectId);
  set(projectId, { ...initial(), model: s.model, permissionMode: s.permissionMode, composer: s.composer, ...patch });
}

/** Follow a run's event stream (replayed from its start) until it ends or the view moves on. */
async function follow(projectId: number, runId: string) {
  detach(projectId);
  const ctrl = new AbortController();
  subscriptions.set(projectId, ctrl);
  const current = () => subscriptions.get(projectId) === ctrl;

  set(projectId, { runId, running: true, draft: "", permissions: [], error: undefined, lastRun: undefined });
  try {
    const res = await fetch(`/api/runs/${runId}/events`, { signal: ctrl.signal });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error ?? `Request failed (${res.status})`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() && current()) apply(projectId, JSON.parse(line) as ChatEvent);
      }
    }
  } catch (err) {
    if (ctrl.signal.aborted) return;
    set(projectId, { error: (err as Error).message });
  }
  if (!current()) return;
  subscriptions.delete(projectId);
  set(projectId, (st) => ({
    running: false,
    permissions: [],
    // Keep whatever streamed in if the run ended without a final message (e.g. stopped).
    items: st.draft.trim() ? [...st.items, { kind: "assistant", id: crypto.randomUUID(), text: st.draft }] : st.items,
    draft: "",
  }));
  onTurnFinished?.(projectId);
}

export const chat = {
  setComposer: (projectId: number, composer: string) => set(projectId, { composer }),
  setModel: (projectId: number, model: string) => set(projectId, { model }),
  setPermissionMode: (projectId: number, permissionMode: PermissionMode) => set(projectId, { permissionMode }),

  newSession(projectId: number) {
    fresh(projectId, { composer: "" });
  },

  /** Continue an existing session: show its transcript, and the next message resumes it. */
  resume(projectId: number, sessionId: string, title: string, items: ChatItem[], taskId?: string) {
    fresh(projectId, { sessionId, sessionTitle: title, items, taskId });
  },

  /** Open a session by id (e.g. a task's), loading its transcript from history. */
  async openSession(projectId: number, sessionId: string, taskId?: string) {
    const t = await api.session(projectId, sessionId);
    chat.resume(projectId, sessionId, t.title, t.items, taskId);
  },

  /** View a run that's already going (or recently finished), e.g. a task's. */
  attach(projectId: number, run: RunInfo) {
    if (get(projectId).runId === run.id && subscriptions.has(projectId)) return;
    // Show the mode and model the run really uses (a task session runs in its project's mode, not the chat's).
    fresh(projectId, {
      sessionId: run.sessionId,
      sessionTitle: run.title,
      // The review agent's session isn't the task's own; replies there don't move the card.
      taskId: run.role ? undefined : run.taskId,
      permissionMode: run.permissionMode,
      model: run.model ?? "",
    });
    void follow(projectId, run.id);
  },

  async stop(projectId: number) {
    const { runId } = get(projectId);
    if (runId) await api.stopRun(runId).catch(() => {});
  },

  async answer(projectId: number, reply: PermissionReply) {
    const { runId, permissions } = get(projectId);
    const req = permissions.find((p) => p.requestId === reply.requestId);
    if (!runId || !req) return;
    // Hide the card right away; put it back if the server couldn't deliver the answer.
    set(projectId, (s) => ({ permissions: s.permissions.filter((p) => p.requestId !== reply.requestId) }));
    try {
      await api.answerPermission(runId, reply);
    } catch (err) {
      set(projectId, (s) => ({
        error: (err as Error).message,
        permissions: s.running && s.runId === runId ? [...s.permissions, req] : s.permissions,
      }));
    }
  },

  async send(projectId: number, prompt: string) {
    const s = get(projectId);
    if (s.running || !prompt.trim()) return;
    set(projectId, { composer: "", error: undefined, sessionTitle: s.sessionTitle ?? prompt.slice(0, 80) });
    try {
      const run = await api.chat(projectId, {
        prompt,
        sessionId: s.sessionId,
        model: s.model || undefined,
        permissionMode: s.permissionMode,
      });
      // The run's replay starts with your prompt, so it's appended to the conversation shown so far.
      void follow(projectId, run.id);
    } catch (err) {
      set(projectId, { error: (err as Error).message, composer: prompt });
    }
  },
};

function apply(projectId: number, ev: ChatEvent) {
  switch (ev.type) {
    case "run":
      return set(projectId, { runId: ev.runId });
    case "init":
      return set(projectId, { sessionId: ev.sessionId });
    case "permission":
      return set(projectId, (s) => ({ permissions: [...s.permissions, ev.request] }));
    case "permission_resolved":
      return set(projectId, (s) => ({ permissions: s.permissions.filter((p) => p.requestId !== ev.requestId) }));
    case "delta":
      return set(projectId, (s) => ({ draft: s.draft + ev.text }));
    case "item":
      return set(projectId, (s) => ({
        items: [...s.items, ev.item],
        draft: ev.item.kind === "assistant" ? "" : s.draft,
      }));
    case "tool_result":
      return set(projectId, (s) => ({
        items: s.items.map((it) =>
          it.kind === "tool" && it.id === ev.toolUseId ? { ...it, result: ev.result, isError: ev.isError } : it,
        ),
      }));
    case "done":
      return set(projectId, (s) => ({
        sessionId: ev.sessionId ?? s.sessionId,
        lastRun: {
          isError: ev.isError,
          costUsd: ev.costUsd,
          durationMs: ev.durationMs,
          numTurns: ev.numTurns,
          permissionDenials: ev.permissionDenials,
        },
        // Errors like a failed login also arrive as the assistant's reply; don't show them twice.
        error:
          ev.isError && !s.items.some((it) => it.kind === "assistant" && it.text === ev.text)
            ? (ev.text ?? "The turn ended with an error")
            : s.error,
      }));
    case "error":
      return set(projectId, { error: ev.message });
  }
}
