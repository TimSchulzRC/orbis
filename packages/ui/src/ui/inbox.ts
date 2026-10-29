// The inbox of the workspaces seen, built once for every view of it: the tray and its panel, the
// review, Heute, the sidebar and the phone's bar. Each entry is sorted in its own workspace; ids are
// unique within a workspace only, so an entry is known by its key "<workspace>/<id>".
import { useSyncExternalStore } from "react";
import type { Item } from "@obtion/core/model";
import { SETTINGS_ID } from "@obtion/core/model";
import { runQuery } from "@obtion/core/query";
import { useAccounts } from "../accounts";
import { useReplicas } from "./Spaces";

export interface InboxEntry {
  key: string;
  space: string;
  item: Item;
}

export const entryKey = (space: string, id: string) => `${space}/${id}`;

/** The entries waiting in the inboxes of the workspaces seen, newest first. */
export function useInboxItems(): InboxEntry[] {
  const { shown } = useAccounts();
  const repos = useReplicas(shown.map((s) => s.id));
  return shown
    .flatMap((s, n) => {
      const r = repos[n]!;
      if (!r.get(SETTINGS_ID)) return [];
      return runQuery({ where: { inbox: true } }, { ix: r.index() }).items.map((item) => ({ key: entryKey(s.id, item.id), space: s.id, item }));
    })
    .sort((a, b) => b.item.created - a.item.created);
}

/** How long a review takes, roughly: some 20 seconds an entry, at least a minute. */
export const reviewMinutes = (count: number) => Math.max(1, Math.round(count / 3));

// ---------- the tray's panel ----------

/** The tray's panel: closed, the list, or one entry in it (its key). One for the whole app. */
let shelf: { open: boolean; at?: string } = { open: false };
/** The entry opened last in the panel, and when: a capture may be added to it (Capture.tsx). */
let opened: { key: string; at: number } | undefined;
const listeners = new Set<() => void>();
const setShelf = (s: typeof shelf) => ((shelf = s), listeners.forEach((f) => f()));
export const openShelf = (at?: string) => ((opened = at ? { key: at, at: Date.now() } : opened), setShelf({ open: true, at }));
/** The entry opened last, if it is in this workspace. */
export const openedIn = (space: string) => (opened?.key.startsWith(space + "/") ? { id: opened.key.slice(space.length + 1), at: opened.at } : undefined);
export const closeShelf = () => shelf.open && setShelf({ open: false });

export function useShelf() {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => shelf,
  );
}
