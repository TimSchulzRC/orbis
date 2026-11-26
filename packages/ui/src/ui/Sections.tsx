// The page's lower part: "Below", everything below the page as one tree.

import type { Index } from "@orbis/core/graph";
import { fmtBytes } from "@orbis/core/i18n";
import type { Item } from "@orbis/core/model";
import { belowOf } from "@orbis/core/placement";
import { cmpKey } from "@orbis/core/sortkey";
import { dueOf, isDone, statusOf } from "@orbis/core/traits";
import { filesBelow } from "@orbis/core/zip";
import { ChevronDown, Plus } from "lucide-react";
import { Fragment, useRef, useState } from "react";
import { Input } from "../components/ui/input";
import { itemHref, useIndex, useStoredSet } from "../hooks";
import { titleOf, useT } from "../i18n";
import { cn } from "../lib/utils";
import { repo } from "../repo";
import { DownloadFilesAction } from "./DownloadFiles";
import { NOTE_ICON } from "./icons";
import { DueLabel, RelTime, TypeGlyph } from "./item-look";
import { Button, Card, Kbd, MenuItem, Popover, SectionAction, SectionTitle } from "./primitives";
import { ProgressCount } from "./progress";
import { RowStatus } from "./Row";
import { KEYS } from "./storage";

/**
 * The line at the foot of a group that adds an entry. The whole line is the field: a click on the
 * plus or beside the text starts typing too. Enter adds and stays for the next one.
 */
function AddRow({
	label,
	placeholder,
	onAdd,
	autoFocus,
	onCancel,
	inputRef,
}: {
	label: string;
	placeholder: string;
	onAdd: (title: string) => void;
	autoFocus?: boolean;
	/** Escape. Going elsewhere changes nothing: a line that left then would move what is being clicked. */
	onCancel?: () => void;
	inputRef?: (el: HTMLInputElement | null) => void;
}) {
	const [text, setText] = useState("");
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				if (!text.trim()) return;
				onAdd(text.trim());
				setText("");
			}}
		>
			<label className="group/add flex min-h-10 cursor-text items-center gap-2 border-t border-line px-3 text-faint not-focus-within:hover:bg-hover focus-within:bg-hover/60 focus-within:text-fg max-md:min-h-[48px]">
				{/* On the text's baseline, not in the middle of its line: the plus stands on the baseline
				    without adding height, then moves down to the middle of the capitals, in whatever font
				    the device brings. */}
				<span className="flex min-w-0 flex-1 items-baseline gap-2 text-sm max-md:text-[15px]">
					<Plus className="-mt-[15px] shrink-0 translate-y-[calc((15px_-_1cap)/2)]" size={15} />
					<Input
						aria-label={label}
						autoFocus={autoFocus}
						className="flex-1 text-sm text-fg placeholder:text-muted-foreground max-md:text-[15px]"
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key !== "Escape") return;
							setText("");
							e.currentTarget.blur();
							onCancel?.();
						}}
						placeholder={placeholder}
						ref={inputRef}
						value={text}
						variant="bare"
					/>
				</span>
				{/* what Enter does, once there is something to add */}
				{text.trim() && (
					<span className="hidden shrink-0 group-focus-within/add:flex">
						<Kbd>Enter</Kbd>
					</span>
				)}
			</label>
		</form>
	);
}

/** Which group of "Below" an entry belongs to: its type, notes (no type) or files. */
function groupOf(x: Item): string {
	return x.kind === "file" ? "files" : (x.type ?? "notes");
}

/** Open ones first (running before not started), then by due date and title. */
function order(ix: Index) {
	const rank = (x: Item) =>
		({ active: 0, todo: 1, done: 2 })[statusOf(x, ix.schemaOf(x))?.group ?? "todo"];
	const due = (x: Item) => dueOf(x, ix.schemaOf(x)) ?? "9999";
	return (a: Item, b: Item) =>
		rank(a) - rank(b) || cmpKey(due(a), due(b)) || a.title.localeCompare(b.title);
}

/**
 * "Below" (design rules § 3.1, zone 4): everything below the page, the same for every type.
 * The entries directly below, grouped by type; each one with entries below opens into them, any
 * type, any depth; all start closed. Done ones show at the end of their group. Each group ends
 * with the line that adds an entry of its type; the menu in the head leads there too.
 */
