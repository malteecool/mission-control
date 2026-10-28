import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { CalendarClock, Pause, Pencil, Play, Plus, Repeat, Trash2, Zap } from "lucide-react";
import { api, type Schedule, type ScheduleRule, type TaskKind, type TaskPriority } from "../lib/api.ts";
import { KIND_STYLE, WEEKDAYS, describeRule, timeAgo, timeUntil } from "../lib/util.ts";
import { Button, Empty, ErrorNote, IconButton, Modal, ModalHeader } from "./ui.tsx";

const KINDS = Object.keys(KIND_STYLE) as TaskKind[];
const EVERY = [1, 2, 3, 4, 6, 8, 12];
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];
const FREQ_LABEL: Record<ScheduleRule["freq"], string> = {
  hourly: "Every few hours",
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Weekly",
  monthly: "Monthly",
};

type Draft = Pick<Schedule, "title" | "kind" | "priority" | "rule" | "autoStart"> & { notes: string; planFirst: boolean };

const blank = (): Draft => ({
  title: "",
  notes: "",
  kind: "chore",
  priority: 2,
  planFirst: false,
  autoStart: true,
  rule: { freq: "weekly", time: "09:00", days: [1] },
});

const toDraft = (s: Schedule): Draft => ({
  title: s.title,
  notes: s.notes ?? "",
  kind: s.kind,
  priority: s.priority,
  planFirst: !!s.planFirst,
  autoStart: s.autoStart,
  rule: s.rule,
});

/** The project's recurring tasks: each comes round on its schedule, lands on the board and (optionally) starts itself. */
export function ScheduleDialog({ projectId, open, onClose }: { projectId: number; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const key = ["schedules", projectId];
  const schedules = useQuery({ queryKey: key, queryFn: () => api.schedules(projectId), enabled: open, refetchInterval: 30_000 });
  // The schedule being edited, "new" for one being added.
  const [editing, setEditing] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["tasks", projectId] });
    qc.invalidateQueries({ queryKey: ["runs"] });
  };
  const save = useMutation({
    mutationFn: ({ id, ...body }: Partial<Schedule> & { id?: string }) =>
      id ? api.updateSchedule(projectId, id, body) : api.addSchedule(projectId, body),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
  });
  const toggle = useMutation({
    mutationFn: (s: Schedule) => api.updateSchedule(projectId, s.id, { enabled: !s.enabled }),
    onSuccess: invalidate,
  });
  const runNow = useMutation({ mutationFn: (s: Schedule) => api.runSchedule(projectId, s.id), onSettled: invalidate });
  const remove = useMutation({ mutationFn: (s: Schedule) => api.deleteSchedule(projectId, s.id), onSuccess: invalidate });
  const error = save.error ?? toggle.error ?? runNow.error ?? remove.error ?? schedules.error;

  const close = () => {
    setEditing(null);
    onClose();
  };
  const list = schedules.data ?? [];

  return (
    <Modal open={open} onClose={close} className="max-w-2xl">
      <ModalHeader title="Recurring tasks" onClose={close} />
      <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5">
        <p className="text-xs text-slate-400">
          Each time one comes round, a fresh task lands on the board and Claude starts on it. If the task from last time
          isn't done yet, that time is skipped. Times are this computer's local time; one that comes round while the
          dashboard is closed runs once when it starts again.
        </p>
        {error && <ErrorNote>{error.message}</ErrorNote>}

        {list.length === 0 && editing !== "new" && (
          <Empty icon={<CalendarClock size={20} />} title="No recurring tasks yet">
            For example “Update dependencies and run the tests”, every Monday at 09:00.
          </Empty>
        )}

        {list.map((s) =>
          editing === s.id ? (
            <ScheduleForm
              key={s.id}
              initial={toDraft(s)}
              busy={save.isPending}
              onCancel={() => setEditing(null)}
              onSave={(d) => save.mutate({ id: s.id, ...d })}
            />
          ) : (
            <div
              key={s.id}
              className={clsx(
                "group rounded-xl border border-white/[0.07] bg-white/[0.03] p-3",
                !s.enabled && "opacity-60",
              )}
            >
              <div className="flex items-start gap-3">
                <Repeat size={14} className="mt-0.5 shrink-0" style={{ color: KIND_STYLE[s.kind].color }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-slate-100">{s.title}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[10px] text-slate-500">
                    <span className="text-slate-300">{describeRule(s.rule)}</span>
                    {s.enabled ? (
                      <span title={s.nextRunAt && new Date(s.nextRunAt).toLocaleString()}>next {timeUntil(s.nextRunAt)}</span>
                    ) : (
                      <span>paused</span>
                    )}
                    {s.lastRunAt && <span title={new Date(s.lastRunAt).toLocaleString()}>last {timeAgo(s.lastRunAt)}</span>}
                    {!s.autoStart && <span>lands in To do</span>}
                    {s.planFirst && <span className="text-sky-300">plan first</span>}
                  </div>
                  {s.lastNote && <div className="mt-1 text-[11px] text-amber-300/90">{s.lastNote}</div>}
                </div>
                <div className="flex shrink-0 items-center">
                  <IconButton
                    onClick={() => runNow.mutate(s)}
                    disabled={runNow.isPending}
                    title={s.autoStart ? "Run now: add the task and start Claude on it" : "Run now: add the task to To do"}
                  >
                    <Zap size={13} />
                  </IconButton>
                  <IconButton onClick={() => toggle.mutate(s)} title={s.enabled ? "Pause" : "Resume"}>
                    {s.enabled ? <Pause size={13} /> : <Play size={13} />}
                  </IconButton>
                  <IconButton onClick={() => setEditing(s.id)} title="Edit">
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton
                    onClick={() => confirm(`Delete the recurring task "${s.title}"? Tasks it already added stay on the board.`) && remove.mutate(s)}
                    title="Delete"
                    className="hover:text-rose-300"
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              </div>
            </div>
          ),
        )}

        {editing === "new" ? (
          <ScheduleForm initial={blank()} busy={save.isPending} onCancel={() => setEditing(null)} onSave={(d) => save.mutate(d)} />
        ) : (
          <Button onClick={() => setEditing("new")} disabled={editing !== null}>
            <Plus size={13} /> Add recurring task
          </Button>
        )}
      </div>
    </Modal>
  );
}

