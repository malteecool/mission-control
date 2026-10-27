// Claude's pending approvals and questions from every run, as popups you can answer from any page, so a task
// session in another project doesn't sit waiting until you happen to open its chat.
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ExternalLink, Minus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type PermissionReply, type PermissionRequest, type ProjectSummary, type RunInfo } from "../lib/api.ts";
import { chat, useChat } from "../lib/chatStore.ts";
import { navigate, useRoute } from "../lib/router.ts";
import { activeRuns, useRuns } from "../lib/runs.ts";
import { PermissionCard } from "./PermissionCard.tsx";
import { QuestionCard, askQuestions } from "./QuestionCard.tsx";
import { IconButton } from "./ui.tsx";

const MAX_SHOWN = 2;

export function ApprovalPopups({ projects }: { projects: ProjectSummary[] }) {
  const route = useRoute();
  const runs = useRuns();
  const qc = useQueryClient();
  // The chat you're looking at already shows its own requests inline.
  const viewing = useChat(route.name === "project" ? route.id : -1);
  // Answered (until the next poll drops them) or put aside with "later".
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string>();

  const onScreen = (r: RunInfo) =>
    route.name === "project" && route.tab === "chat" && route.id === r.projectId && viewing.runId === r.id && viewing.running;

  const pending = activeRuns(runs)
    .filter((r) => !onScreen(r))
    .flatMap((run) => run.permissions.filter((p) => !hidden.has(p.requestId)).map((request) => ({ run, request })));

  const hide = (id: string, on = true) =>
    setHidden((h) => {
      const next = new Set(h);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const answer = async (run: RunInfo, reply: PermissionReply) => {
    hide(reply.requestId);
    setError(undefined);
    try {
      await api.answerPermission(run.id, reply);
      qc.invalidateQueries({ queryKey: ["runs"] });
    } catch (err) {
      setError((err as Error).message);
      hide(reply.requestId, false);
    }
  };

  const open = (run: RunInfo) => {
    chat.attach(run.projectId, run);
    navigate({ name: "project", id: run.projectId, tab: "chat" });
  };

  const name = (id: number) => projects.find((p) => p.id === id)?.name ?? "Project";
  const shown = pending.slice(0, MAX_SHOWN);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[min(30rem,calc(100vw-2rem))] flex-col gap-3">
      <AnimatePresence initial={false}>
        {shown.map(({ run, request }) => (
          <motion.div
            key={request.requestId}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40 }}
            className="pointer-events-auto rounded-2xl border border-white/10 bg-slate-950/95 shadow-2xl shadow-black/60 backdrop-blur"
          >
            <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400">
                <span className="text-slate-200">{name(run.projectId)}</span> · {run.title}
              </span>
              <IconButton onClick={() => open(run)} title="Open this chat">
                <ExternalLink size={13} />
              </IconButton>
              <IconButton onClick={() => hide(request.requestId)} title="Later: hide this popup (the task card still shows it)">
                <Minus size={13} />
              </IconButton>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-2 pb-2">
              <Card request={request} onAnswer={(reply) => answer(run, reply)} />
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
      {(pending.length > MAX_SHOWN || error) && (
        <div className="pointer-events-auto self-end rounded-lg border border-white/10 bg-slate-950/95 px-3 py-1.5 font-mono text-[11px] text-slate-400">
          {error ? <span className="text-rose-300">{error}</span> : `+${pending.length - MAX_SHOWN} more waiting`}
        </div>
      )}
    </div>
  );
}

function Card({ request, onAnswer }: { request: PermissionRequest; onAnswer: (reply: PermissionReply) => void }) {
  const questions = request.toolName === "AskUserQuestion" ? askQuestions(request.input) : null;
  return questions ? (
    <QuestionCard request={request} questions={questions} onAnswer={onAnswer} className="" />
  ) : (
    <PermissionCard request={request} onAnswer={onAnswer} className="" />
  );
}
