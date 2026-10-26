import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { setChatDefaults } from "./chatStore.ts";

/** Dashboard-wide settings. Mounted once in App so new chats pick up the default model and mode. */
export function useSettings() {
  const q = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: Infinity });
  useEffect(() => {
    if (q.data) setChatDefaults({ model: q.data.defaultModel, permissionMode: q.data.defaultPermissionMode });
  }, [q.data]);
  return q;
}
