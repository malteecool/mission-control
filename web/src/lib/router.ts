import { useSyncExternalStore } from "react";

export type Tab = "tasks" | "chat" | "history";
export type Route =
  | { name: "overview" }
  | { name: "settings" }
  | { name: "project"; id: number; tab: Tab; sessionId?: string };

const TABS: Tab[] = ["tasks", "chat", "history"];

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "p" && /^\d+$/.test(parts[1] ?? "")) {
    const tab = TABS.includes(parts[2] as Tab) ? (parts[2] as Tab) : "tasks";
    return { name: "project", id: Number(parts[1]), tab, sessionId: parts[3] };
  }
  return { name: "overview" };
}

export function href(route: Route): string {
  if (route.name === "overview") return "#/";
  if (route.name === "settings") return "#/settings";
  return `#/p/${route.id}/${route.tab}${route.sessionId ? `/${route.sessionId}` : ""}`;
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
