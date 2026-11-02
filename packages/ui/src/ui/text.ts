// Small text helpers for markup the app builds itself (rendered Markdown, the editor's own DOM).
import type { Item } from "@obtion/core/model";
import type { Index } from "@obtion/core/graph";
import { tr } from "../i18n";
import { plainText } from "@obtion/core/search";

/** Text as HTML, safe in element content and in quoted attributes. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** "www.example.org" gets its https://. */
export function webHref(url: string): string {
  return /^www\./i.test(url) ? "https://" + url : url;
}

/** The quiet hint next to a page in link and mention lists: "Datei", else its type. */
export function kindHint(item: Item, ix: Index): string {
  return item.kind === "datei" ? tr("kind.file") : (ix.typeName(item.type) ?? "");
}

/** Where a page in link and mention lists is sorted in ("Arbeit › Relaunch"), empty if nowhere yet. */
export function placeHint(item: Item, ix: Index): string {
  return ix.pathText(ix.homePath(item.id));
}

/** The inside of a [[link]] to the page: its title, or "id|title" when the title is not exact. */
export function linkInner(item: Item, ix: Index): string {
  const target = ix.linkTarget(item);
  return target === item.id ? `${item.id}|${item.title.replace(/[\]|\n]/g, "").trim()}` : target;
}

export const filePreview = (text: string) => plainText(text).slice(0, 800);
