import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Bell, Check, FolderPlus, ListChecks, MessageSquare, RefreshCw, Terminal } from "lucide-react";
import { api, type PermissionMode, type Settings } from "../lib/api.ts";
import { MODELS, MODES } from "../lib/claudeOptions.ts";
import { notificationsOn, notificationsSupported, sendNotification, setNotifications } from "../lib/notify.ts";
import { useSettings } from "../lib/settings.ts";
import { Button, ErrorNote, Panel } from "./ui.tsx";

const CUSTOM = "__custom";
const box = "rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-slate-200 focus:outline-none";
const field = `h-9 ${box}`;

export function SettingsPage() {
  const qc = useQueryClient();
  const settings = useSettings();
  const [savedAt, setSavedAt] = useState(0);

  const save = useMutation({
    mutationFn: (patch: Partial<Settings>) => api.updateSettings(patch),
    onSuccess: (s, patch) => {
      qc.setQueryData(["settings"], s);
      setSavedAt(Date.now());
      if (patch.claudePath !== undefined) qc.invalidateQueries({ queryKey: ["claude-info"] });
    },
  });

  const s = settings.data;
  if (settings.error) return <div className="p-6"><ErrorNote>{settings.error.message}</ErrorNote></div>;
  if (!s) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  const set = (patch: Partial<Settings>) => save.mutate(patch);

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6" style={{ "--accent": "#22d3ee" } as CSSProperties}>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="glow-text text-2xl font-semibold tracking-tight text-white">Settings</h1>
          <p className="mt-1 text-sm text-slate-400">Defaults for every project. Changes save as you make them.</p>
        </div>
        <SavedBadge at={savedAt} pending={save.isPending} />
      </div>
      {save.error && <ErrorNote>{save.error.message}</ErrorNote>}

      <Section icon={<MessageSquare size={15} />} title="Chats" hint="What a new chat starts with. You can still change both per chat.">
        <Row label="Default model">
          <ModelPicker value={s.defaultModel} onChange={(defaultModel) => set({ defaultModel })} />
        </Row>
        <Row label="Permission mode" hint={MODES.find((m) => m.value === s.defaultPermissionMode)?.hint}>
          <ModeSelect value={s.defaultPermissionMode} onChange={(defaultPermissionMode) => set({ defaultPermissionMode })} />
        </Row>
      </Section>

      <Section
        icon={<ListChecks size={15} />}
        title="Task sessions"
        hint="Sessions started when a task moves to In progress. Auto-start and the permission mode are set per project, in its settings."
      >
        <Row label="Model">
          <ModelPicker
            value={s.taskModel}
            onChange={(taskModel) => set({ taskModel })}
            emptyLabel={`Same as chats${s.defaultModel ? ` (${MODELS.find((m) => m.value === s.defaultModel)?.label ?? s.defaultModel})` : ""}`}
          />
        </Row>
        <div className="space-y-1.5">
          <span className="text-sm text-slate-200">Extra instructions</span>
          <p className="text-xs text-slate-500">Added to every task's prompt, after the task itself.</p>
          <TextSetting
            multiline
            value={s.taskInstructions}
            placeholder={"e.g. Run the tests and the typechecker before you finish.\nCommit your work with a short message."}
            onSave={(taskInstructions) => set({ taskInstructions })}
          />
        </div>
      </Section>

      <Section icon={<FolderPlus size={15} />} title="New projects" hint="Task automation settings a project gets when you add it.">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={s.newProjectAutoRun}
            onChange={(e) => set({ newProjectAutoRun: e.target.checked })}
            className="accent-[var(--accent)]"
          />
          Start a Claude session when a task moves to In progress
        </label>
        <Row label="Task sessions run in">
          <ModeSelect value={s.newProjectPermissionMode} onChange={(newProjectPermissionMode) => set({ newProjectPermissionMode })} />
        </Row>
      </Section>

      <NotificationSection />

      <ClaudeSection path={s.claudePath} onSave={(claudePath) => set({ claudePath })} />
    </div>
  );
}

