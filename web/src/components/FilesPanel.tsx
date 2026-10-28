import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, ChevronRight, File, FileImage, FileText, Folder, FolderOpen, FolderTree, RefreshCw } from "lucide-react";
import { api, type FileEntry } from "../lib/api.ts";
import { href } from "../lib/router.ts";
import { formatBytes, timeAgo } from "../lib/util.ts";
import { Button, Empty, ErrorNote, IconButton } from "./ui.tsx";
import { Markdown } from "./Transcript.tsx";

/** "a/b/c.ts" → ["a", "a/b"]: the folders to open so the file shows in the tree. */
const ancestors = (p: string) => p.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));

export function FilesPanel({ projectId, filePath }: { projectId: number; filePath?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<Set<string>>(() => new Set(filePath ? ancestors(filePath) : []));

  // Following a link to a file deep in the tree opens the folders on the way.
  useEffect(() => {
    if (filePath) setOpen((o) => (ancestors(filePath).every((a) => o.has(a)) ? o : new Set([...o, ...ancestors(filePath)])));
  }, [filePath]);

  const toggle = (dir: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(dir)) next.add(dir);
      return next;
    });

  return (
    <div className="grid h-full min-h-0 lg:grid-cols-[320px_1fr]">
      <div className={clsx("flex min-h-0 flex-col border-white/[0.06] lg:border-r", filePath && "hidden lg:flex")}>
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <span className="hud-label">Project files</span>
          <div className="flex">
            <IconButton title="Collapse all" onClick={() => setOpen(new Set())}>
              <FolderTree size={13} />
            </IconButton>
            <IconButton
              title="Refresh"
              onClick={() => {
                qc.invalidateQueries({ queryKey: ["files", projectId] });
                qc.invalidateQueries({ queryKey: ["file", projectId] });
              }}
            >
              <RefreshCw size={13} />
            </IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <DirChildren projectId={projectId} dir="" depth={0} open={open} toggle={toggle} selected={filePath} />
        </div>
      </div>

      <div className={clsx("min-h-0", !filePath && "hidden lg:block")}>
        {filePath ? (
          <FileViewer projectId={projectId} path={filePath} />
        ) : (
          <Empty icon={<FileText size={20} />} title="Pick a file">
            Browse the project's folders on the left and open any file to read it.
          </Empty>
        )}
      </div>
    </div>
  );
}

