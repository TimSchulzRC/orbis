// The workspace a part of the page belongs to. Without one (most of the app) it is the open
// workspace; the sidebar, Heute, the inbox, activity and trash show every workspace seen, each block in its own (SpaceScope).
import { createContext } from "react";
import type { Repo } from "@obtion/sync";
import type { DeviceFiles } from "./files";

export const ScopeContext = createContext<{ id: string; repo: Repo; files: DeviceFiles } | null>(null);

/**
 * Pages of no workspace: Heute, the inbox, the review, search, activity, trash and the settings
 * show every workspace (or the ones seen). Every other page belongs to the workspace in the address –
 * "settings" with one named (`space`) too: that workspace's own.
 */
export const globalPage = (parts: string[], space?: string) =>
  !parts.length || (parts[0] === "inbox" && !parts[1]) || ["review", "search", "c", "activity", "trash"].includes(parts[0]!) || (parts[0] === "settings" && !space);
