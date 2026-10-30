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
const listeners = new Set<() => void>();
const setShelf = (s: typeof shelf) => ((shelf = s), listeners.forEach((f) => f()));
export const openShelf = (at?: string) => setShelf({ open: true, at });
export const closeShelf = () => shelf.open && setShelf({ open: false });

/** Pinned open on Heute (a desktop with room below the page, App.tsx): Heute then leaves out its own sight of the entries. */
let pinned = false;
const pinListeners = new Set<() => void>();
export const setShelfPinned = (p: boolean) => p !== pinned && ((pinned = p), pinListeners.forEach((f) => f()));
export const useShelfPinned = () =>
  useSyncExternalStore(
    (f) => (pinListeners.add(f), () => pinListeners.delete(f)),
    () => pinned,
  );

export function useShelf() {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => shelf,
  );
}
