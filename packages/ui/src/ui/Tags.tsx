// Tags are their own thing, not a property.

import { type Item, normalizeTag } from "@orbis/core/model";
import { Check, Hash, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { repo } from "../repo";
import { Tag } from "./item-look";
import { openPalette } from "./palette-open";
import { Button } from "./primitives";

const SEP = /[\s,;]+/;
/** "a b, #c" → ["a", "b", "c"]: several at once, typed or pasted. */
const splitTags = (s: string) => s.split(SEP).map(normalizeTag).filter(Boolean);
/** The "+" and the opened field share it: one height, the icon in the same place. */
const BOX = "inline-flex h-6 items-center rounded-md border px-1 text-xs";
const setTag = (item: Item, tag: string, on: boolean) => repo.setMember(item.id, "tags", tag, on);

/** Opened, the "+" turns into the "#" in front of the field in the same box, so the row does not move. */
export function PageTags({ item }: { item: Item }) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	return (
		<>
			{item.tags.map((tag) => (
				<Tag
					key={tag}
					onOpen={() => openPalette(`#${tag}`)}
					onRemove={() => setTag(item, tag, false)}
					tag={tag}
				/>
			))}
			{open ? (
				<TagPicker item={item} onClose={() => setOpen(false)} />
			) : (
				<Button
					aria-label={t("tag.addMany")}
					className={cn(
						BOX,
						"tap-y border-transparent text-muted-foreground hover:bg-hover hover:text-fg",
						item.tags.length > 0 &&
							"opacity-0 transition-opacity focus:opacity-100 group-hover/props:opacity-100 pointer-coarse:opacity-100",
					)}
					onClick={() => setOpen(true)}
					title={t("tag.addMany")}
					variant="plain"
				>
					<Plus className="shrink-0" size={12} />
					{!item.tags.length && <span className="px-1">{t("item.tags")}</span>}
				</Button>
			)}
		</>
	);
}

/**
 * Enter, space or comma adds what was typed and keeps the field open; Backspace on empty removes
 * the tag added last here. A click in the list toggles a tag and keeps the list open.
 */