function DirChildren({
  projectId,
  dir,
  depth,
  open,
  toggle,
  selected,
}: {
  projectId: number;
  dir: string;
  depth: number;
  open: Set<string>;
  toggle: (dir: string) => void;
  selected?: string;
}) {
  const listing = useQuery({ queryKey: ["files", projectId, dir], queryFn: () => api.files(projectId, dir) });
  const indent = { paddingLeft: 8 + depth * 14 };

  if (listing.isLoading) return <div style={indent} className="py-1 text-xs text-slate-500">Loading…</div>;
  if (listing.error) return <div style={indent} className="py-1 text-xs text-rose-300">{listing.error.message}</div>;
  const entries = listing.data?.entries ?? [];
  if (!entries.length) return <div style={indent} className="py-1 text-xs italic text-slate-600">empty</div>;

  return (
    <ul>
      {entries.map((e) => (
        <li key={e.path}>
          {e.type === "dir" ? (
            <>
              <button
                onClick={() => toggle(e.path)}
                style={indent}
                className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm text-slate-300 hover:bg-white/[0.04] hover:text-white"
              >
                <ChevronRight size={12} className={clsx("shrink-0 text-slate-500 transition", open.has(e.path) && "rotate-90")} />
                {open.has(e.path) ? (
                  <FolderOpen size={14} className="shrink-0 text-[var(--accent)]" />
                ) : (
                  <Folder size={14} className="shrink-0 text-[var(--accent)]" />
                )}
                <span className="truncate">{e.name}</span>
              </button>
              {open.has(e.path) && (
                <DirChildren projectId={projectId} dir={e.path} depth={depth + 1} open={open} toggle={toggle} selected={selected} />
              )}
            </>
          ) : (
            <FileRow projectId={projectId} entry={e} indent={indent} active={e.path === selected} />
          )}
        </li>
      ))}
      {listing.data?.truncated && (
        <li style={indent} className="py-1 text-xs text-slate-500">
          Only the first {entries.length} entries are shown.
        </li>
      )}
    </ul>
  );
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;

function FileRow({ projectId, entry, indent, active }: { projectId: number; entry: FileEntry; indent: { paddingLeft: number }; active: boolean }) {
  const Icon = IMAGE_EXT.test(entry.name) ? FileImage : /\.(md|txt)$/i.test(entry.name) ? FileText : File;
  return (
    <a
      href={href({ name: "project", id: projectId, tab: "files", filePath: entry.path })}
      style={indent}
      title={`${entry.path} · ${formatBytes(entry.size)} · changed ${timeAgo(entry.modifiedAt)}`}
      className={clsx(
        "flex items-center gap-1.5 rounded-md py-1 pr-2 text-sm",
        active
          ? "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-white"
          : "text-slate-400 hover:bg-white/[0.04] hover:text-white",
      )}
    >
      <span className="w-3 shrink-0" />
      <Icon size={14} className="shrink-0 text-slate-500" />
      <span className="truncate">{entry.name}</span>
    </a>
  );
}

function FileViewer({ projectId, path }: { projectId: number; path: string }) {
  const file = useQuery({ queryKey: ["file", projectId, path], queryFn: () => api.fileContent(projectId, path) });
  const markdown = /\.(md|markdown|mdx)$/i.test(path);
  const [source, setSource] = useState(false);
  const f = file.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/[0.06] px-5 py-3">
        <a href={href({ name: "project", id: projectId, tab: "files" })} className="text-slate-400 hover:text-white lg:hidden">
          <ArrowLeft size={15} />
        </a>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200" title={path}>
          {path}
        </span>
        {f && (
          <span className="font-mono text-[11px] text-slate-500">
            {formatBytes(f.size)} · changed {timeAgo(f.modifiedAt)}
          </span>
        )}
        {markdown && f?.text !== undefined && (
          <Button size="sm" onClick={() => setSource((s) => !s)}>
            {source ? "Preview" : "Source"}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {file.isLoading && <div className="p-5 text-sm text-slate-500">Reading file…</div>}
        {file.error && (
          <div className="p-5">
            <ErrorNote>{file.error.message}</ErrorNote>
          </div>
        )}
        {f?.image && (
          <div className="flex justify-center p-6">
            <img
              src={api.fileRawUrl(projectId, path)}
              alt={path}
              className="max-h-[75vh] max-w-full rounded-lg border border-white/10 bg-[repeating-conic-gradient(#ffffff0a_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]"
            />
          </div>
        )}
        {f?.binary && !f.image && (
          <Empty icon={<File size={20} />} title="Binary file">
            This file isn't text, so there's nothing to show here.
          </Empty>
        )}
        {f?.text !== undefined &&
          (markdown && !source ? (
            <div className="mx-auto max-w-3xl p-6">
              <Markdown text={f.text} />
            </div>
          ) : (
            <TextView text={f.text} />
          ))}
        {f?.truncated && (
          <div className="border-t border-white/[0.06] px-5 py-2 text-xs text-amber-300">
            The file is {formatBytes(f.size)}; only the first 512 KB are shown.
          </div>
        )}
      </div>
    </div>
  );
}

function TextView({ text }: { text: string }) {
  if (!text) return <div className="p-5 text-sm italic text-slate-500">Empty file</div>;
  const lines = text.split(/\r?\n/).length;
  return (
    <div className="flex min-w-max font-mono text-[12px] leading-5">
      <pre aria-hidden className="sticky left-0 select-none border-r border-white/[0.06] bg-[var(--color-void)] px-3 py-3 text-right text-slate-600">
        {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
      </pre>
      <pre className="px-4 py-3 text-slate-200">{text}</pre>
    </div>
  );
}
