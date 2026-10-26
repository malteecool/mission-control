import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Sparkles } from "lucide-react";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { timeAgo } from "../lib/util.ts";
import { Button, ErrorNote, Modal, ModalHeader } from "./ui.tsx";

export function AddProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [path, setPath] = useState("");
  const discovered = useQuery({ queryKey: ["discover"], queryFn: api.discover, enabled: open });

  const add = useMutation({
    mutationFn: (p: string) => api.addProject({ path: p }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["discover"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      setPath("");
    },
  });

  const close = () => {
    add.reset();
    onClose();
  };

  return (
    <Modal open={open} onClose={close}>
      <ModalHeader title="Add project" onClose={close} />
      <div className="space-y-5 p-5">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim())
              add.mutate(path.trim(), {
                onSuccess: (p) => {
                  close();
                  navigate({ name: "project", id: p.id, tab: "tasks" });
                },
              });
          }}
        >
          <label className="hud-label" htmlFor="project-path">
            Folder path
          </label>
          <div className="flex gap-2">
            <input
              id="project-path"
              autoFocus
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\Users\you\Documents\Code\my-project"
              className="accent-ring h-9 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-xs text-white placeholder:text-slate-600"
            />
            <Button variant="primary" type="submit" disabled={!path.trim() || add.isPending}>
              <FolderPlus size={14} /> Add
            </Button>
          </div>
          {add.error && <ErrorNote>{add.error.message}</ErrorNote>}
        </form>

        <div>
          <div className="mb-2 flex items-center gap-2">
            <Sparkles size={13} className="text-violet-300" />
            <span className="hud-label">Found in your Claude history</span>
          </div>
          {discovered.isLoading && <div className="text-xs text-slate-500">Scanning…</div>}
          {discovered.data?.length === 0 && (
            <div className="text-xs text-slate-500">Every folder you've used Claude in is already added.</div>
          )}
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {discovered.data?.map((d) => (
              <li
                key={d.path}
                className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-slate-200">{d.name}</div>
                  <div className="truncate font-mono text-[10px] text-slate-500">
                    {d.path} · {d.sessionCount} session{d.sessionCount === 1 ? "" : "s"} · {timeAgo(d.lastActiveAt)}
                  </div>
                </div>
                <Button size="sm" onClick={() => add.mutate(d.path)} disabled={add.isPending}>
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
