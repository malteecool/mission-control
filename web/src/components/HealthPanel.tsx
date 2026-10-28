import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDownToLine, ArrowUpFromLine, CircleCheck, CircleX, CloudOff, FileDiff, FlaskConical, GitBranch } from "lucide-react";
import { api, type ProjectHealth, type ProjectSummary } from "../lib/api.ts";
import { href } from "../lib/router.ts";
import { timeAgo } from "../lib/util.ts";
import { Dot, ErrorNote, Panel } from "./ui.tsx";

type Tone = "ok" | "warn" | "bad" | "muted";

const TONE: Record<Tone, string> = {
  ok: "text-slate-400",
  warn: "border-amber-400/20 bg-amber-400/10 text-amber-300",
  bad: "border-rose-500/25 bg-rose-500/10 text-rose-300",
  muted: "text-slate-600",
};

function Chip({ tone, icon, title, children }: { tone: Tone; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-transparent px-1.5 py-0.5 font-mono text-[10px]",
        TONE[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** How many things need attention; projects with more sort first. */
function problems(h: ProjectHealth): number {
  return (
    (h.uncommitted > 0 ? 1 : 0) +
    (h.unpushed > 0 ? 1 : 0) +
    (h.staleBranches.length > 0 ? 1 : 0) +
    (h.lastTest && !h.lastTest.passed ? 2 : 0)
  );
}

/** Per project: uncommitted changes, unpushed commits, the last test Claude ran, and stale branches. */
export function HealthPanel({ projects }: { projects: ProjectSummary[] }) {
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 60_000 });
  if (health.isError) return <ErrorNote>{health.error.message}</ErrorNote>;

  const byId = new Map(projects.map((p) => [p.id, p]));
  const rows = (health.data ?? [])
    .filter((h) => byId.has(h.projectId))
    .sort((a, b) => problems(b) - problems(a));

  return (
    <Panel className="p-2">
      {!health.data && <div className="p-3 text-sm text-slate-500">Loading…</div>}
      <ul>
        {rows.map((h) => {
          const p = byId.get(h.projectId)!;
          return (
            <li key={h.projectId}>
              <a
                href={href({ name: "project", id: p.id, tab: "tasks" })}
                className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-white/[0.04]"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <Dot color={p.color} />
                  <span className="truncate text-sm text-slate-200">{p.name}</span>
                  {h.branch && <span className="truncate font-mono text-[10px] text-slate-500">⎇ {h.branch}</span>}
                </span>
                <HealthChips h={h} />
              </a>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function HealthChips({ h }: { h: ProjectHealth }) {
  if (!h.exists) return <span className="font-mono text-[10px] text-rose-300">folder missing</span>;
  const t = h.lastTest;
  // Fixed-width slots so the same signal lines up from row to row.
  return (
    <span className="grid shrink-0 grid-cols-[4rem_7.5rem_5.5rem_8.5rem] items-center justify-items-end gap-1.5">
      {h.isRepo ? (
        <>
          <Chip
            tone={h.uncommitted ? "warn" : "ok"}
            icon={<FileDiff size={11} />}
            title={h.uncommitted ? `${h.uncommitted} files with uncommitted changes` : "Working tree clean"}
          >
            {h.uncommitted || "clean"}
          </Chip>
          {h.hasRemote ? (
            <Chip
              tone={h.unpushed || h.behind ? "warn" : "ok"}
              icon={<ArrowUpFromLine size={11} />}
              title={
                h.noUpstream
                  ? `${h.branch} isn't tracking a remote branch; ${h.unpushed} commits aren't on any remote`
                  : h.unpushed
                    ? `${h.unpushed} commits not pushed`
                    : "Everything pushed"
              }
            >
              {h.unpushed}
              {h.noUpstream && " · no upstream"}
              {h.behind > 0 && (
                <span className="inline-flex items-center gap-0.5" title={`${h.behind} commits on the remote to pull (as of the last fetch)`}>
                  <ArrowDownToLine size={11} className="ml-1" />
                  {h.behind}
                </span>
              )}
            </Chip>
          ) : (
            <Chip tone="muted" icon={<CloudOff size={11} />} title="No remote configured, so nothing is backed up">
              no remote
            </Chip>
          )}
          {h.staleBranches.length > 0 ? (
            <Chip
              tone="warn"
              icon={<GitBranch size={11} />}
              title={
                "Stale branches (no commits in 30 days, or deleted on the remote):\n" +
                h.staleBranches.map((b) => `${b.name} · ${b.gone ? "gone on remote" : timeAgo(b.lastCommitAt)}`).join("\n")
              }
            >
              {h.staleBranches.length} stale
            </Chip>
          ) : (
            <span />
          )}
        </>
      ) : (
        <>
          <span />
          <span />
          <Chip tone="muted" icon={<GitBranch size={11} />} title="Not a git repository">
            no git
          </Chip>
        </>
      )}
      {t ? (
        <Chip
          tone={t.passed ? "ok" : "bad"}
          icon={t.passed ? <CircleCheck size={11} className="text-emerald-400" /> : <CircleX size={11} />}
          title={`Last test Claude ran: ${t.command}${t.summary ? `\n${t.summary}` : ""}`}
        >
          {t.passed ? "passed" : "failed"} {timeAgo(t.at)}
        </Chip>
      ) : (
        <Chip tone="muted" icon={<FlaskConical size={11} />} title="No test runs in the project's recent Claude sessions">
          no tests
        </Chip>
      )}
    </span>
  );
}
