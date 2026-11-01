import { type ItemInit, initType, newId, titleKey } from "@obtion/core/model";
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

const MAX_TITLE = 100;

/** "/buch Der Termin" picks the type by name prefix. Without type and parent it lands in the inbox. */
export function capture(text: string, opts: { type?: string | null; parent?: string } = {}, repo: Repo = current): string | undefined {
  let t = text.trim();
  if (!t) return;
  let type = opts.type ?? null;
  const slash = /^\/(\S+)\s+/.exec(t);
  if (slash) {
    const ix = repo.index();
    const want = titleKey(slash[1]!);
    const hit = [...ix.types.values()].find((x) => titleKey(x.schema.name).startsWith(want));
    if (hit) {
      type = hit.id;
      t = t.slice(slash[0].length);
    }
  }
  const lines = t.split("\n");
  const { text: firstLine, mentions } = extractMentions(lines[0]!.replace(/^#+\s*/, ""), repo);
  const tooLong = firstLine.length > MAX_TITLE;
  const title = tooLong ? firstLine.slice(0, MAX_TITLE - 3) + "…" : firstLine;
  let body = lines.length > 1 || tooLong ? [firstLine, ...lines.slice(1)].join("\n") : "";
  // mentions become [[links]], not parents, so the item stays in the inbox
  if (mentions.length) body = (body ? body + "\n\n" : "") + mentions.map((m) => `[[${m}]]`).join(" · ");
  return repo.create({ title, body, type, parents: opts.parent ? [opts.parent] : [] });
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

/** Only mentions of existing items count; one at the end of the line is removed from the text. */
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

export function createType(name: string, repo: Repo = current): string {
  const id = newId();
  repo.change(id, (d) => initType(d, { name, color: freshColor([...repo.index().types.values()].map((x) => x.schema.color)) }, { createdBy: repo.origin }));
  return id;
}
