// Ids are unique within a workspace only, so an inbox entry is keyed "<workspace>/<id>".

import type { Index } from "@orbis/core/graph";
import type { Lang, T } from "@orbis/core/i18n";
import {
	type Item,
	type Patch,
	SETTINGS_ID,
	setTab,
	shortId,
	titleKey,
	type ViewTab,
} from "@orbis/core/model";
import { laterItems } from "@orbis/core/placement";
import {
	type Cond,
	initFromWhere,
	parseQuery,
	printQuery,
	runQuery,
	tabDef,
} from "@orbis/core/query";
import { keyBetween } from "@orbis/core/sortkey";
import { replica, shownSpaces, useAccounts } from "../accounts";
import { isBlank } from "../actions";
import { useT } from "../i18n";
import { createStore } from "../lib/store";
import { useReplicas } from "./Spaces";
import { KEYS, readJSON } from "./storage";

export interface InboxEntry {
	key: string;
	space: string;
	item: Item;
}

export const entryKey = (space: string, id: string) => `${space}/${id}`;

export function useInboxItems(): InboxEntry[] {
	return useEntries((ix) => runQuery({ where: { inbox: true } }, { ix }).items);
}

/**
 * One of the inbox's own tabs (a list of what lies there and matches its filter), across the
 * workspaces shown: each that has a tab of this name gives its part. They are data, the settings'
 * tabs: the app gives no type a role here.
 */
export interface InboxTab {
	key: string; // the name, as compared
	name: string;
	parts: { space: string; tab: ViewTab }[];
}

const tabLabel = (tab: ViewTab, t: T) => tab.name || t(`view.${tab.kind}`);

export function useInboxTabs(): InboxTab[] {
	const { t } = useT();
	const { shown } = useAccounts();
	const repos = useReplicas(shown.map((s) => s.id));
	const tabs: InboxTab[] = [];
	shown.forEach((s, n) => {
		for (const tab of repos[n]!.index().all.get(SETTINGS_ID)?.settings?.inboxTabs ?? []) {
			const name = tabLabel(tab, t);
			const key = titleKey(name);
			const same = tabs.find((x) => x.key === key);
			if (same) same.parts.push({ space: s.id, tab });
			else tabs.push({ key, name, parts: [{ space: s.id, tab }] });
		}
	});
	return tabs;
}

export interface TabPart {
	space: string;
	view: ViewTab;
	items: Item[];
}

/**
 * A tab's entries, workspace by workspace, each sorted as its tab says. `missing`: names of types its
 * filter names that are gone.
 */
export function tabEntries(tab: InboxTab): {
	parts: TabPart[];
	entries: InboxEntry[];
	missing: string[];
} {
	const parts: TabPart[] = [];
	const missing: string[] = [];
	for (const { space, tab: view } of tab.parts) {
		const ix = replica(space).repo.index();
		const res = runQuery(tabDef({ inbox: true }, view), { ix });
		parts.push({ space, view, items: res.items });
		for (const id of res.missingTypes) {
			const name = ix.all.get(id)?.schema?.name ?? id;
			if (!missing.includes(name)) missing.push(name);
		}
	}
	const entries = parts.flatMap(({ space, items }) =>
		items.map((item) => ({ key: entryKey(space, item.id), space, item })),
	);
	return { parts, entries, missing };
}

/** Where a new entry of the tab goes: the workspace notes go to, if it has the tab, else the first. */
const partForNew = (tab: InboxTab) =>
	tab.parts.find((p) => p.space === captureSpace()) ?? tab.parts[0]!;

/** What a new entry of the tab starts with; undefined while its filter names a type that is gone. */
export function newInit(tab: InboxTab) {
	const { space, tab: view } = partForNew(tab);
	return initFromWhere(view.where, replica(space).repo.index());
}

/**
 * A new entry in the tab, in the inbox until ticked off or checked off: what the tab's filter asks
 * for (a type, tags, a place), with this title. Returns its key.
 */
export function newInTab(tab: InboxTab, title: string): string | undefined {
	const init = newInit(tab);
	if (!init || !title.trim()) return;
	const { space } = partForNew(tab);
	const id = replica(space).repo.create({ ...init, title: title.trim(), inbox: Date.now() });
	return entryKey(space, id);
}

/**
 * Changes a tab in every workspace that has it. A filter goes over as its text, so it means the same
 * there (a type of that name, not of that id). `undefined` in the patch clears the field.
 */
export function editTab(tab: InboxTab, patch: Partial<Omit<ViewTab, "id">>, lang: Lang) {
	const values = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? null])) as Patch<
		Omit<ViewTab, "id">
	>;
	const [first] = tab.parts;
	const text =
		"where" in patch && patch.where
			? printQuery({ where: patch.where }, lang, replica(first!.space).repo.index())
			: undefined;
	for (const part of tab.parts) {
		const ix = replica(part.space).repo.index();
		const where =
			part === first || text === undefined
				? values.where
				: (parseQuery(text, ix).def.where ?? null);
		const own = "where" in patch ? { ...values, where } : values;
		replica(part.space).repo.change(SETTINGS_ID, (d) => setTab(d, part.tab.id, own));
	}
}

/** Removes a tab everywhere; returns how to bring it back. */
export function removeTab(tab: InboxTab): () => void {
	for (const p of tab.parts)
		replica(p.space).repo.change(SETTINGS_ID, (d) => setTab(d, p.tab.id, null));
	return () => {
		for (const { space, tab: view } of tab.parts) {
			const { id, ...rest } = view;
			replica(space).repo.change(SETTINGS_ID, (d) => setTab(d, id, rest));
		}
	};
}

