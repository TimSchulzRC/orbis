import { type Item, type ItemInit, initType, newId } from "@obtion/core/model";
import type { Index } from "@obtion/core/graph";
import type { Repo } from "@obtion/sync";
import { repo as current } from "./repo";
import { freshColor } from "@obtion/core/palette";
import { openItem } from "./hooks";
import { KEYS } from "./ui/storage";

export function createAndOpen(init: ItemInit, repo: Repo = current, space?: string) {
  const id = repo.create(init);
  openItem(id, { space, query: "?new=1" });
  return id;
}

/** Nothing written and nothing hangs on it: an item opened new and left so is discarded. */
export function isBlank(item: Item, ix: Index): boolean {
  return !item.title.trim() && !item.body.trim() && !item.rules.trim() && !item.tags.length && !item.refs.length && !item.updates.length && !ix.childrenOf(item.id).length && !ix.backlinks(item.id).length && !Object.keys(item.extra).length;
}

const RECENT = KEYS.recentPlaces;
const RECENT_SHOWN = 6;
/** Kept larger than shown because the list is shared by all workspaces. */
const RECENT_KEPT = 30;

function storedPlaces(): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(RECENT) ?? "[]");
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
/** Newest first. */
export function recentPlaces(repo: Repo = current): string[] {
  const ix = repo.index();
  return storedPlaces().filter((id) => ix.get(id)?.kind === "info").slice(0, RECENT_SHOWN);
}
/** One list for all workspaces; each reads only its own ids. */
export function rememberPlace(id: string) {
  const ids = [id, ...storedPlaces().filter((x) => x !== id)].slice(0, RECENT_KEPT);
  localStorage.setItem(RECENT, JSON.stringify(ids));
}

export function createType(name: string, repo: Repo = current): string {
  const id = newId();
  repo.change(id, (d) => initType(d, { name, color: freshColor([...repo.index().types.values()].map((x) => x.schema.color)) }, { createdBy: repo.origin }));
  return id;
}
