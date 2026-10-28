// The workspace a part of the page belongs to. Without one (most of the app) it is the open
// workspace; the sidebar and the inbox show every workspace, each block in its own (SpaceScope).
import { createContext } from "react";
import type { Repo } from "@obtion/sync";
import type { DeviceFiles } from "./files";

export const ScopeContext = createContext<{ id: string; repo: Repo; files: DeviceFiles } | null>(null);
