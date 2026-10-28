import { useSyncExternalStore } from "react";

export type Tab = "tasks" | "chat" | "history" | "files" | "dev" | "usage";
export type Route =
  | { name: "overview" }
  | { name: "settings" }
  | { name: "project"; id: number; tab: Tab; sessionId?: string; filePath?: string };

const TABS: Tab[] = ["tasks", "chat", "history", "files", "dev", "usage"];

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "p" && /^\d+$/.test(parts[1] ?? "")) {
    const tab = TABS.includes(parts[2] as Tab) ? (parts[2] as Tab) : "tasks";
    // The Files tab keeps the open file's path as one encoded segment.
    if (tab === "files") return { name: "project", id: Number(parts[1]), tab, filePath: decode(parts[3]) };
    return { name: "project", id: Number(parts[1]), tab, sessionId: parts[3] };
  }
  return { name: "overview" };
}

function decode(segment?: string) {
  try {
    return segment ? decodeURIComponent(segment) : undefined;
  } catch {
    return undefined;
  }
}

export function href(route: Route): string {
  if (route.name === "overview") return "#/";
  if (route.name === "settings") return "#/settings";
  const sub = route.tab === "files" ? route.filePath && encodeURIComponent(route.filePath) : route.sessionId;
  return `#/p/${route.id}/${route.tab}${sub ? `/${sub}` : ""}`;
}

export function navigate(route: Route) {
  window.location.hash = href(route);
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parse(hash);
}
