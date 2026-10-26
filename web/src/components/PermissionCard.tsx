import { useState } from "react";
import { motion } from "framer-motion";
import { Check, CheckCheck, ShieldQuestion, X } from "lucide-react";
import type { PermissionReply, PermissionRequest } from "../lib/api.ts";
import { Button } from "./ui.tsx";

const MAX_PREVIEW = 4000;

function clip(s: string): string {
  return s.length > MAX_PREVIEW ? s.slice(0, MAX_PREVIEW) + "\n… (truncated)" : s;
}

/** A readable view of what the tool is about to do, for the tools you approve most often. */
function Preview({ toolName, input }: { toolName: string; input: any }) {
  const pre = "max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg p-2.5 font-mono text-[11.5px]";
  if (!input || typeof input !== "object") return null;

  if ((toolName === "Bash" || toolName === "PowerShell") && typeof input.command === "string")
    return <pre className={`${pre} bg-black/50 text-slate-200`}>$ {clip(input.command)}</pre>;

  if (toolName === "Edit" && typeof input.file_path === "string")
    return (
      <div className="space-y-1.5">
        <div className="truncate font-mono text-[11px] text-slate-400">{input.file_path}</div>
        <pre className={`${pre} bg-rose-500/10 text-rose-200`}>{clip(String(input.old_string ?? ""))}</pre>
        <pre className={`${pre} bg-emerald-500/10 text-emerald-200`}>{clip(String(input.new_string ?? ""))}</pre>
        {input.replace_all && <div className="font-mono text-[10px] text-slate-500">replaces every occurrence</div>}
      </div>
    );

  if (toolName === "Write" && typeof input.file_path === "string")
    return (
      <div className="space-y-1.5">
        <div className="truncate font-mono text-[11px] text-slate-400">{input.file_path}</div>
        <pre className={`${pre} bg-emerald-500/10 text-emerald-200`}>{clip(String(input.content ?? ""))}</pre>
      </div>
    );

  return <pre className={`${pre} bg-black/50 text-slate-400`}>{clip(JSON.stringify(input, null, 2))}</pre>;
}

export function PermissionCard({
  request: r,
  onAnswer,
}: {
  request: PermissionRequest;
  onAnswer: (reply: PermissionReply) => void;
}) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="ml-9 rounded-xl border border-amber-400/40 bg-amber-400/[0.06] shadow-[0_0_30px_-12px_rgb(251_191_36/0.6)]"
    >
      <div className="flex items-center gap-2 border-b border-amber-400/20 px-3.5 py-2.5">
        <ShieldQuestion size={14} className="text-amber-300" />
        <span className="text-sm text-amber-100">
          Claude wants to use <span className="font-mono font-medium">{r.toolName}</span>
        </span>
        <span className="ml-auto animate-pulse font-mono text-[10px] uppercase tracking-wider text-amber-300/80">
          waiting for you
        </span>
      </div>
      <div className="space-y-2.5 p-3.5">
        {r.summary && <div className="text-sm text-slate-200">{r.summary}</div>}
        <Preview toolName={r.toolName} input={r.input} />

        {denying ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onAnswer({ requestId: r.requestId, allow: false, message: reason });
            }}
          >
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Tell Claude what to do instead (optional)"
              className="accent-ring h-8 flex-1 rounded-lg border border-white/10 bg-black/30 px-2.5 text-xs text-white placeholder:text-slate-500"
            />
            <Button size="sm" variant="danger" type="submit">
              <X size={12} /> Deny
            </Button>
            <Button size="sm" type="button" onClick={() => setDenying(false)}>
              Back
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => onAnswer({ requestId: r.requestId, allow: true })}>
              <Check size={12} /> Allow
            </Button>
            {r.canAlways && (
              <Button
                size="sm"
                onClick={() => onAnswer({ requestId: r.requestId, allow: true, always: true })}
                title="Allow, and save a rule in this project's .claude/settings.local.json so Claude doesn't ask again for calls like this"
              >
                <CheckCheck size={12} /> Always allow in this project
              </Button>
            )}
            <Button size="sm" variant="danger" onClick={() => setDenying(true)}>
              <X size={12} /> Deny…
            </Button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