function TagPicker({ item, onClose }: { item: Item; onClose: () => void }) {
	const { t } = useT();
	const ix = useIndex();
	const [text, setText] = useState("");
	// the highlighted option; none (-1) until typed or picked with the arrow keys
	const [sel, setSel] = useState(-1);
	// added in this pass, newest last (the page keeps its tags sorted, so its last is not the newest)
	const [added, setAdded] = useState<string[]>([]);
	const q = normalizeTag(text);
	const tags = item.tags;
	const options = useMemo(() => {
		const counts = new Map(ix.tags().map((x) => [x.tag, x.count]));
		const all = [...counts].map(([tag, count]) => ({ tag, count, isNew: false }));
		const on = (tag: string) => Number(!q && tags.includes(tag));
		// nothing typed: the page's own first; typed: the exact match, then prefix matches; then by use
		const list = all
			.filter((x) => !q || x.tag.includes(q))
			.sort(
				(a, b) =>
					on(b.tag) - on(a.tag) ||
					Number(b.tag === q) - Number(a.tag === q) ||
					Number(b.tag.startsWith(q)) - Number(a.tag.startsWith(q)) ||
					b.count - a.count ||
					a.tag.localeCompare(b.tag),
			);
		if (q && !counts.has(q)) list.push({ tag: q, count: 0, isNew: true });
		return list;
	}, [ix, q, tags]);
	const active = Math.min(sel, options.length - 1);
	const list = useRef<HTMLSpanElement>(null);
	// the list scrolls: keep the one picked with the arrow keys in view
	useEffect(() => list.current?.children[active]?.scrollIntoView({ block: "nearest" }), [active]);
	const add = (tags: string[]) => {
		// only what was not there yet counts as added here – Backspace must not take an older one off
		const fresh = tags.filter((x) => !item.tags.includes(x));
		for (const x of fresh) setTag(item, x, true);
		setAdded((a) => [...a.filter((x) => !fresh.includes(x)), ...fresh]);
		setText("");
		setSel(-1);
	};
	const toggle = (tag: string) => {
		if (!item.tags.includes(tag)) return add([tag]);
		setTag(item, tag, false);
		setText("");
		setSel(-1);
	};
	return (
		<span className={cn(BOX, "relative border-line bg-surface")}>
			<Hash aria-hidden className="shrink-0 text-muted-foreground" size={12} />
			<input
				aria-controls="tag-picker-list"
				aria-expanded={options.length > 0}
				aria-label={t("tag.addMany")}
				// biome-ignore lint/a11y/noAutofocus: the picker opens on a click to add tags, and typing them is what comes next
				autoFocus
				className="h-full w-44 min-w-0 bg-transparent px-1 text-xs outline-none placeholder:text-faint"
				onBlur={() => setTimeout(onClose, 150)}
				onChange={(e) => {
					const value = e.target.value;
					if (!SEP.test(value)) {
						setText(value);
						setSel(value ? 0 : -1);
						return;
					}
					// a separator typed or pasted: everything before the last one becomes tags
					const parts = value.split(SEP);
					const rest = parts.pop() ?? "";
					add(parts.flatMap(splitTags));
					setText(rest);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") {
						e.preventDefault();
						setSel(Math.min(options.length - 1, active + 1));
					} else if (e.key === "ArrowUp") {
						e.preventDefault();
						setSel(Math.max(0, active - 1));
					} else if (e.key === "Enter") {
						e.preventDefault();
						const option = options[active];
						// typed: Enter adds (one the page has already just clears the field); picked with
						// the arrow keys from the list: Enter ticks or unticks it, like a click; nothing: close
						if (option) q ? add([option.tag]) : toggle(option.tag);
						else e.currentTarget.blur();
					} else if (e.key === "Escape") e.currentTarget.blur();
					else if (e.key === "Backspace" && !text) {
						const last = added.findLast((x) => item.tags.includes(x));
						if (last) {
							setTag(item, last, false);
							setAdded((a) => a.filter((x) => x !== last));
						}
					}
				}}
				onPaste={(e) => {
					// pasted with separators: every part becomes a tag, the last one too
					const pasted = e.clipboardData.getData("text");
					if (!SEP.test(pasted)) return;
					e.preventDefault();
					const field = e.currentTarget;
					add(
						splitTags(
							text.slice(0, field.selectionStart ?? text.length) +
								pasted +
								text.slice(field.selectionEnd ?? text.length),
						),
					);
				}}
				placeholder={t("tag.search")}
				role="combobox"
				value={text}
			/>
			{options.length > 0 && (
				<span
					aria-multiselectable
					className="absolute left-0 top-full z-30 mt-1 flex max-h-72 w-60 flex-col overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg"
					id="tag-picker-list"
					ref={list}
					role="listbox"
				>
					{options.map((o, i) => {
						const on = item.tags.includes(o.tag);
						return (
							<Button
								aria-selected={on}
								className={cn(
									"flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
									i === active && "bg-selected",
								)}
								key={o.tag + (o.isNew ? "+" : "")}
								// keep the focus in the field: the list stays open for the next one
								onMouseDown={(e) => {
									e.preventDefault();
									toggle(o.tag);
								}}
								onMouseEnter={() => setSel(i)}
								role="option"
								variant="plain"
							>
								{o.isNew ? (
									<Plus className="shrink-0 text-muted-foreground" size={14} />
								) : (
									<span
										className={cn(
											"flex size-4 shrink-0 items-center justify-center rounded border",
											on ? "border-fg bg-fg text-bg" : "border-line",
										)}
									>
										{on && <Check size={11} />}
									</span>
								)}
								<span className="min-w-0 flex-1 truncate">
									{o.isNew && <>{t("tag.create")} </>}
									<span className="text-muted-foreground">#</span>
									{o.isNew ? <b>{o.tag}</b> : o.tag}
								</span>
								{!o.isNew && (
									<span className="text-xs tabular-nums text-muted-foreground">{o.count}</span>
								)}
							</Button>
						);
					})}
				</span>
			)}
		</span>
	);
}
