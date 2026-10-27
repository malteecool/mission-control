import { useState } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { Check, MessageCircleQuestion, Send } from "lucide-react";
import type { AskQuestion, PermissionReply, PermissionRequest } from "../lib/api.ts";
import { Button } from "./ui.tsx";

interface Choice {
  picked: string[];
  other: string;
}

/** Parse AskUserQuestion's input defensively; null means it isn't in the shape we can render. */
export function askQuestions(input: unknown): AskQuestion[] | null {
  const qs = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(qs) || !qs.length) return null;
  const ok = qs.every(
    (q) => typeof q?.question === "string" && Array.isArray(q.options) && q.options.every((o: any) => typeof o?.label === "string"),
  );
  return ok ? (qs as AskQuestion[]) : null;
}

/** The answer string Claude Code expects: the chosen labels (plus any typed text), comma-separated. */
function answerFor(c: Choice): string {
  return [...c.picked, c.other.trim()].filter(Boolean).join(", ");
}

export function QuestionCard({
  request: r,
  questions,
  onAnswer,
  className = "ml-9",
}: {
  request: PermissionRequest;
  questions: AskQuestion[];
  onAnswer: (reply: PermissionReply) => void;
  /** Placement; defaults to the indent used in the transcript. */
  className?: string;
}) {
  const [choices, setChoices] = useState<Choice[]>(() => questions.map(() => ({ picked: [], other: "" })));
  const complete = choices.every((c) => answerFor(c));

  const update = (i: number, fn: (c: Choice) => Choice) => setChoices((cs) => cs.map((c, j) => (j === i ? fn(c) : c)));

  const toggle = (i: number, label: string, multi: boolean) =>
    update(i, (c) => {
      if (multi) return { ...c, picked: c.picked.includes(label) ? c.picked.filter((l) => l !== label) : [...c.picked, label] };
      // Single choice: picking an option replaces any typed "other" answer.
      return { picked: c.picked[0] === label ? [] : [label], other: "" };
    });

  const submit = () => {
    if (!complete) return;
    onAnswer({
      requestId: r.requestId,
      allow: true,
      answers: Object.fromEntries(questions.map((q, i) => [q.question, answerFor(choices[i])])),
    });
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={clsx(className, "rounded-xl border border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] shadow-[0_0_30px_-12px_var(--accent)]")}
    >
      <div className="flex items-center gap-2 border-b border-white/[0.08] px-3.5 py-2.5">
        <MessageCircleQuestion size={14} className="text-[var(--accent)]" />
        <span className="text-sm text-slate-100">
          Claude has {questions.length === 1 ? "a question" : `${questions.length} questions`} for you
        </span>
        <span className="ml-auto animate-pulse font-mono text-[10px] uppercase tracking-wider text-[var(--accent)]">
          waiting for you
        </span>
      </div>

      <form
        className="space-y-5 p-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {questions.map((q, i) => {
          const c = choices[i];
          const multi = !!q.multiSelect;
          return (
            <fieldset key={i} className="space-y-2">
              <legend className="mb-2 flex flex-wrap items-center gap-2">
                {q.header && (
                  <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-300">
                    {q.header}
                  </span>
                )}
                <span className="text-sm font-medium text-white">{q.question}</span>
                {multi && <span className="font-mono text-[10px] text-slate-500">pick any</span>}
              </legend>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {q.options.map((o) => {
                  const on = c.picked.includes(o.label);
                  return (
                    <button
                      key={o.label}
                      type="button"
                      role={multi ? "checkbox" : "radio"}
                      aria-checked={on}
                      onClick={() => toggle(i, o.label, multi)}
                      className={clsx(
                        "flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition",
                        on
                          ? "border-[color-mix(in_srgb,var(--accent)_70%,transparent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]"
                          : "border-white/10 bg-black/20 hover:border-white/25",
                      )}
                    >
                      <span
                        className={clsx(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border",
                          multi ? "rounded" : "rounded-full",
                          on ? "border-[var(--accent)] bg-[var(--accent)] text-slate-950" : "border-white/25",
                        )}
                      >
                        {on && <Check size={11} strokeWidth={3} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm text-slate-100">{o.label}</span>
                        {o.description && o.description !== o.label && (
                          <span className="mt-0.5 block text-xs text-slate-400">{o.description}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
              <input
                value={c.other}
                onChange={(e) => {
                  const other = e.target.value;
                  // For single choice, typing your own answer replaces the picked option.
                  update(i, (prev) => ({ picked: multi || !other ? prev.picked : [], other }));
                }}
                placeholder={multi ? "Anything else? (optional)" : "Or type your own answer"}
                className="accent-ring h-8 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 text-xs text-white placeholder:text-slate-500"
              />
            </fieldset>
          );
        })}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" type="submit" disabled={!complete}>
            <Send size={12} /> Send answer{questions.length === 1 ? "" : "s"}
          </Button>
          <Button
            size="sm"
            type="button"
            onClick={() => onAnswer({ requestId: r.requestId, allow: false, message: "The user skipped these questions." })}
          >
            Skip
          </Button>
          {!complete && <span className="font-mono text-[10px] text-slate-500">answer every question to send</span>}
        </div>
      </form>
    </motion.div>
  );
}
