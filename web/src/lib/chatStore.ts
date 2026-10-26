// Chat state lives outside React so a running turn keeps streaming while you navigate between projects.
import { useSyncExternalStore } from "react";
import { api, type ChatEvent, type ChatItem, type PermissionMode, type PermissionReply, type PermissionRequest } from "./api.ts";

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
  items: ChatItem[];
  /** Text of the assistant block currently streaming in. */
  draft: string;
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

const initial = (): ChatState => ({
  items: [],
  draft: "",
  running: false,
  permissions: [],
  composer: "",
  model: "",
  // Claude asks before edits and commands; you approve them in the chat.
  permissionMode: "default",
});

const states = new Map<number, ChatState>();
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

export function useChat(projectId: number): ChatState {
  return useSyncExternalStore(subscribe, () => get(projectId));
}

export function useProjectsAwaitingApproval(): number[] {
  const snapshot = useSyncExternalStore(subscribe, () =>
    [...states.entries()]
      .filter(([, s]) => s.permissions.length > 0)
      .map(([id]) => id)
      .join(","),
  );
  return snapshot ? snapshot.split(",").map(Number) : [];
}

export function useRunningProjects(): number[] {
  const snapshot = useSyncExternalStore(subscribe, () =>
    [...states.entries()]
      .filter(([, s]) => s.running)
      .map(([id]) => id)
      .join(","),
  );
  return snapshot ? snapshot.split(",").map(Number) : [];
}

export const chat = {
  setComposer: (projectId: number, composer: string) => set(projectId, { composer }),
  setModel: (projectId: number, model: string) => set(projectId, { model }),
  setPermissionMode: (projectId: number, permissionMode: PermissionMode) => set(projectId, { permissionMode }),

  newSession(projectId: number) {
    const s = get(projectId);
    if (s.running) return;
    set(projectId, { ...initial(), model: s.model, permissionMode: s.permissionMode });
  },

  /** Continue an existing session: show its transcript, and the next message resumes it. */
  resume(projectId: number, sessionId: string, title: string, items: ChatItem[]) {
    const s = get(projectId);
    if (s.running) return;
    set(projectId, {
      ...initial(),
      model: s.model,
      permissionMode: s.permissionMode,
      sessionId,
      sessionTitle: title,
      items,
    });
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
    set(projectId, (st) => ({
      items: [...st.items, { kind: "user", id: crypto.randomUUID(), text: prompt, ts: new Date().toISOString() }],
      composer: "",
      draft: "",
      running: true,
      error: undefined,
      lastRun: undefined,
      sessionTitle: st.sessionTitle ?? prompt.slice(0, 80),
    }));

    try {
      const res = await fetch(`/api/projects/${projectId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dashboard": "1" },
        body: JSON.stringify({
          prompt,
          sessionId: s.sessionId,
          model: s.model || undefined,
          permissionMode: s.permissionMode,
        }),
      });
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
          if (line.trim()) apply(projectId, JSON.parse(line) as ChatEvent);
        }
      }
    } catch (err) {
      set(projectId, { error: (err as Error).message });
    } finally {
      set(projectId, (st) => ({
        running: false,
        runId: undefined,
        permissions: [],
        // Keep whatever streamed in if the turn ended without a final message (e.g. stopped).
        items: st.draft.trim()
          ? [...st.items, { kind: "assistant", id: crypto.randomUUID(), text: st.draft }]
          : st.items,
        draft: "",
      }));
      onTurnFinished?.(projectId);
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
