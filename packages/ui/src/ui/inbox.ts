// Ids are unique within a workspace only, so an inbox entry is keyed "<workspace>/<id>".
import { type Item, SETTINGS_ID } from "@obtion/core/model";
import { runQuery } from "@obtion/core/query";
import { laterItems } from "@obtion/core/placement";
import { useAccounts } from "../accounts";
import { useReplicas } from "./Spaces";
import { createStore } from "../lib/store";

export interface InboxEntry {
  key: string;
  space: string;
  item: Item;
}

export const entryKey = (space: string, id: string) => `${space}/${id}`;

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

/** Set aside with "Morgen wieder", out of the inbox until tomorrow. */
export function useLaterItems(): InboxEntry[] {
  const { shown } = useAccounts();
  const repos = useReplicas(shown.map((s) => s.id));
  return shown
    .flatMap((s, n) => {
      const r = repos[n]!;
      if (!r.get(SETTINGS_ID)) return [];
      return laterItems(r.index()).map((item) => ({ key: entryKey(s.id, item.id), space: s.id, item }));
    })
    .sort((a, b) => b.item.created - a.item.created);
}

const REVIEW_SECONDS_PER_ENTRY = 20;
export const reviewMinutes = (count: number) => Math.max(1, Math.round((count * REVIEW_SECONDS_PER_ENTRY) / 60));

/**
 * The open panel is a history step, so Back closes it instead of leaving the app on a phone. On
 * Heute that step is "#/inbox", elsewhere the page's own address once more.
 */
const shelf = createStore<{ open: boolean; at?: string }>({ open: false });
const onInbox = () => location.hash.split("?")[0] === "#/inbox";
const onToday = () => ["", "#", "#/"].includes(location.hash.split("?")[0]!);

export function openShelf(at?: string) {
  if (!shelf.get().open && !onInbox()) {
    if (onToday()) {
      location.hash = "#/inbox";
      history.replaceState({ ...history.state, shelf: true }, "");
    } else history.pushState({ ...history.state, shelf: true }, "");
  }
  shelf.set({ open: true, at });
}

/** Keeps the history step, so Back reopens the panel. For links that lead away. */
export const closeShelf = () => shelf.get().open && shelf.set({ open: false });

/** Closing by hand behaves like Back. */
export function dismissShelf() {
  if (!shelf.get().open) return;
  if (history.state?.shelf) return history.back();
  shelf.set({ open: false });
  if (onInbox()) location.replace("#/");
}

/** Follows the history step; the chosen entry stays. */
export function syncShelf() {
  const open = !!history.state?.shelf || onInbox();
  if (open !== shelf.get().open) shelf.set({ open });
}
addEventListener("popstate", syncShelf);

/** Pinned open on desktop Heute (App.tsx), which then hides its own list of entries. */
const pinned = createStore(false);
export const setShelfPinned = (p: boolean) => p !== pinned.get() && pinned.set(p);
export const useShelfPinned = pinned.use;
export const useShelf = shelf.use;
