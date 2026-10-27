import type { PermissionMode } from "./api.ts";

// Aliases follow the newest model of each family; full ids pin one version. Any other id works too: the settings
// page takes a custom one.
export const MODEL_GROUPS: Array<{ label: string; models: Array<{ value: string; label: string }> }> = [
  {
    label: "Latest",
    models: [
      { value: "", label: "Default model" },
      { value: "opus", label: "Opus" },
      { value: "sonnet", label: "Sonnet" },
      { value: "haiku", label: "Haiku" },
    ],
  },
  {
    label: "Claude 5",
    models: [
      { value: "claude-fable-5-1", label: "Fable 5.1 (usage credits)" },
      { value: "claude-opus-5-5", label: "Opus 5.5" },
      { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
      { value: "claude-haiku-5-5", label: "Haiku 5.5" },
    ],
  },
  {
    label: "Claude 4",
    models: [
      { value: "claude-opus-4-5", label: "Opus 4.5" },
      { value: "claude-sonnet-4-5", label: "Sonnet 4.5" },
      { value: "claude-haiku-4-5", label: "Haiku 4.5" },
    ],
  },
];

export const MODELS = MODEL_GROUPS.flatMap((g) => g.models);

export const MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: "default", label: "Ask first", hint: "Claude asks you before it edits files or runs commands" },
  { value: "acceptEdits", label: "Accept edits", hint: "Claude edits files without asking, and asks before shell commands" },
  { value: "plan", label: "Plan only", hint: "Claude explores and proposes a plan without changing anything" },
  { value: "bypassPermissions", label: "Full access", hint: "Claude may run any tool, including shell commands. Use with care." },
];

export const modelLabel = (m: string) => MODELS.find((x) => x.value === m)?.label ?? m;
