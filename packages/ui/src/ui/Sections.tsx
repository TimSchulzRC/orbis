// The page's lower part: "Below", everything below the page as one tree.

import type { Index } from "@orbis/core/graph";
import { fmtBytes } from "@orbis/core/i18n";
import type { Item } from "@orbis/core/model";
import { belowOf } from "@orbis/core/placement";
import { cmpKey } from "@orbis/core/sortkey";
import { dueOf, isDone, statusOf } from "@orbis/core/traits";
import { filesBelow } from "@orbis/core/zip";
import { ChevronRight, Plus } from "lucide-react";
import { Fragment, useState } from "react";
import { Input } from "../components/ui/input";
import { itemHref, useIndex, useStoredSet } from "../hooks";
import { titleOf, useT } from "../i18n";
import { cn } from "../lib/utils";
import { repo } from "../repo";
import { DownloadFilesAction } from "./DownloadFiles";
import { NOTE_ICON } from "./icons";
import { DueLabel, RelTime, TypeGlyph } from "./item-look";
import { Button, Card, MenuItem, Popover, SectionAction, SectionTitle } from "./primitives";
import { ProgressCount } from "./progress";
import { RowStatus } from "./Row";
import { KEYS } from "./storage";

function AddRow({
	label,
	onAdd,
	autoFocus,
	onDone,
}: {
	label: string;
	onAdd: (title: string) => void;
	autoFocus?: boolean;
	onDone?: () => void;
}) {
	const [text, setText] = useState("");
	return (
		<form
			className="field-within mt-1 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-muted-foreground focus-within:bg-hover"
			onSubmit={(e) => {
				e.preventDefault();
				if (!text.trim()) return;
				onAdd(text.trim());
				setText("");
			}}
		>
			<Plus size={17} />
			<Input
				aria-label={label}
				autoFocus={autoFocus}
				className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint max-md:text-[15px]"
				onBlur={() => !text.trim() && onDone?.()}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key !== "Escape") return;
					setText("");
					onDone?.();
				}}
				placeholder={label}
				value={text}
				variant="bare"
			/>
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
 * type, any depth; all start closed. Done ones show at the end of their group.
 */
export function Below({ item }: { item: Item }) {
	const { t, lang } = useT();
	const ix = useIndex();
	// the entries opened to show what lies below them
	const [opened, flip] = useStoredSet(KEYS.fold(`below:${item.id}`));
	// the type of the entry being added at the top: undefined closed, null a note
	const [adding, setAdding] = useState<string | null | undefined>(undefined);
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
	const keys = [...groups.keys()].sort(byGroup);
	const create = (title: string, type: string | null) =>
		repo.create({ title, parents: [item.id], ...(type ? { type } : {}) });
	const typeName = (type: string | null) =>
		(type ? ix.typeName(type) : undefined) ?? t("kind.note");

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
					className="flex min-h-10 items-center gap-2 border-t border-line pr-3 hover:bg-hover max-md:min-h-[48px]"
					data-id={x.id}
					style={{ paddingLeft: 6 + depth * 22 }}
				>
					{kids.length > 0 ? (
						<Button
							aria-expanded={open}
							aria-label={open ? t("below.close") : t("below.open")}
							className="tap-edge flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-hover hover:text-fg"
							onClick={() => flip(x.id, !opened.has(x.id))}
							variant="plain"
						>
							<ChevronRight className={cn("transition-transform", open && "rotate-90")} size={13} />
						</Button>
					) : (
						<span className="size-5 shrink-0" />
					)}
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
							setAdding(null);
							close();
						}}
					>
						{t("kind.note")}
					</MenuItem>
					{ix.typesByName().map((x) => (
						<MenuItem
							icon={<TypeGlyph schema={x.schema} size={14} />}
							key={x.id}
							onClick={() => {
								setAdding(x.id);
								close();
							}}
						>
							{x.schema.name}
						</MenuItem>
					))}
				</>
			)}
		</Popover>
	);
	const addRow = adding !== undefined && (
		<div className="border-b border-line px-1">
			<AddRow
				autoFocus
				label={t("below.addOf", { name: typeName(adding) })}
				onAdd={(title) => create(title, adding)}
				onDone={() => setAdding(undefined)}
			/>
		</div>
	);
	// nothing below: only the button
	if (!direct.length)
		return (
			<div className="mt-6">
				{adding === undefined ? addMenu : <Card className="overflow-hidden">{addRow}</Card>}
			</div>
		);
	return (
		<section className="mt-10 max-md:mt-8">
			<SectionTitle
				count={direct.length}
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
				{addRow}
				{keys.map((g) => (
					<div key={g}>
						<p className="px-3 pb-1.5 pt-3 text-xs font-semibold text-muted-foreground first:pt-2.5">
							{label(g)}
						</p>
						{groups
							.get(g)!
							.sort(cmp)
							.map((x) => row(x, 0, new Set([item.id])))}
						{g !== "files" && (
							<div className="border-t border-line px-1">
								<AddRow
									label={typeName(g === "notes" ? null : g)}
									onAdd={(title) => create(title, g === "notes" ? null : g)}
								/>
							</div>
						)}
					</div>
				))}
			</Card>
		</section>
	);
}
