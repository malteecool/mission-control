import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Command } from "lucide-react";
import { api } from "./lib/api.ts";
import { useRoute } from "./lib/router.ts";
import { useRefreshOnRunFinished } from "./lib/runs.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { AddProjectDialog } from "./components/AddProjectDialog.tsx";
import { Overview } from "./components/Overview.tsx";
import { ProjectView } from "./components/ProjectView.tsx";
import { SettingsPage } from "./components/SettingsPage.tsx";
import { useSettings } from "./lib/settings.ts";
import { useNotifications } from "./lib/notify.ts";
import { Kbd } from "./components/ui.tsx";

export function App() {
  const route = useRoute();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects, refetchInterval: 30_000 });
  useRefreshOnRunFinished();
  useSettings();
  useNotifications(projects.data ?? []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = route.name === "project" ? projects.data?.find((p) => p.id === route.id) : undefined;

  return (
    <>
      <div className="backdrop" />
      <div className="relative z-10 grid h-full grid-cols-1 md:grid-cols-[272px_1fr]">
        <Sidebar projects={projects.data ?? []} loading={projects.isLoading} onAdd={() => setAddOpen(true)} />
        <main className="flex min-h-0 min-w-0 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-white/[0.06] px-6">
            <div className="hud-label truncate">
              {route.name === "overview"
                ? "// overview"
                : route.name === "settings"
                  ? "// settings"
                  : `// projects / ${current?.name ?? "…"} / ${route.tab}`}
            </div>
            <button
              onClick={() => setPaletteOpen(true)}
              className="flex h-8 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-xs text-slate-400 transition hover:border-white/20 hover:text-slate-200"
            >
              <Command size={13} />
              <span className="hidden sm:inline">Jump to…</span>
              <Kbd>Ctrl K</Kbd>
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {route.name === "overview" ? (
              <Overview projects={projects.data ?? []} onAdd={() => setAddOpen(true)} />
            ) : route.name === "settings" ? (
              <SettingsPage />
            ) : (
              <ProjectView key={route.id} route={route} />
            )}
          </div>
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        projects={projects.data ?? []}
        route={route}
        onAddProject={() => setAddOpen(true)}
      />
      <AddProjectDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}
