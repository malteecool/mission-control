import { useState } from "react";
import clsx from "clsx";
import { Check, ChevronDown, ClipboardList, PencilLine } from "lucide-react";
import type { Task } from "../lib/api.ts";
import { Strip, StripButton } from "./AgentStrip.tsx";
import { Markdown } from "./Transcript.tsx";

/** A plan-first task's plan, shown on its card: approve it to build, or send it back with what to change. */
export function PlanReview({
  task: t,
  busy,
  onApprove,
  onRevise,
}: {
  task: Task;
  busy: boolean;
  onApprove: (note?: string) => void;
  onRevise: (feedback: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  if (!t.planFirst || !t.plan) return null;

  // Once approved the plan stays around for reference, folded away.
  if (t.planApproved)
    return (
      <div className="mt-2 pl-1.5">
        <button
          onClick={() => setOpen((x) => !x)}
          className="inline-flex items-center gap-1 font-mono text-[10px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline"
        >
          <Check size={10} /> approved plan
          <ChevronDown size={10} className={clsx("transition", open && "rotate-180")} />
        </button>
        {open && <PlanBody plan={t.plan} full={full} onFull={() => setFull(true)} />}
      </div>
    );

  if (t.status !== "doing" || t.agentStatus) return null;
  const send = (approve: boolean) => {
    const text = draft.trim();
    if (approve) onApprove(text || undefined);
    else if (text) onRevise(text);
    else return;
    setReplying(false);
    setDraft("");
  };

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <Strip tone="amber" icon={<ClipboardList size={11} />} text="Plan ready for your approval">
        {!replying && (
          <>
            <StripButton onClick={() => setReplying(true)}>
              <PencilLine size={11} /> Revise
            </StripButton>
            <StripButton strong onClick={() => !busy && onApprove()}>
              <Check size={11} /> Approve & build
            </StripButton>
          </>
        )}
      </Strip>
      <PlanBody plan={t.plan} full={full} onFull={() => setFull(true)} />
      {replying && (
        <div className="mt-2 space-y-1.5">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setReplying(false);
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(false);
            }}
            placeholder="What should change in the plan? (or a note to go with your approval)"
            rows={3}
            className="w-full resize-y rounded-lg border border-white/10 bg-black/30 p-2 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none"
          />
          <div className="flex justify-end gap-1">
            <StripButton onClick={() => setReplying(false)}>Cancel</StripButton>
            <StripButton onClick={() => !busy && send(true)}>Approve with note</StripButton>
            <StripButton strong onClick={() => !busy && send(false)}>
              Revise plan
            </StripButton>
          </div>
        </div>
      )}
    </div>
  );
}

function PlanBody({ plan, full, onFull }: { plan: string; full: boolean; onFull: () => void }) {
  return (
    <div className="relative mt-2 cursor-auto rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-2 text-xs" draggable={false}>
      <div className={clsx("overflow-y-auto", !full && "max-h-48")} onDragStart={(e) => e.preventDefault()}>
        <Markdown text={plan} />
      </div>
      {!full && plan.length > 600 && (
        <button onClick={onFull} className="mt-1 font-mono text-[10px] text-slate-500 hover:text-slate-300">
          show all
        </button>
      )}
    </div>
  );
}
