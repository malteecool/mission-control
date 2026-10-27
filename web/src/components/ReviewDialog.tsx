// Review what a task's Claude sessions changed: the files, their diffs, and Commit / Revert / Ask for changes.
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, Check, GitCommitHorizontal, MessageSquareReply, Undo2, X } from "lucide-react";
import { api, type ChangedFile, type Task } from "../lib/api.ts";
import { timeAgo } from "../lib/util.ts";
import { Button, ErrorNote, IconButton, Modal, ModalHeader } from "./ui.tsx";

const STATUS_STYLE: Record<ChangedFile["status"], { letter: string; className: string }> = {
  added: { letter: "A", className: "text-emerald-300" },
  modified: { letter: "M", className: "text-amber-300" },
  deleted: { letter: "D", className: "text-rose-300" },
};

export function ReviewDialog({
  projectId,
  task,
  onClose,
}: {
  projectId: number;
  task: Task | null;
  onClose: () => void;
}) {
  return (
    <Modal open={!!task} onClose={onClose} className="max-w-6xl">
      {task && <ReviewBody projectId={projectId} task={task} onClose={onClose} />}
    </Modal>
  );
}

function ReviewBody({ projectId, task, onClose }: { projectId: number; task: Task; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ["task-changes", projectId, task.id];
  const changes = useQuery({ queryKey: key, queryFn: () => api.taskChanges(projectId, task.id) });
  const files = changes.data?.files ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState(task.title);
  const [asking, setAsking] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const current = files.find((f) => f.path === selected) ?? files[0];
  useEffect(() => setConfirmRevert(false), [files.length]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["changes", projectId] });
    qc.invalidateQueries({ queryKey: ["tasks", projectId] });
    qc.invalidateQueries({ queryKey: ["project", projectId] });
    qc.invalidateQueries({ queryKey: ["projects"] });
  };
  // Closes once nothing is left to review.
  const settle = (left: number, text: string | null) => {
    refresh();
    if (left > 0) setNote(text);
    else onClose();
  };

  const commit = useMutation({
    mutationFn: (paths?: string[]) => api.commitChanges(projectId, task.id, message.trim(), paths),
    onSuccess: (r, paths) =>
      settle(
        paths ? files.length - paths.length : 0,
        r.commit ? `Committed ${r.files} file${r.files === 1 ? "" : "s"} as ${r.commit.slice(0, 7)}.` : "Already committed.",
      ),
  });
  const revert = useMutation({
    mutationFn: (paths?: string[]) => api.revertChanges(projectId, task.id, paths),
    onSuccess: (r, paths) =>
      settle(
        (paths?.length ? files.length - paths.length : 0) + r.skipped.length,
        r.skipped.length
          ? `Left ${r.skipped.join(", ")} alone: changed again since the task finished.`
          : `Reverted ${r.reverted.join(", ")}.`,
      ),
  });
  const dismiss = useMutation({ mutationFn: () => api.dismissChanges(projectId, task.id), onSuccess: () => settle(0, null) });
  const ask = useMutation({
    mutationFn: () => api.askForChanges(projectId, task.id, feedback.trim()),
    onSuccess: () => {
      refresh();
      qc.invalidateQueries({ queryKey: ["runs"] });
      onClose();
    },
  });
  const busy = commit.isPending || revert.isPending || dismiss.isPending || ask.isPending;
  const error = changes.error ?? commit.error ?? revert.error ?? dismiss.error ?? ask.error;

  return (
    <>
      <ModalHeader title={`Review: ${task.title}`} onClose={onClose} />
      <div className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
          <span>
            {files.length} file{files.length === 1 ? "" : "s"} changed by Claude
            {changes.data?.since && ` since ${timeAgo(changes.data.since)}`}
          </span>
          <span className="font-mono text-emerald-300/80">+{files.reduce((n, f) => n + f.added, 0)}</span>
          <span className="font-mono text-rose-300/80">−{files.reduce((n, f) => n + f.removed, 0)}</span>
        </div>
        {changes.data?.live && (
          <Warning>
            Claude's session ended without the dashboard seeing it finish, so this compares with the files as they are now,
            which may include edits made since.
          </Warning>
        )}
        {!!changes.data?.commits.length && (
          <Warning>
            Claude also made commits: {changes.data.commits.join(" · ")}. Commit skips what's already in them; Revert puts
            the files back but leaves the commits in your history.
          </Warning>
        )}
        {changes.data?.missing && (
          <Warning>Git has cleaned up the snapshots for this review, so the changes can't be shown. Dismiss it.</Warning>
        )}
        {error && <ErrorNote>{error.message}</ErrorNote>}
        {note && (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300">{note}</div>
        )}

        <div className="grid h-[52vh] min-h-0 grid-cols-[minmax(200px,280px)_1fr] gap-3">
          <ul className="min-h-0 space-y-0.5 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-1.5">
            {changes.isLoading && <li className="p-2 text-xs text-slate-500">Loading…</li>}
            {files.map((f) => {
              const slash = f.path.lastIndexOf("/");
              return (
                <li key={f.path}>
                  <div
                    onClick={() => setSelected(f.path)}
                    className={clsx(
                      "group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs transition",
                      f === current ? "bg-white/10 text-white" : "text-slate-300 hover:bg-white/[0.05]",
                    )}
                    title={f.path}
                  >
                    <span className={clsx("w-3 shrink-0 font-mono text-[10px]", STATUS_STYLE[f.status].className)}>
                      {STATUS_STYLE[f.status].letter}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {f.path.slice(slash + 1)}
                      {slash > 0 && <span className="ml-1.5 text-[10px] text-slate-500">{f.path.slice(0, slash)}</span>}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-slate-500 group-hover:hidden">
                      {f.binary ? "bin" : `+${f.added} −${f.removed}`}
                    </span>
                    <IconButton
                      onClick={(e) => {
                        e.stopPropagation();
                        revert.mutate([f.path]);
                      }}
                      disabled={busy}
                      title="Revert this file"
                      className="hidden h-5 w-5 hover:text-rose-300 group-hover:inline-flex"
                    >
                      <Undo2 size={12} />
                    </IconButton>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="min-h-0 overflow-auto rounded-xl border border-white/10 bg-black/30">
            {current ? <Diff file={current} /> : !changes.isLoading && <p className="p-4 text-xs text-slate-500">Nothing to show.</p>}
          </div>
        </div>

        {asking ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (feedback.trim()) ask.mutate();
            }}
          >
            <textarea
              autoFocus
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit();
              }}
              rows={3}
              placeholder="What should Claude change? It continues in the task's session and the card moves back to In progress."
              className="accent-ring w-full resize-y rounded-lg border border-white/10 bg-black/30 p-2.5 text-sm text-slate-100 placeholder:text-slate-600"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" variant="primary" disabled={!feedback.trim() || busy}>
                <MessageSquareReply size={13} /> Send to Claude
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message"
              className="accent-ring h-9 min-w-[220px] flex-1 rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-white placeholder:text-slate-600"
            />
            <Button
              variant="primary"
              disabled={!files.length || !message.trim() || busy}
              onClick={() => commit.mutate(undefined)}
              title="Commits exactly these files as Claude left them; anything else you've staged stays out"
            >
              <GitCommitHorizontal size={14} /> Commit
            </Button>
            <Button
              variant="danger"
              disabled={!files.length || busy}
              onClick={() => (confirmRevert ? revert.mutate(undefined) : setConfirmRevert(true))}
              onBlur={() => setConfirmRevert(false)}
              title="Puts these files back the way they were before the task ran"
            >
              <Undo2 size={14} /> {confirmRevert ? "Click again to revert all" : "Revert"}
            </Button>
            <Button disabled={busy} onClick={() => setAsking(true)}>
              <MessageSquareReply size={14} /> Ask for changes
            </Button>
            <Button
              disabled={busy}
              onClick={() => dismiss.mutate()}
              title="Stop tracking these changes and leave the files as they are, uncommitted"
            >
              {files.length ? <Check size={14} /> : <X size={14} />} {files.length ? "Keep uncommitted" : "Dismiss"}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.07] px-3 py-2 text-xs text-amber-100/90">
      <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />
      <span>{children}</span>
    </div>
  );
}

function Diff({ file }: { file: ChangedFile }) {
  if (file.binary) return <p className="p-4 text-xs text-slate-500">Binary file {file.status}.</p>;
  if (file.truncated) return <p className="p-4 text-xs text-slate-500">This diff is too large to show here.</p>;
  // Skip git's header lines (diff --git, index, ---/+++); the file list already says what changed.
  const lines = file.patch.split("\n");
  const start = lines.findIndex((l) => l.startsWith("@@"));
  if (start === -1) return <p className="p-4 text-xs text-slate-500">No content changes (mode or empty file).</p>;
  return (
    <pre className="min-w-fit p-2 font-mono text-[11.5px] leading-[1.55]">
      {lines.slice(start).map((l, i) => (
        <div
          key={i}
          className={clsx(
            "whitespace-pre px-2",
            l.startsWith("@@")
              ? "mt-1 text-cyan-300/70 first:mt-0"
              : l.startsWith("+")
                ? "bg-emerald-500/10 text-emerald-200"
                : l.startsWith("-")
                  ? "bg-rose-500/10 text-rose-200"
                  : l.startsWith("\\")
                    ? "text-slate-500 italic"
                    : "text-slate-400",
          )}
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}