/** One place to the left or right, in each workspace among its tabs there. */
export function moveTab(tab: InboxTab, step: -1 | 1) {
	for (const { space, tab: view } of tab.parts) {
		const repo = replica(space).repo;
		const list = repo.index().all.get(SETTINGS_ID)?.settings?.inboxTabs ?? [];
		const n = list.findIndex((x) => x.id === view.id);
		if (n < 0 || !list[n + step]) continue;
		const after = step < 0 ? list[n - 2] : list[n + 1];
		const before = step < 0 ? list[n - 1] : list[n + 2];
		repo.change(SETTINGS_ID, (d) =>
			setTab(d, view.id, { pos: keyBetween(after?.pos ?? null, before?.pos ?? null) }),
		);
	}
}

/**
 * A new tab at the end, in each workspace shown: for a type, in those that have one of that name,
 * else (`where` empty, the filter chosen next) in all. Returns its key, or nothing if none had room.
 */
export function addTab(
	spaces: string[],
	name: string,
	where: (ix: Index) => Cond | undefined | null,
): string | undefined {
	const id = shortId("v");
	let added = false;
	for (const space of spaces) {
		const repo = replica(space).repo;
		const ix = repo.index();
		const filter = where(ix);
		if (filter === null || !ix.all.get(SETTINGS_ID)) continue;
		const last = ix.all.get(SETTINGS_ID)?.settings?.inboxTabs.at(-1);
		repo.change(SETTINGS_ID, (d) =>
			setTab(d, id, {
				kind: "list",
				name,
				pos: keyBetween(last?.pos ?? null, null),
				where: filter,
			}),
		);
		added = true;
	}
	return added ? titleKey(name) : undefined;
}

/** Set aside with "Back tomorrow", out of the inbox until tomorrow. */
export function useLaterItems(): InboxEntry[] {
	return useEntries((ix) => laterItems(ix));
}

/** The workspace a new note goes to: the one shown, else the last chosen of those shown. */
export function captureSpace(): string | undefined {
	const shown = shownSpaces();
	if (shown.length === 1) return shown[0]!.id;
	const last = readJSON(KEYS.captureSpace, "");
	return (shown.find((s) => s.id === last) ?? shown[0])?.id;
}

/** The new note while the panel shows it: left empty, it goes. */
const draft = createStore<{ space?: string; id?: string }>({});
export const useDraftKey = () => {
	const { space, id } = draft.use();
	return space && id ? entryKey(space, id) : undefined;
};

/**
 * A new empty note in the inbox, open in the panel (in workspace `space`, else the one notes go to).
 * It stays in the inbox with whatever type and place it gets, until checked off. One still empty is
 * taken again, the caret back in its title, so clicking twice makes no second.
 */
export function newNote(space = captureSpace()) {
	if (!space) return;
	const open = draft.get();
	if (open.space === space && open.id) {
		const repo = replica(space).repo;
		const item = repo.get(open.id);
		if (item && !item.deleted && isBlank(item, repo.index())) {
			openShelf(entryKey(space, open.id));
			requestAnimationFrame(() =>
				document.querySelector<HTMLElement>("[data-shelf-panel] article textarea")?.focus(),
			);
			return;
		}
	}
	dropDraft();
	const id = replica(space).repo.create({ title: "", type: null, parents: [], inbox: Date.now() });
	draft.set({ space, id });
	openShelf(entryKey(space, id));
}

/** The panel leaves the new note: left empty, it goes. The item follows its text a moment later. */
export function dropDraft() {
	const { space, id } = draft.get();
	if (!space || !id) return;
	draft.set({});
	setTimeout(() => {
		const repo = replica(space).repo;
		const item = repo.get(id);
		if (item && !item.deleted && isBlank(item, repo.index())) repo.remove(id);
	});
}

/** `pick`'s items across the shown workspaces, newest first. A workspace without its settings item is skipped. */
function useEntries(pick: (ix: Index) => Item[]): InboxEntry[] {
	const { shown } = useAccounts();
	const repos = useReplicas(shown.map((s) => s.id));
	return shown
		.flatMap((s, n) => {
			const spaceRepo = repos[n]!;
			if (!spaceRepo.get(SETTINGS_ID)) return [];
			return pick(spaceRepo.index()).map((item) => ({
				key: entryKey(s.id, item.id),
				space: s.id,
				item,
			}));
		})
		.sort((a, b) => b.item.created - a.item.created);
}

/**
 * The inbox panel, open at `at` (an entry key; none: the first waiting). The open panel is a
 * history step, so Back closes it instead of leaving the app on a phone. On Home that step is
 * "#/inbox", elsewhere the page's own address once more. "#/review" is the old address of the same.
 */
/** `asked`: counts the requests, so the same entry asked for again is a new request. */
const shelf = createStore<{ open: boolean; at?: string; asked?: number }>({ open: false });
let asks = 0;
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
	shelf.set({ open: true, at, asked: ++asks });
}

/** Keeps the history step, so Back reopens the panel. For links that lead away. */
export const closeShelf = () => shelf.get().open && shelf.set({ open: false });

/** Closing by hand behaves like Back. */
export function dismissShelf() {
	if (!shelf.get().open) return;
	if (history.state?.shelf) return history.back();
	shelf.set({ open: false });
	dropDraft();
	if (onInbox()) location.replace("#/");
}

/** Follows the history step; the chosen entry stays. */
export function syncShelf() {
	const open = !!history.state?.shelf || onInbox();
	if (open === shelf.get().open) return;
	shelf.set({ open, at: open ? addressAt() : undefined, asked: ++asks });
	if (!open) dropDraft();
}
addEventListener("popstate", syncShelf);

export const useShelf = shelf.use;
