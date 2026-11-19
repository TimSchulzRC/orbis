// Every localStorage key. Values are JSON, except these plain-text ones: theme (index.html reads it
// before the app starts), lang, active space and file mode.

export const KEYS = {
	account: "orbis.account",
	/** the desktop app's further servers, each with its account */
	servers: "orbis.servers",
	/** while the copies of one server's workspaces are removed: they close without reloading the page */
	leaving: "orbis.leaving",
	spaces: "orbis.spaces",
	active: "orbis.active",
	shown: "orbis.shown",
	lang: "orbis.lang",
	theme: "orbis.theme",
	device: "orbis.device",
	fileMode: "orbis.fileMode",
	recentPlaces: "orbis.recentPlaces",
	/** Excalidraw's library: shapes kept for all drawings */
	drawingLibrary: "orbis.drawing.library",
	captureSpace: "orbis.capture.space",
	timelineScale: "orbis.timeline.scale",
	sidebarTree: "orbis.sidebar.tree",
	sidebarWidth: "orbis.sidebar.width",
	sidebarOpen: "orbis.sidebar.open",
	/** the inbox's "Sorted" with each entry's undo, until cleared */
	inboxSorted: "orbis.inbox.sorted",
	/** which entries the inbox lists: all, or only the to-dos */
	inboxView: "orbis.inbox.view",
	sidebarSpace: (space: string) => `orbis.sidebar.space.${space}`,
	sidebarTypes: (space: string) => `orbis.sidebar.types.${space}`,
	/** a view's tab shown last (a type's page, a block) */
	tab: (key: string) => `orbis.tab.${key}`,
	/** folded groups of a table */
	fold: (key: string) => `orbis.fold.${key}`,
	/** when a page's updates were last read on this device (not synced): newer ones by agents count as new */
	updatesSeen: (item: string) => `orbis.updates.seen.${item}`,
	/** an update being written on a page, until it is posted */
	updatesDraft: (item: string) => `orbis.updates.draft.${item}`,
	/** whether the updates panel shows those of the pages below too (this device) */
	updatesWithBelow: "orbis.updates.withBelow",
	/** opened rows: sub-items of a table, parts of a page */
	open: (key: string) => `orbis.open.${key}`,
};

/** A stored value, or `fallback`. */
export function readJSON<T>(key: string, fallback: T): T {
	const s = localStorage.getItem(key);
	if (s === null) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}

export function writeJSON(key: string, value: unknown) {
	localStorage.setItem(key, JSON.stringify(value));
}
