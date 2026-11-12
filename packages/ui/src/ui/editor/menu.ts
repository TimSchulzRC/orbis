// Menus for the editor's own DOM, which is not React.
import type { ComponentType } from "react";
import { iconHTML } from "./icons";

export interface MenuEntry {
	label: string;
	icon?: ComponentType<{ size?: number }>;
	color?: string;
	active?: boolean;
	danger?: boolean;
	hint?: string;
	run: () => void;
}

let open: { close: () => void } | null = null;

/** Menus keep this many px away from the window's edges. */
const EDGE = 8;

/** With `maxRows` a longer list scrolls, half of the next row showing that there is more. */
export function showMenu(
	at: { left: number; top: number },
	sections: { title?: string; entries: MenuEntry[] }[],
	onClose?: () => void,
	maxRows?: number,
) {
	open?.close();
	const box = document.createElement("div");
	box.className = "cm-menu";
	box.setAttribute("role", "menu");
	const rows: HTMLButtonElement[] = [];
	sections.forEach((section, i) => {
		if (i > 0)
			box.append(Object.assign(document.createElement("div"), { className: "cm-menu-sep" }));
		if (section.title)
			box.append(
				Object.assign(document.createElement("div"), {
					className: "cm-menu-title",
					textContent: section.title,
				}),
			);
		for (const entry of section.entries) {
			const row = document.createElement("button");
			row.type = "button";
			row.setAttribute("role", "menuitem");
			row.className = `cm-menu-row${entry.danger ? " danger" : ""}${entry.active ? " active" : ""}`;
			row.innerHTML =
				(entry.icon ? `<span class="cm-menu-icon">${iconHTML(entry.icon, 16)}</span>` : "") +
				`<span class="cm-menu-label"></span>` +
				(entry.hint ? `<span class="cm-menu-hint"></span>` : "");
			row.querySelector(".cm-menu-label")!.textContent = entry.label;
			if (entry.hint) row.querySelector(".cm-menu-hint")!.textContent = entry.hint;
			if (entry.color)
				row.querySelector<HTMLElement>(".cm-menu-icon")?.style.setProperty("color", entry.color);
			row.addEventListener("mousedown", (e) => e.preventDefault());
			row.addEventListener("click", () => (close(), entry.run()));
			rows.push(row);
			box.append(row);
		}
	});
	document.body.append(box);
	const cut = maxRows ? rows[maxRows] : undefined;
	if (cut) box.style.maxHeight = `${cut.offsetTop + cut.offsetHeight / 2}px`;
	const rect = box.getBoundingClientRect();
	box.style.left = `${Math.max(EDGE, Math.min(at.left, innerWidth - rect.width - EDGE))}px`;
	// no room below: open above instead
	const fitsBelow = at.top + rect.height <= innerHeight - EDGE;
	box.style.top = `${fitsBelow ? at.top : Math.max(EDGE, at.top - rect.height - 32)}px`;
	let index = -1;
	const focus = (i: number) => {
		index = (i + rows.length) % rows.length;
		rows[index]!.focus();
	};
	const key = (e: KeyboardEvent) => {
		if (e.key === "Escape") e.preventDefault(), close();
		else if (e.key === "ArrowDown") e.preventDefault(), focus(index + 1);
		else if (e.key === "ArrowUp") e.preventDefault(), focus(index - 1);
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

/** Resolves the text on Enter, null on Escape or a click elsewhere. */
export function askText(
	at: { left: number; top: number },
	value: string,
	label: string,
): Promise<string | null> {
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
		box.style.left = `${Math.max(EDGE, Math.min(at.left, innerWidth - box.offsetWidth - EDGE))}px`;
		box.style.top = `${at.top}px`;
		const done = (result: string | null) => {
			if (!box.isConnected) return;
			box.remove();
			document.removeEventListener("mousedown", outside, true);
			open = null;
			resolve(result);
		};
		const outside = (e: MouseEvent) => !box.contains(e.target as Node) && done(null);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") e.preventDefault(), done(input.value);
			else if (e.key === "Escape") e.preventDefault(), done(null);
		});
		setTimeout(() => document.addEventListener("mousedown", outside, true));
		open = { close: () => done(null) };
		input.focus();
		input.select();
	});
}
