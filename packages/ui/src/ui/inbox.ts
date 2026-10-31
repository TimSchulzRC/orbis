// The inbox of the workspaces seen, built once for every view of it: the tray and its panel, the
// review, Heute, the sidebar and the phone's bar. Each entry is sorted in its own workspace; ids are
// unique within a workspace only, so an entry is known by its key "<workspace>/<id>".
import { type Item, SETTINGS_ID } from "@obtion/core/model";
import { runQuery } from "@obtion/core/query";
import { useAccounts } from "../accounts";
import { useReplicas } from "./Spaces";
import { createStore } from "../lib/store";

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

/**
 * The tray's panel: closed, the list, or one entry in it (its key). One for the whole app.
 * Open, it is a step in the history, so Back closes it (on a phone else Back leaves the app);
 * on Heute that step is "#/inbox", elsewhere the page's own address once more.
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

/** Closed as a link leads away from it: the step stays behind, Back comes to it again. */
export const closeShelf = () => shelf.get().open && shelf.set({ open: false });

/** Closed by hand (its button, Escape, a click beside it): as Back would. */
export function dismissShelf() {
  if (!shelf.get().open) return;
  if (history.state?.shelf) return history.back();
  shelf.set({ open: false });
  if (onInbox()) location.replace("#/");
}

/** Open as the step in the history is (Back, Forward, a reload, another page); an entry chosen in it stays. */
export function syncShelf() {
  const open = !!history.state?.shelf || onInbox();
  if (open !== shelf.get().open) shelf.set({ open });
}
addEventListener("popstate", syncShelf);

/** Pinned open on Heute (a desktop with room below the page, App.tsx): Heute then leaves out its own sight of the entries. */
const pinned = createStore(false);
export const setShelfPinned = (p: boolean) => p !== pinned.get() && pinned.set(p);
export const useShelfPinned = pinned.use;
export const useShelf = shelf.use;