function NotificationSection() {
  const [on, setOn] = useState(notificationsOn);
  const [note, setNote] = useState<string>();
  const supported = notificationsSupported();
  const denied = supported && Notification.permission === "denied";

  return (
    <Section
      icon={<Bell size={15} />}
      title="Notifications"
      hint="A desktop notification when Claude needs your approval or an answer, or finishes, while the dashboard isn't in front. Applies to this browser only."
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className={clsx("flex items-center gap-2.5 text-sm text-slate-200", supported && !denied && "cursor-pointer")}>
          <input
            type="checkbox"
            checked={on}
            disabled={!supported || denied}
            onChange={async (e) => {
              const result = await setNotifications(e.target.checked);
              setOn(result);
              setNote(e.target.checked && !result ? "The browser didn't allow notifications." : undefined);
            }}
            className="accent-[var(--accent)]"
          />
          Notify me
        </label>
        {on && (
          <Button size="sm" onClick={() => sendNotification("Mission Control", "Notifications are working.")}>
            Send a test
          </Button>
        )}
      </div>
      {!supported && <p className="text-xs text-amber-300">This browser doesn't support notifications.</p>}
      {denied && (
        <p className="text-xs text-amber-300">Notifications are blocked for this site. Allow them in the browser's site settings, then reload.</p>
      )}
      {note && <p className="text-xs text-amber-300">{note}</p>}
    </Section>
  );
}

function ClaudeSection({ path, onSave }: { path: string; onSave: (p: string) => void }) {
  const info = useQuery({ queryKey: ["claude-info"], queryFn: api.claudeInfo, staleTime: 60_000 });
  return (
    <Section icon={<Terminal size={15} />} title="Claude Code" hint="The CLI every chat and task session runs, with your normal login.">
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs">
        {info.isFetching ? (
          <span className="text-slate-500">Checking…</span>
        ) : info.data?.version ? (
          <>
            <Check size={13} className="shrink-0 text-emerald-400" />
            <span className="text-slate-200">{info.data.version}</span>
          </>
        ) : (
          <span className="text-rose-300">{info.data?.error ?? info.error?.message ?? "Not found"}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-slate-500" title={info.data?.command}>
          {info.data?.command}
        </span>
        <button onClick={() => info.refetch()} className="text-slate-500 hover:text-slate-200" title="Check again">
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="space-y-1.5">
        <span className="text-sm text-slate-200">Path to claude</span>
        <p className="text-xs text-slate-500">Leave empty to use the one on your PATH.</p>
        <TextSetting value={path} placeholder="e.g. C:\Users\you\.local\bin\claude.exe" mono onSave={onSave} />
      </div>
    </Section>
  );
}

function Section({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: string; children: ReactNode }) {
  return (
    <Panel className="p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="mt-0.5 text-[var(--accent)]">{icon}</span>
        <div>
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
        </div>
      </div>
      <div className="space-y-4 pl-7">{children}</div>
    </Panel>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
      <div className="min-w-0">
        <div className="text-sm text-slate-200">{label}</div>
        {hint && <div className="text-xs text-slate-500">{hint}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function ModeSelect({ value, onChange }: { value: PermissionMode; onChange: (m: PermissionMode) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as PermissionMode)} className={field}>
      {MODES.map((m) => (
        <option key={m.value} value={m.value} className="bg-slate-900">
          {m.label}
        </option>
      ))}
    </select>
  );
}

/** A model alias from the list, or any model id typed in. */
function ModelPicker({ value, onChange, emptyLabel }: { value: string; onChange: (m: string) => void; emptyLabel?: string }) {
  const preset = MODELS.some((m) => m.value === value);
  const [custom, setCustom] = useState(!preset);
  const [text, setText] = useState(preset ? "" : value);
  useEffect(() => {
    if (!MODELS.some((m) => m.value === value)) setText(value);
  }, [value]);

  return (
    <>
      <select
        value={custom ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) return setCustom(true);
          setCustom(false);
          onChange(e.target.value);
        }}
        className={field}
      >
        {MODELS.map((m) => (
          <option key={m.value} value={m.value} className="bg-slate-900">
            {m.value === "" && emptyLabel ? emptyLabel : m.label}
          </option>
        ))}
        <option value={CUSTOM} className="bg-slate-900">
          Other model id…
        </option>
      </select>
      {custom && (
        <input
          autoFocus={!value}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text.trim() && text.trim() !== value && onChange(text.trim())}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          placeholder="claude-opus-5-5"
          className={clsx(field, "w-44 font-mono text-xs")}
        />
      )}
    </>
  );
}

/** A text box that saves when you leave it (or press Enter, for single lines). */
function TextSetting({
  value,
  onSave,
  placeholder,
  multiline,
  mono,
}: {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onSave(draft);
  const cls = clsx(box, "w-full", mono && "font-mono text-xs");
  return multiline ? (
    <textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      placeholder={placeholder}
      rows={3}
      className={clsx(cls, "resize-y py-2 leading-relaxed")}
    />
  ) : (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      placeholder={placeholder}
      className={clsx(cls, "h-9")}
    />
  );
}

function SavedBadge({ at, pending }: { at: number; pending: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!at) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 1800);
    return () => clearTimeout(t);
  }, [at]);
  return (
    <span
      className={clsx(
        "flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider transition-opacity",
        pending || visible ? "opacity-100" : "opacity-0",
        pending ? "text-slate-500" : "text-emerald-400",
      )}
    >
      {pending ? (
        "Saving…"
      ) : (
        <>
          <Check size={11} /> Saved
        </>
      )}
    </span>
  );
}
