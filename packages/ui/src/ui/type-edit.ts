// "Edit type" opens as a dialog over the page that is open: from the type's page's "…", from
// the type's "…" in the sidebar, after "New type" (over the new type's page). It is no part of the
// address; another page closes it.
// "New type" is a dialog over any page too (from "Types" in the sidebar, the palette).
import { useSyncExternalStore } from "react";
import { itemPath, navigate, parseHash } from "../hooks";

/** The type whose editor is open, in workspace `space` (its replica). */
export type TypeEditing = { id: string; space?: string };
let editing: TypeEditing | null = null;
let at: { space?: string; path: string } = { path: "/" }; // the page it is open on: workspace (if named) and path
const listeners = new Set<() => void>();
const set = (next: TypeEditing | null) => ((editing = next), listeners.forEach((f) => f()));
const page = () => {
	const { space, rest } = parseHash();
	// an item's page without the title after its id ("/i/<id>/<title>"), which changes while typing
	return { space, path: /^\/i\/[^/?]+/.exec(rest)?.[0] ?? rest.split("?")[0]! };
};

/** Opens type `id`'s editor (of workspace `space`) over the page that is open; with `show`, over the type's page. */
export function editType(id: string, space?: string, show?: boolean) {
	if (show) navigate(itemPath(id), { space });
	at = page();
	set({ id, space });
}

export const closeTypeEditor = () => set(null);
/** The type whose editor is open, or null. */
export const typeEditing = () => editing;
export const useTypeEditing = () =>
	useSyncExternalStore((f) => (listeners.add(f), () => listeners.delete(f)), typeEditing);

// another page closes it (a view or tab in the address does not)
// on the way the address may get the open workspace's name: no other page
addEventListener("hashchange", () => {
	if (editing === null) return;
	const now = page();
	if (now.path !== at.path || (now.space && at.space && now.space !== at.space)) set(null);
});

let creating: string | null = null; // the workspace a new type is made in, while its dialog is open
const createListeners = new Set<() => void>();
const setCreating = (next: string | null) => (
	(creating = next), createListeners.forEach((f) => f())
);
/** "New type" in workspace `space`. */
export const openNewType = (space: string) => setCreating(space);
export const closeNewType = () => setCreating(null);
/** The workspace whose "New type" dialog is open, or null. */
export const newTypeOpen = () => creating;
export const useNewTypeOpen = () =>
	useSyncExternalStore(
		(f) => (createListeners.add(f), () => createListeners.delete(f)),
		newTypeOpen,
	);
