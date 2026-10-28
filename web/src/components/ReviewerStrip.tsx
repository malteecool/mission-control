// The review agent's report on a finished card: what it thought of the work, and the follow-ups it put in To do.
import { useState } from "react";
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, ScanSearch, Sparkles, XCircle } from "lucide-react";
import type { ReviewerFinding, RunInfo, Task } from "../lib/api.ts";
import { Strip, StripButton } from "./AgentStrip.tsx";

const SEVERITY: Record<ReviewerFinding["severity"], string> = {
  high: "text-rose-300 bg-rose-500/10",
  medium: "text-amber-200 bg-amber-400/10",
  low: "text-slate-400 bg-white/5",
};

export function ReviewerStrip({
  task: t,
  run,
  board,
  onOpenRun,
  onOpenSession,
  onRetry,
}: {
  task: Task;
  run?: RunInfo;
  board: Task[];
  onOpenRun: (run: RunInfo) => void;
  onOpenSession: (sessionId: string) => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const r = t.reviewer;

  if (run)
    return (
      <Strip
        tone="accent"
        icon={<ScanSearch size={11} />}
        pulse
        scanning={run.status === "running"}
        text={run.status === "queued" ? "Review queued behind another" : "Review agent is looking it over…"}
      >
        <StripButton onClick={() => onOpenRun(run)}>Watch</StripButton>
      </Strip>
    );
  if (!r || r.status === "running") return null;

  if (r.status === "failed")
    return (
      <Strip tone="rose" icon={<XCircle size={11} />} text="Review didn't finish" note={r.error}>
        {r.sessionId && <StripButton onClick={() => onOpenSession(r.sessionId!)}>Session</StripButton>}
        <StripButton onClick={onRetry}>Retry</StripButton>
      </Strip>
    );

  const findings = r.findings ?? [];
  const serious = findings.filter((f) => f.severity !== "low").length;
  const followUps = (r.followUps ?? []).map((id) => board.find((x) => x.id === id)).filter((x): x is Task => !!x);
  const good = r.verdict === "good";
  const text = [
    good ? "Review: looks good" : `Review: ${serious || findings.length} concern${(serious || findings.length) === 1 ? "" : "s"}`,
    followUps.length ? `+${followUps.length} follow-up${followUps.length === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <Strip
        tone={good ? "muted" : "amber"}
        icon={good ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
        text={text}
        note={open ? undefined : r.summary}
      >
        {(findings.length > 0 || followUps.length > 0 || r.summary) && (
          <StripButton onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Details"}</StripButton>
        )}
      </Strip>
      {open && (
        <div className="mt-1.5 space-y-2 rounded-lg border border-white/[0.07] bg-black/25 p-2.5 text-[11px] leading-snug" onClick={(e) => e.stopPropagation()}>
          {r.summary && <p className="text-slate-300">{r.summary}</p>}
          {findings.length > 0 && (
            <ul className="space-y-1.5">
              {findings.map((f, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className={clsx("h-fit shrink-0 rounded px-1 font-mono text-[9px] uppercase", SEVERITY[f.severity])}>{f.severity}</span>
                  <span className="min-w-0 text-slate-300">
                    {f.file && <code className="mr-1 break-all font-mono text-[10px] text-slate-500">{f.file}</code>}
                    {f.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {followUps.length > 0 && (
            <div>
              <div className="hud-label mb-1">Added to the board</div>
              <ul className="space-y-0.5">
                {followUps.map((f) => (
                  <li key={f.id} className="flex items-center gap-1.5 text-slate-300">
                    <Sparkles size={10} className="shrink-0 text-violet-300" />
                    <span className={clsx("truncate", f.status === "done" && "text-slate-500 line-through")}>{f.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex gap-1">
            {r.sessionId && <StripButton onClick={() => onOpenSession(r.sessionId!)}>Open session</StripButton>}
            <StripButton onClick={onRetry}>Review again</StripButton>
          </div>
        </div>
      )}
    </>
  );
}
