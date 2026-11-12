// Ids are unique within a workspace only, so an inbox entry is keyed "<workspace>/<id>".

import type { Index } from "@obtion/core/graph";
import { type Item, SETTINGS_ID } from "@obtion/core/model";
import { laterItems } from "@obtion/core/placement";
import { runQuery } from "@obtion/core/query";
import { useAccounts } from "../accounts";
import { isBlank } from "../actions";
import { createStore } from "../lib/store";
import { useReplicas } from "./Spaces";

export interface InboxEntry {
	key: string;
	space: string;
	item: Item;
}

export const entryKey = (space: string, id: string) => `${space}/${id}`;

export function useInboxItems(): InboxEntry[] {
	return useEntries((ix) => runQuery({ where: { inbox: true } }, { ix }).items);
}

/** Set aside with "Back tomorrow", out of the inbox until tomorrow. */
export function useLaterItems(): InboxEntry[] {
	return useEntries((ix) => laterItems(ix));
}

/** The quick note being written (an entry key): it counts as an entry only once something is in it. */
const draft = createStore<{ key?: string }>({});
export const setDraft = (key?: string) => draft.set({ key });

/** `pick`'s items across the shown workspaces, newest first. A workspace without its settings item is skipped. */
function useEntries(pick: (ix: Index) => Item[]): InboxEntry[] {
	const { shown } = useAccounts();
	const repos = useReplicas(shown.map((s) => s.id));
	const { key: drafting } = draft.use();
	return shown
		.flatMap((s, n) => {
			const spaceRepo = repos[n]!;
			if (!spaceRepo.get(SETTINGS_ID)) return [];
			const ix = spaceRepo.index();
			return pick(ix)
				.map((item) => ({ key: entryKey(s.id, item.id), space: s.id, item }))
				.filter((e) => e.key !== drafting || !isBlank(e.item, ix));
		})
		.sort((a, b) => b.item.created - a.item.created);
}

/**
 * The inbox panel, open at `at` (an entry key; none: the first waiting). The open panel is a
 * history step, so Back closes it instead of leaving the app on a phone. On Heute that step is
 * "#/inbox", elsewhere the page's own address once more. "#/review" is the old address of the same.
 */
const shelf = createStore<{ open: boolean; at?: string }>({ open: false });
const hashPath = () => location.hash.split("?")[0];
const onInbox = () => hashPath() === "#/inbox" || hashPath() === "#/review";
const onToday = () => ["", "#", "#/"].includes(hashPath()!);
const addressAt = () =>
	new URLSearchParams(location.hash.split("?")[1] ?? "").get("at") ?? undefined;

export function openShelf(at?: string) {
	const s = shelf.get();
	if (onInbox()) {
		if (hashPath() === "#/review") location.replace("#/inbox");
	} else if (!s.open) {
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
	if (open === shelf.get().open) return;
	shelf.set({ open, at: open ? addressAt() : undefined });
}
addEventListener("popstate", syncShelf);

/** Pinned open on desktop Heute (App.tsx), which then hides its own list of entries. */
const pinned = createStore(false);
export const setShelfPinned = (value: boolean) => value !== pinned.get() && pinned.set(value);
export const useShelfPinned = pinned.use;
export const useShelf = shelf.use;
