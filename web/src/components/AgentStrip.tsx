import type { ReactNode } from "react";
import clsx from "clsx";
import { AlertTriangle, Clock, Eye, MessageSquareReply, Play, RotateCcw, ShieldQuestion, Sparkles, StepForward } from "lucide-react";
import type { RunInfo, Task } from "../lib/api.ts";

/** What Claude is doing about a task, shown at the bottom of its card. */
export function AgentStrip({
  task: t,
  run,
  autoRun,
  onStart,
  onResume,
  onOpenRun,
  onOpenSession,
}: {
  task: Task;
  run?: RunInfo;
  autoRun: boolean;
  onStart: () => void;
  onResume: () => void;
  onOpenRun: (run: RunInfo) => void;
  onOpenSession: () => void;
}) {
  if (run) {
    const asking = run.permissions.some((p) => p.toolName === "AskUserQuestion");
    if (run.status === "queued")
      return (
        <Strip tone="muted" icon={<Clock size={11} />} text="Queued: starts when the current task run finishes">
          <StripButton onClick={() => onOpenRun(run)}>View</StripButton>
        </Strip>
      );
    if (run.permissions.length)
      return (
        <Strip
          tone="amber"
          pulse
          icon={<ShieldQuestion size={11} />}
          text={asking ? "Claude has a question for you" : `Claude needs your approval (${run.permissions[0].toolName})`}
        >
          <StripButton strong onClick={() => onOpenRun(run)}>
            Review
          </StripButton>
        </Strip>
      );
    return (
      <Strip
        tone="accent"
        icon={<Sparkles size={11} />}
        text={run.permissionMode === "plan" && t.planFirst && !t.planApproved ? "Claude is planning this" : "Claude is working on this"}
        scanning
      >
        <StripButton onClick={() => onOpenRun(run)}>
          <Eye size={11} /> Watch
        </StripButton>
      </Strip>
    );
  }

  if (t.status === "doing" && t.agentStatus === "blocked")
    return (
      <Strip tone="amber" icon={<AlertTriangle size={11} />} text="Claude needs you" note={t.agentNote}>
        {t.sessionId && (
          <StripButton strong onClick={onOpenSession}>
            <MessageSquareReply size={11} /> Reply
          </StripButton>
        )}
        <StripButton onClick={onStart}>
          <RotateCcw size={11} /> New run
        </StripButton>
      </Strip>
    );

  // A plan waiting for approval: the card shows it with PlanReview.
  if (t.status === "doing" && t.planFirst && t.plan && !t.planApproved && !t.agentStatus) return null;

  // Failed or stopped, or the session was cut off without an outcome (the server restarted mid-run):
  // continuing the same session keeps what Claude already knows and did.
  if (t.status === "doing" && (t.agentStatus === "failed" || t.sessionId))
    return (
      <Strip
        tone="rose"
        icon={<AlertTriangle size={11} />}
        text={t.agentStatus === "failed" ? "Claude's run didn't finish" : "Claude's session was interrupted"}
        note={t.agentNote}
      >
        {t.sessionId && (
          <StripButton strong onClick={onResume}>
            <StepForward size={11} /> Resume
          </StripButton>
        )}
        <StripButton onClick={onStart}>
          <RotateCcw size={11} /> New run
        </StripButton>
      </Strip>
    );

  if (t.status === "doing")
    return (
      <Strip tone="muted" icon={<Play size={11} />} text={autoRun ? "No Claude session running" : "Auto-start is off for this project"}>
        <StripButton onClick={onStart}>Start Claude</StripButton>
      </Strip>
    );

  if (t.status === "done" && t.sessionId)
    return (
      <div className="mt-2 pl-1.5">
        <button onClick={onOpenSession} className="font-mono text-[10px] text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline">
          view Claude session
        </button>
      </div>
    );

  return null;
}

const TONES = {
  accent: "border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-[var(--accent)]",
  amber: "border-amber-400/35 bg-amber-400/[0.08] text-amber-200",
  rose: "border-rose-400/35 bg-rose-500/[0.08] text-rose-200",
  muted: "border-white/10 bg-white/[0.03] text-slate-400",
};

export function Strip({
  tone,
  icon,
  text,
  note,
  pulse,
  scanning,
  children,
}: {
  tone: keyof typeof TONES;
  icon: ReactNode;
  text: string;
  note?: string;
  pulse?: boolean;
  scanning?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={clsx("relative mt-2.5 overflow-hidden rounded-lg border px-2.5 py-1.5", TONES[tone])}>
      {scanning && <div className="scanbar absolute inset-x-0 bottom-0 h-px" />}
      <div className="flex items-center gap-2">
        <span className={clsx("shrink-0", pulse && "animate-pulse")}>{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{text}</span>
        <div className="flex shrink-0 gap-1">{children}</div>
      </div>
      {note && <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-slate-300/90">{note}</p>}
    </div>
  );
}

export function StripButton({ strong, onClick, children }: { strong?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={clsx(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition",
        strong ? "bg-amber-400 text-slate-950 hover:brightness-110" : "bg-white/[0.06] text-slate-200 hover:bg-white/[0.12]",
      )}
    >
      {children}
    </button>
  );
}
