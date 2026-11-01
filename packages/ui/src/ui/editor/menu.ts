// A small menu in the editor's own DOM (the block menu, "Turn into" of the toolbar): rows with
// an icon, arrow keys and Enter, closed by Escape or a click elsewhere.
import type { ComponentType } from "react";
import { iconHTML } from "./icons";

interface MenuEntry {
  label: string;
  icon?: ComponentType<{ size?: number }>;
  /** The icon's colour (a type's, as in the sidebar). */
  color?: string;
  active?: boolean;
  danger?: boolean;
  hint?: string;
  run: () => void;
}

let open: { close: () => void } | null = null;

/**
 * Show the menu at a point of the screen; sections are separated by a line. With `maxRows`, a
 * longer list scrolls inside the menu, half of the next row showing that there is more.
 */
export function showMenu(at: { left: number; top: number }, sections: { title?: string; entries: MenuEntry[] }[], onClose?: () => void, maxRows?: number) {
  open?.close();
  const box = document.createElement("div");
  box.className = "cm-menu";
  box.setAttribute("role", "menu");
  const rows: HTMLButtonElement[] = [];
  sections.forEach((s, i) => {
    if (i > 0) box.append(Object.assign(document.createElement("div"), { className: "cm-menu-sep" }));
    if (s.title) box.append(Object.assign(document.createElement("div"), { className: "cm-menu-title", textContent: s.title }));
    for (const e of s.entries) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.className = "cm-menu-row" + (e.danger ? " danger" : "") + (e.active ? " active" : "");
      b.innerHTML = (e.icon ? `<span class="cm-menu-icon">${iconHTML(e.icon, 16)}</span>` : "") + `<span class="cm-menu-label"></span>` + (e.hint ? `<span class="cm-menu-hint"></span>` : "");
      b.querySelector(".cm-menu-label")!.textContent = e.label;
      if (e.hint) b.querySelector(".cm-menu-hint")!.textContent = e.hint;
      if (e.color) b.querySelector<HTMLElement>(".cm-menu-icon")?.style.setProperty("color", e.color);
      b.addEventListener("mousedown", (ev) => ev.preventDefault());
      b.addEventListener("click", () => (close(), e.run()));
      rows.push(b);
      box.append(b);
    }
  });
  document.body.append(box);
  const cut = maxRows ? rows[maxRows] : undefined;
  if (cut) box.style.maxHeight = cut.offsetTop + cut.offsetHeight / 2 + "px";
  const r = box.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(at.left, innerWidth - r.width - 8)) + "px";
  box.style.top = (at.top + r.height > innerHeight - 8 ? Math.max(8, at.top - r.height - 32) : at.top) + "px";
  let index = -1;
  const focus = (i: number) => {
    index = (i + rows.length) % rows.length;
    rows[index]!.focus();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.preventDefault(), close());
    else if (e.key === "ArrowDown") (e.preventDefault(), focus(index + 1));
    else if (e.key === "ArrowUp") (e.preventDefault(), focus(index - 1));
  };
  const outside = (e: MouseEvent) => !box.contains(e.target as Node) && close();
  function close() {
    if (!box.isConnected) return;
    box.remove();
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("mousedown", outside, true);
    open = null;
    onClose?.();
  }
  document.addEventListener("keydown", key, true);
  setTimeout(() => document.addEventListener("mousedown", outside, true));
  open = { close };
  return { close, focusFirst: () => focus(0) };
}

/** A one-line field at a point of the screen; Enter gives its text, Escape or a click elsewhere null. */
export function askText(at: { left: number; top: number }, value: string, label: string): Promise<string | null> {
  open?.close();
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.className = "cm-menu cm-ask";
    const input = document.createElement("input");
    input.className = "cm-ask-input";
    input.value = value;
    input.setAttribute("aria-label", label);
    input.placeholder = label;
    box.append(input);
    document.body.append(box);
    box.style.left = Math.max(8, Math.min(at.left, innerWidth - box.offsetWidth - 8)) + "px";
    box.style.top = at.top + "px";
    const done = (v: string | null) => {
      if (!box.isConnected) return;
      box.remove();
      document.removeEventListener("mousedown", outside, true);
      open = null;
      resolve(v);
    };
    const outside = (e: MouseEvent) => !box.contains(e.target as Node) && done(null);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") (e.preventDefault(), done(input.value));
      else if (e.key === "Escape") (e.preventDefault(), done(null));
    });
    setTimeout(() => document.addEventListener("mousedown", outside, true));
    open = { close: () => done(null) };
    input.focus();
    input.select();
  });
}
