// Lucide icons as SVG markup for the editor's own DOM (menus, handles, toolbar), which is not React.
import type { ComponentType } from "react";
import { escapeHtml } from "../text";

type IconNode = [string, Record<string, string>][];
const cache = new Map<unknown, IconNode>();

/** Reads the shapes off the lucide-react component without rendering it. */
function nodeOf(icon: unknown): IconNode {
  let node = cache.get(icon);
  if (!node) {
    const el = (icon as { render?: (p: object, r: null) => { props?: { icon?: { node?: IconNode }; iconNode?: IconNode } } }).render?.({}, null);
    node = el?.props?.icon?.node ?? el?.props?.iconNode ?? [];
    cache.set(icon, node);
  }
  return node;
}

export function iconHTML(icon: ComponentType<{ size?: number }>, size = 16): string {
  const shapes = nodeOf(icon)
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${escapeHtml(String(v))}"`).join(" ")}/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes}</svg>`;
}

export function iconButton(icon: ComponentType<{ size?: number }>, label: string, className: string, size = 16): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = iconHTML(icon, size);
  return b;
}