const input = "accent-ring h-8 rounded-lg border border-white/10 bg-black/30 px-2 text-xs text-slate-200 focus:outline-none";

function ScheduleForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: Draft;
  busy: boolean;
  onSave: (d: Draft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState(initial);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const setRule = (patch: Partial<ScheduleRule>) => setD((x) => ({ ...x, rule: { ...x.rule, ...patch } }));
  const r = d.rule;
  const days = r.days ?? [];
  const valid = d.title.trim() && (r.freq !== "weekly" || days.length > 0);

  const changeFreq = (freq: ScheduleRule["freq"]) =>
    set({
      rule: {
        freq,
        time: r.time,
        ...(freq === "weekly" ? { days: days.length ? days : [1] } : {}),
        ...(freq === "monthly" ? { monthDay: r.monthDay ?? 1 } : {}),
        ...(freq === "hourly" ? { every: r.every ?? 1 } : {}),
      },
    });

  return (
    <form
      className="space-y-3 rounded-xl border border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-black/20 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave({ ...d, title: d.title.trim() });
      }}
    >
      <input
        autoFocus
        value={d.title}
        onChange={(e) => set({ title: e.target.value })}
        placeholder="What should happen, e.g. Update dependencies and run the tests"
        className="accent-ring h-9 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-white placeholder:text-slate-500"
      />
      <textarea
        value={d.notes}
        onChange={(e) => set({ notes: e.target.value })}
        placeholder="Notes for Claude (optional)"
        rows={2}
        className="accent-ring w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600"
      />

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
        <select value={r.freq} onChange={(e) => changeFreq(e.target.value as ScheduleRule["freq"])} className={input}>
          {(Object.keys(FREQ_LABEL) as ScheduleRule["freq"][]).map((f) => (
            <option key={f} value={f} className="bg-slate-900">
              {FREQ_LABEL[f]}
            </option>
          ))}
        </select>
        {r.freq === "hourly" && (
          <>
            every
            <select value={r.every ?? 1} onChange={(e) => setRule({ every: Number(e.target.value) })} className={input}>
              {EVERY.map((n) => (
                <option key={n} value={n} className="bg-slate-900">
                  {n === 1 ? "hour" : `${n} hours`}
                </option>
              ))}
            </select>
            at minute
            <input
              type="number"
              min={0}
              max={59}
              value={Number(r.time.slice(3))}
              onChange={(e) => {
                const m = Math.min(59, Math.max(0, Number(e.target.value) || 0));
                setRule({ time: `00:${String(m).padStart(2, "0")}` });
              }}
              className={clsx(input, "w-16")}
            />
          </>
        )}
        {r.freq === "monthly" && (
          <>
            on day
            <input
              type="number"
              min={1}
              max={31}
              value={r.monthDay ?? 1}
              onChange={(e) => setRule({ monthDay: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })}
              className={clsx(input, "w-16")}
              title="Months without this day use their last day"
            />
          </>
        )}
        {r.freq !== "hourly" && (
          <>
            at
            <input type="time" value={r.time} onChange={(e) => e.target.value && setRule({ time: e.target.value })} className={input} />
          </>
        )}
      </div>
      {r.freq === "weekly" && (
        <div className="flex gap-1">
          {MONDAY_FIRST.map((i) => (
            <button
              type="button"
              key={i}
              onClick={() => setRule({ days: days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort() })}
              className={clsx(
                "h-7 w-10 rounded-lg border text-[11px] transition",
                days.includes(i)
                  ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] text-white"
                  : "border-white/10 text-slate-400 hover:text-slate-200",
              )}
            >
              {WEEKDAYS[i].slice(0, 3)}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
        <select value={d.kind} onChange={(e) => set({ kind: e.target.value as TaskKind })} className={input}>
          {KINDS.map((k) => (
            <option key={k} value={k} className="bg-slate-900">
              {KIND_STYLE[k].label}
            </option>
          ))}
        </select>
        <select value={d.priority} onChange={(e) => set({ priority: Number(e.target.value) as TaskPriority })} className={input}>
          {[1, 2, 3].map((p) => (
            <option key={p} value={p} className="bg-slate-900">
              P{p}
            </option>
          ))}
        </select>
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={d.autoStart} onChange={(e) => set({ autoStart: e.target.checked })} className="accent-[var(--accent)]" />
        Start Claude on it right away (otherwise it waits in To do)
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={d.planFirst} onChange={(e) => set({ planFirst: e.target.checked })} className="accent-[var(--accent)]" />
        Plan first: Claude proposes a plan for you to approve before it builds
      </label>

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="font-mono text-[10px] text-slate-500">{describeRule(r)}</span>
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={!valid || busy}>
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}
