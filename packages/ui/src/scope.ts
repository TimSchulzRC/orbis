// The workspace a part of the page belongs to; null means the open one. Multi-workspace views
// (sidebar, Today, inbox, activity, trash) wrap each block in its own SpaceScope.
import { createContext } from "react";
import type { Repo } from "@obtion/sync";
import type { DeviceFiles } from "./files";

export const ScopeContext = createContext<{ id: string; repo: Repo; files: DeviceFiles } | null>(null);

/** Pages that show every workspace. "settings" with a `space` in the address is that workspace's own page. */
export const globalPage = (parts: string[], space?: string) =>
  !parts.length || (parts[0] === "inbox" && !parts[1]) || ["review", "search", "activity", "trash"].includes(parts[0]!) || (parts[0] === "settings" && !space);
