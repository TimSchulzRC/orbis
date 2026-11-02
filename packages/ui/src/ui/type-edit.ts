// "Typ bearbeiten" opens as a dialog over the type's page: from the page's "…", from the type's
// "…" in the sidebar, after "Neuer Typ". It is no part of the address; another page closes it.
// "Neuer Typ" is a dialog over any page too (from "Typen" in the sidebar, the palette).
import { useSyncExternalStore } from "react";
import { itemPath, navigate, parseHash } from "../hooks";

let editing: string | null = null; // the type whose dialog is open
let at: { space?: string; path?: string } = {}; // the page it is open on: workspace (if named) and "/i/<id>"
const listeners = new Set<() => void>();
const set = (next: string | null) => ((editing = next), listeners.forEach((f) => f()));
const page = () => {
  const { space, rest } = parseHash();
  return { space, path: /^\/i\/[^/?]+/.exec(rest)?.[0] };
};

/** Opens type `id`'s editor; with `open`, also its page (in workspace `open.space`, if given) – not when it is open already. */
export function editType(id: string, open?: { space?: string }) {
  if (open) navigate(itemPath(id), open);
  at = page();
  set(id);
}

export const closeTypeEditor = () => set(null);
/** The type whose editor is open, or null. */
export const useTypeEditing = () => useSyncExternalStore((f) => (listeners.add(f), () => listeners.delete(f)), () => editing);

// another page (also the same type in another workspace) closes it, else it would open again
// on the next visit to that type
// on the way the address may get the open workspace's name: no other page
addEventListener("hashchange", () => {
  if (editing === null) return;
  const now = page();
  if (now.path !== at.path || (now.space && at.space && now.space !== at.space)) set(null);
});

let creating: string | null = null; // the workspace a new type is made in, while its dialog is open
const createListeners = new Set<() => void>();
const setCreating = (next: string | null) => ((creating = next), createListeners.forEach((f) => f()));
/** "Neuer Typ" in workspace `space`. */
export const openNewType = (space: string) => setCreating(space);
export const closeNewType = () => setCreating(null);
export const useNewTypeOpen = () => useSyncExternalStore((f) => (createListeners.add(f), () => createListeners.delete(f)), () => creating);
