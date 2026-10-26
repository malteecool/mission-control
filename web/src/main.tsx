import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.tsx";
import { setOnTurnFinished } from "./lib/chatStore.ts";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 1 } },
});

// A finished chat turn may have edited tasks, created a session or changed git state.
setOnTurnFinished((projectId) => {
  for (const key of [["sessions", projectId], ["tasks", projectId], ["project", projectId], ["projects"], ["overview"]])
    queryClient.invalidateQueries({ queryKey: key });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
