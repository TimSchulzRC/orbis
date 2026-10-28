import type { ItemInit } from "@obtion/core/model";
import { META_TYPE, SETTINGS_ID, initItem, initSchema, newId, titleKey } from "@obtion/core/model";
import type { Repo } from "@obtion/sync";
import { repo as current } from "./repo";
import { freshColor } from "@obtion/core/palette";
import { itemHref, spaceHref } from "./hooks";

/** Create an item locally and open it – in another workspace than the open one with `space`. */
export function createAndOpen(init: ItemInit, repo: Repo = current, space?: string) {
  const id = repo.create(init);
  location.hash = spaceHref(space, `/i/${encodeURIComponent(id)}?new=1`);
  return id;
}

/** Open the agent panel, optionally sending a message; `shown` is what the chat shows of it (no ids or instructions). */
export function askAgent(text?: string, shown?: string) {
  if (text?.trim()) sessionStorage.setItem("obtion.agentDraft", JSON.stringify({ text: text.trim(), shown }));
  window.dispatchEvent(new CustomEvent("obtion:ask"));
}

/**
 * Quick capture. "/buch Der Termin" picks the type by name prefix. Without type and
 * parent the result lands in the inbox. Returns the new id.
 */
export function capture(text: string, opts: { type?: string | null; parent?: string } = {}, repo: Repo = current): string | undefined {
  let t = text.trim();
  if (!t) return;
  let type = opts.type ?? null;
  const slash = /^\/(\S+)\s+/.exec(t);
  if (slash) {
    const ix = repo.index();
    const want = titleKey(slash[1]!);
    const hit = [...ix.types.values()].find((x) => titleKey(x.schema!.name).startsWith(want));
    if (hit) {
      type = hit.id;
      t = t.slice(slash[0].length);
    }
  }
  const lines = t.split("\n");
  const { text: firstLine, mentions } = extractMentions(lines[0]!.replace(/^#+\s*/, ""), repo);
  const title = firstLine.length > 100 ? firstLine.slice(0, 97) + "…" : firstLine;
  let body = lines.length > 1 || firstLine.length > 100 ? [firstLine, ...lines.slice(1)].join("\n") : "";
  // "@Title" mentions become [[links]]: refs, not a place – the item stays in the inbox.
  if (mentions.length) body = (body ? body + "\n\n" : "") + mentions.map((m) => `[[${m}]]`).join(" · ");
  return repo.create({ title, body, type, parents: opts.parent ? [opts.parent] : [] });
}

const RECENT = "obtion.recentPlaces";
/** The places used last on this device (capture, sorting the inbox, "+ Ort"), newest first. */
export function recentPlaces(repo: Repo = current): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(RECENT) ?? "[]") as string[];
    const ix = repo.index();
    return ids.filter((id) => ix.get(id)?.kind === "info");
  } catch {
    return [];
  }
}
export function rememberPlace(id: string, repo: Repo = current) {
  const ids = [id, ...recentPlaces(repo).filter((x) => x !== id)].slice(0, 6);
  localStorage.setItem(RECENT, JSON.stringify(ids));
}

/** Find "@Title" mentions of existing items. A mention at the end of the line is removed from the text. */
export function extractMentions(line: string, repo: Repo = current): { text: string; mentions: string[] } {
  const ix = repo.index();
  const mentions: string[] = [];
  const text = line
    .replace(/@([^@\n]+)/g, (m, name: string, offset: number) => {
      const words = name.trim().split(/\s+/);
      for (let n = words.length; n > 0; n--) {
        const cand = words.slice(0, n).join(" ").replace(/[.,;:!?]+$/, "");
        if (!ix.resolveTitle(cand)) continue;
        mentions.push(cand);
        const restWords = words.slice(n).join(" ");
        const atEnd = !restWords && offset + m.length >= line.trimEnd().length;
        return (atEnd ? "" : cand) + (restWords ? " " + restWords : "");
      }
      return m;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { text: text || line.trim(), mentions };
}

export function settings() {
  return current.get(SETTINGS_ID);
}

export function open(id: string) {
  location.hash = itemHref(id);
}

/** A guess at the plural of a type name, for the name of its list (editable). */
export { pluralOf } from "@obtion/core/plural";

/** A new type; it appears in the sidebar under "Typen", at the end. Returns its id. */
export function createType(name: string, repo: Repo = current): string {
  const id = newId();
  repo.change(id, (d) => {
    initItem(d, { type: META_TYPE, title: name, createdBy: `web:${repo.device}` });
    initSchema(d, { name, icon: "box", color: freshColor([...repo.index().types.values()].map((x) => x.schema?.color)), description: "", capabilities: {} });
  });
  return id;
}
