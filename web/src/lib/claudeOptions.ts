import type { PermissionMode } from "./api.ts";

// Model aliases Claude Code accepts. Any full model id (e.g. claude-opus-5-5) works too; the pickers allow a custom one.
export const MODELS = [
  { value: "", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

export const MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: "default", label: "Ask first", hint: "Claude asks you before it edits files or runs commands" },
  { value: "acceptEdits", label: "Accept edits", hint: "Claude edits files without asking, and asks before shell commands" },
  { value: "plan", label: "Plan only", hint: "Claude explores and proposes a plan without changing anything" },
  { value: "bypassPermissions", label: "Full access", hint: "Claude may run any tool, including shell commands. Use with care." },
];

export const modelLabel = (m: string) => MODELS.find((x) => x.value === m)?.label ?? m;