export function Below({ item }: { item: Item }) {
	const { t, lang } = useT();
	const ix = useIndex();
	// the entries opened to show what lies below them
	const [opened, flip] = useStoredSet(KEYS.fold(`below:${item.id}`));
	// a group picked in the menu that has no entry yet: it shows with its add line only, until Escape
	const [pending, setPending] = useState<string>();
	const inputs = useRef(new Map<string, HTMLInputElement>());
	const cmp = order(ix);
	const done = (x: Item) => isDone(x, ix.schemaOf(x));
	// done ones stay, at the end of their group
	const below = (id: string) => belowOf(id, ix);
	const direct = below(item.id);
	const groups = new Map<string, Item[]>();
	for (const c of direct)
		(groups.get(groupOf(c)) ?? groups.set(groupOf(c), []).get(groupOf(c))!).push(c);
	// types by name, then notes, then files
	const label = (g: string) =>
		g === "notes" ? t("below.untyped") : g === "files" ? t("below.files") : ix.typePlural(g);
	const rankOf = (g: string) => (g === "files" ? 2 : g === "notes" ? 1 : 0);
	const byGroup = (a: string, b: string) =>
		rankOf(a) - rankOf(b) || label(a).localeCompare(label(b));
	const keys = [...new Set([...groups.keys(), ...(pending ? [pending] : [])])].sort(byGroup);
	const typeOf = (g: string) => (g === "notes" ? undefined : g);
	const create = (title: string, g: string) =>
		repo.create({ title, parents: [item.id], ...(typeOf(g) ? { type: typeOf(g) } : {}) });
	const typeName = (g: string) => ix.typeName(typeOf(g) ?? null) ?? t("kind.note");
	// the menu leads to the group's own add line, where the new entry will show
	const startAdding = (g: string) => {
		// one unused group at a time; a new one takes the keyboard as it shows
		setPending(groups.has(g) ? undefined : g);
		inputs.current.get(g)?.focus();
	};
	// one of the entries opens: the others keep a place for the chevron, so the right column stays in line
	const tree = direct.some((x) => below(x.id).length > 0);

	const right = (x: Item) => {
		if (x.file)
			return (
				<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
					{fmtBytes(lang, x.file.size)}
				</span>
			);
		const due = dueOf(x, ix.schemaOf(x));
		if (due) return <DueLabel done={done(x)} due={due} />;
		if (!x.type)
			return (
				<span className="shrink-0 text-xs text-muted-foreground">
					<RelTime ts={x.updated} />
				</span>
			);
		return null;
	};
	const row = (x: Item, depth: number, path: Set<string>): React.ReactNode => {
		const kids = path.has(x.id)
			? []
			: below(x.id).sort((a, b) => byGroup(groupOf(a), groupOf(b)) || cmp(a, b));
		const open = kids.length > 0 && opened.has(x.id);
		const progress = ix.progressOf(x);
		const status = statusOf(x, ix.schemaOf(x));
		const blocked = !!status && status.group !== "done" && ix.isBlocked(x);
		const inner = new Set(path).add(x.id);
		return (
			<Fragment key={`${x.id}:${depth}`}>
				<div
					className={cn(
						"flex min-h-10 items-center gap-2 border-t border-line hover:bg-hover max-md:min-h-[48px]",
						tree ? "pr-1.5" : "pr-3",
					)}
					data-id={x.id}
					style={{ paddingLeft: 12 + depth * 22 }}
				>
					<RowStatus item={x} size={15} />
					<a
						className={cn(
							"min-w-0 truncate text-sm hover:underline max-md:text-[15px]",
							done(x) && "text-muted-foreground line-through",
						)}
						href={itemHref(x.id)}
					>
						{titleOf(x, t)}
					</a>
					{progress && progress.total > 0 && (
						<ProgressCount
							className="shrink-0 text-xs text-muted-foreground"
							done={progress.done}
							total={progress.total}
						/>
					)}
					{blocked && <span className="shrink-0 text-xs text-warn">{t("row.blocked")}</span>}
					{!open && kids.length > 0 && !progress?.total && (
						<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
							{kids.length}
						</span>
					)}
					<span className="ml-auto shrink-0">{right(x)}</span>
					{/* at the end, so every title starts at the same place, with or without entries below */}
					{kids.length > 0 ? (
						<Button
							aria-expanded={open}
							aria-label={open ? t("below.close") : t("below.open")}
							className="tap-edge flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fg/10 hover:text-fg"
							onClick={() => flip(x.id, !opened.has(x.id))}
							variant="plain"
						>
							<ChevronDown className={cn("transition-transform", open && "rotate-180")} size={15} />
						</Button>
					) : (
						tree && <span className="size-7 shrink-0" />
					)}
				</div>
				{open && kids.map((k) => row(k, depth + 1, inner))}
			</Fragment>
		);
	};

	const addMenu = (
		<Popover trigger={(p) => <SectionAction {...p}>{t("below.add")}</SectionAction>}>
			{(close) => (
				<>
					<MenuItem
						icon={<NOTE_ICON size={14} style={{ color: "var(--t-note)" }} />}
						onClick={() => {
							close();
							startAdding("notes");
						}}
					>
						{t("kind.note")}
					</MenuItem>
					{ix.typesByName().map((x) => (
						<MenuItem
							icon={<TypeGlyph schema={x.schema} size={14} />}
							key={x.id}
							onClick={() => {
								close();
								startAdding(x.id);
							}}
						>
							{x.schema.name}
						</MenuItem>
					))}
				</>
			)}
		</Popover>
	);
	// nothing below: only the button
	if (!keys.length) return <div className="mt-6">{addMenu}</div>;
	return (
		<section className="mt-10 max-md:mt-8">
			<SectionTitle
				count={direct.length || undefined}
				right={
					<>
						<DownloadFilesAction files={filesBelow(item.id, ix)} title={titleOf(item, t)} />
						{addMenu}
					</>
				}
			>
				{t("below.title")}
			</SectionTitle>
			<Card className="overflow-hidden">
				{keys.map((g) => (
					<div className="border-line not-first:border-t" key={g}>
						<p className="px-3 pb-1.5 pt-3 text-xs font-semibold text-muted-foreground">
							{label(g)}
						</p>
						{(groups.get(g) ?? []).sort(cmp).map((x) => row(x, 0, new Set([item.id])))}
						{g !== "files" && (
							<AddRow
								autoFocus={pending === g}
								inputRef={(el) => {
									if (el) inputs.current.set(g, el);
									else inputs.current.delete(g);
								}}
								label={t("below.addOf", { name: typeName(g) })}
								onAdd={(title) => create(title, g)}
								onCancel={() => pending === g && setPending(undefined)}
								placeholder={typeName(g)}
							/>
						)}
					</div>
				))}
			</Card>
		</section>
	);
}
