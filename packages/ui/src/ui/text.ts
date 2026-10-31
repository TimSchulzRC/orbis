// Small text helpers for markup the app builds itself (rendered Markdown, the editor's own DOM).
import type { Item } from "@obtion/core/model";
import type { Index } from "@obtion/core/graph";
import { tr } from "../i18n";
import { plainText } from "@obtion/core/search";

/** Text as HTML, safe in element content and in quoted attributes. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A web address as a link target: "www.example.org" gets its https://. */
export function webHref(url: string): string {
  return /^www\./i.test(url) ? "https://" + url : url;
}

/** The quiet hint next to a page in link and mention lists: "Datei", else its type. */
export function kindHint(r: Item, ix: Index): string {
  return r.kind === "datei" ? tr("kind.file") : (ix.typeName(r.type) ?? "");
}

/** The start of a file's extracted text, as plain text: enough to tell what it is. */
export const filePreview = (text: string) => plainText(text).slice(0, 800);
