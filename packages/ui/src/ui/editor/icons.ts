// Lucide icons as SVG markup for the editor's own DOM (menus, handles, toolbar), which is not React.
import type { ComponentType } from "react";
import { escapeHtml } from "../text";

type IconNode = [string, Record<string, string>][];
const cache = new Map<unknown, IconNode>();

/** The shapes of a lucide-react icon (its component carries them; rendering it is not needed). */
function nodeOf(icon: unknown): IconNode {
  let node = cache.get(icon);
  if (!node) {
    const el = (icon as { render?: (p: object, r: null) => { props?: { icon?: { node?: IconNode }; iconNode?: IconNode } } }).render?.({}, null);
    node = el?.props?.icon?.node ?? el?.props?.iconNode ?? [];
    cache.set(icon, node);
  }
  return node;
}

/** The icon's SVG, as lucide-react draws it. */
export function iconHTML(icon: ComponentType<{ size?: number }>, size = 16): string {
  const shapes = nodeOf(icon)
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${escapeHtml(String(v))}"`).join(" ")}/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`;
}

/** A button with an icon (and a name for screen readers and as tooltip). */
export function iconButton(icon: ComponentType<{ size?: number }>, label: string, className: string, size = 16): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = iconHTML(icon, size);
  return b;
}
