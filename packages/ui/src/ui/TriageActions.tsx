// Sorting actions shared by the sort list and the review, each with one undo.

import type { Values } from "@orbis/core/i18n";
import { tomorrow } from "@orbis/core/inbox";
import { type Item, setMeta, titleKey } from "@orbis/core/model";
import { onlyBelow } from "@orbis/core/trash";
import { Check, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { replica } from "../accounts";
import { createType, rememberPlace } from "../actions";
import { Input } from "../components/ui/input";
import { useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { cn } from "../lib/utils";
import { chooseAction, notify } from "./feedback";
import { TypeGlyph } from "./item-look";
import { PlacePicker } from "./Picker";
import { Button, Dialog, Kbd } from "./primitives";
import { SpaceScope } from "./Spaces";

/** Longest title a notice quotes before it is cut off with "…". */
const TITLE_MAX = 40;

export interface Undo {
	label: string;
	steps: {
		space: string;
		id: string;
		type?: string | null;
		addedParents?: string[];
		deleted?: boolean;
		pinned?: boolean;
		later?: number | null;
		inbox?: number; // checked off: kept in the inbox since then
	}[];
}

export function revert(u: Undo) {
	for (const step of u.steps) {
		const repo = replica(step.space).repo;
		if (step.deleted) repo.restore(step.id);
		if (step.type !== undefined) repo.setType(step.id, step.type);
		for (const parent of step.addedParents ?? []) repo.removeParent(step.id, parent);
		if (step.pinned) repo.pin(step.id, false);
		if (step.later !== undefined)
			repo.change(step.id, (doc) => setMeta(doc, { later: step.later }));
		if (step.inbox !== undefined)
			repo.change(step.id, (doc) => setMeta(doc, { inbox: step.inbox }));
	}
}

/** The types a workspace offers first (its capture types, as set in its settings). */
export function captureTypes(space: string): string[] {
	return replica(space).repo.index().captureTypes();
}

/**
 * Each action returns its undo (or nothing when nothing happened). A place and a type belong to one
 * workspace, so those act on entries of one workspace only (the pickers enforce it). `quiet`: no
 * notice, the caller shows what was done.
 */
export function useTriageActions(spaceOf: (i: Item) => string, opts: { quiet?: boolean } = {}) {
	const { t } = useT();
	const last = useRef<Undo | null>(null);
	const repoOf = (i: Item) => replica(spaceOf(i)).repo;
	const firstType = (i?: Item) => (i ? captureTypes(spaceOf(i))[0] : undefined);
	const done = (u: Undo) => {
		last.current = u;
		if (!opts.quiet)
			notify.undo(u.label, () => {
				revert(u);
				last.current = null;
			});
		return u;
	};
	const short = (i?: Item) => {
		const name = i ? titleOf(i, t) : t("untitled");
		return name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX - 1)}…` : name;
	};
	// one entry: its short title, unless `values` brings one
	const label = (list: Item[], key: string, values: Values = {}) =>
		list.length > 1
			? t(`${key}Many`, { count: list.length, ...values })
			: t(key, { title: short(list[0]), ...values });
	const giveType = (list: Item[], type: string) => {
		const notes = list.filter((i) => i.kind === "note");
		if (!notes.length) return;
		const repo = repoOf(notes[0]!);
		const name = repo.index().typeName(type);
		const u = done({
			label:
				list.length > 1
					? label(notes, "triage.typed", { name })
					: t("triage.typedOne", { title: short(notes[0]), name }),
			steps: notes.map((i) => ({ space: spaceOf(i), id: i.id, type: i.type })),
		});
		for (const i of notes) repo.setType(i.id, type);
		return u;
	};
	const trash = async (list: Item[]): Promise<Undo | null> => {
		// entries with notes below: delete those too, or let them back into the inbox?
		const below = list.reduce((n, i) => n + onlyBelow(repoOf(i).index(), i.id).length, 0);
		let children: "trash" | "inbox" = "trash";
		if (below) {
			const c = await chooseAction({
				title:
					list.length > 1
						? t("triage.deleteMany", { count: list.length })
						: t("delete.title", { title: titleOf(list[0]!, t) }),
				body: t("delete.children", { count: below }),
				choices: [
					{ key: "inbox", label: t("delete.backToInbox") },
					{
						key: "trash",
						label: t("delete.all", { count: below + list.length }),
						primary: true,
						danger: true,
					},
				],
			});
			if (!c) return null;
			children = c;
		}
		const u = done({
			label: label(list, children === "inbox" && below ? "triage.trashedKeep" : "triage.trashed", {
				count: below,
				title: short(list[0]),
			}),
			steps: list.map((i) => ({ space: spaceOf(i), id: i.id, deleted: true })),
		});
		for (const i of list) repoOf(i).remove(i.id, children);
		return u;
	};
	const place = (list: Item[], parent: string) => {
		if (!list.length) return;
		const repo = repoOf(list[0]!);
		const ok = list.filter((i) => repo.addParent(i.id, parent));
		if (!ok.length) return;
		rememberPlace(parent);
		const where = repo.index().get(parent)?.title ?? "";
		return done({
			label:
				ok.length > 1
					? t("triage.placedMany", { count: ok.length, title: where })
					: t("triage.placedOne", { title: short(ok[0]), place: where }),
			steps: ok.map((i) => ({ space: spaceOf(i), id: i.id, addedParents: [parent] })),
		});
	};
	// out of the inbox: done with it; it stays where it was sorted to
	const checkOff = (list: Item[]) => {
		const kept = list.filter((i) => i.inbox);
		if (!kept.length) return;
		const u = done({
			label: label(kept, "triage.checkedOff", { title: short(kept[0]) }),
			steps: kept.map((i) => ({ space: spaceOf(i), id: i.id, inbox: i.inbox })),
		});
		for (const i of kept) repoOf(i).setInbox(i.id, false);
		return u;
	};
	// a place of its own at the top of the sidebar; in the inbox it stays there
	const pin = (list: Item[]) => {
		const fresh = list.filter((i) => !i.pinned);
		if (!fresh.length) return;
		const u = done({
			label: label(fresh, "triage.pinned", { title: short(fresh[0]) }),
			steps: fresh.map((i) => ({ space: spaceOf(i), id: i.id, pinned: true })),
		});
		for (const i of fresh) repoOf(i).pin(i.id, true);
		return u;
	};
	const later = (list: Item[]) => {
		if (!list.length) return;
		const u = done({
			label: label(list, "triage.later", { title: short(list[0]) }),
			steps: list.map((i) => ({ space: spaceOf(i), id: i.id, later: i.later ?? null })),
		});
		for (const i of list) repoOf(i).change(i.id, (doc) => setMeta(doc, { later: tomorrow() }));
		return u;
	};
	// "u": takes back the last one (the notice offers the same)
	const undo = () => {
		if (!last.current) return;
		revert(last.current);
		last.current = null;
	};
	return { firstType, giveType, trash, place, pin, later, checkOff, undo };
}

export function usePickers(
	spaceOf: (i: Item) => string,
	place: (list: Item[], p: string) => void,
	giveType: (list: Item[], t: string) => void,
	after?: () => void,
) {
	const { t } = useT();
	const [placing, setPlacingRaw] = useState<Item[] | null>(null);
	const [typing, setTypingRaw] = useState<Item[] | null>(null);
	// a place or a type is one workspace's: entries of several are sorted one workspace at a time
	const one = (list: Item[]) => {
		if (new Set(list.map(spaceOf)).size <= 1) return true;
		notify(t("triage.oneSpace"));
		return false;
	};
	const setPlacing = (list: Item[] | null) => (!list || one(list)) && setPlacingRaw(list);
	const setTyping = (list: Item[] | null) => (!list || one(list)) && setTypingRaw(list);
	const node = (
		<>
			{placing && placing.length > 0 && (
				<SpaceScope id={spaceOf(placing[0]!)}>
					<PlacePicker
						list={placing}
						onClose={() => setPlacingRaw(null)}
						onPick={(p) => {
							place(placing, p);
							setPlacingRaw(null);
							after?.();
						}}
					/>
				</SpaceScope>
			)}
			{typing && typing.length > 0 && (
				<SpaceScope id={spaceOf(typing[0]!)}>
					<TypePicker
						current={typing.length === 1 ? typing[0]!.type : null}
						onClose={() => setTypingRaw(null)}
						onPick={(type) => {
							giveType(typing, type);
							setTypingRaw(null);
							after?.();
						}}
					/>
				</SpaceScope>
			)}
		</>
	);
	return { node, placing, typing, setPlacing, setTyping };
}

/** Choose a type by keyboard: type to filter, arrows, Enter, 1–9; "New type …" at the end. */
function TypePicker({
	current,
	onPick,
	onClose,
}: {
	current: string | null;
	onPick: (id: string) => void;
	onClose: () => void;
}) {
	const { t } = useT();
	const repo = useRepo();
	const ix = repo.index();
	const [q, setQ] = useState("");
	const [sel, setSel] = useState(0);
	// "New type …" without a name: the field asks for one
	const [naming, setNaming] = useState(false);
	const field = useRef<HTMLInputElement>(null);
	const types = ix
		.typesByName()
		.filter((type) => !q.trim() || type.schema.name.toLowerCase().includes(titleKey(q)));
	const exact = types.some((type) => type.schema.name.toLowerCase() === titleKey(q));
	const rows: { id?: string; create?: string }[] = [
		...types.map((type) => ({ id: type.id })),
		{ create: q.trim() && !exact ? q.trim() : "" },
	];
	const pick = (row?: (typeof rows)[number]) => {
		if (!row) return;
		if (row.id) return onPick(row.id);
		const name = row.create?.trim();
		if (name) onPick(createType(name, repo));
		else {
			setNaming(true);
			field.current?.focus();
		}
	};
	return (
		<Dialog onClose={onClose} title={t("triage.chooseType")}>
			<Input
				autoFocus
				className="mb-2 focus:border-focus"
				onChange={(e) => {
					setQ(e.target.value);
					setSel(0);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown") {
						e.preventDefault();
						setSel((s) => Math.min(rows.length - 1, s + 1));
					} else if (e.key === "ArrowUp") {
						e.preventDefault();
						setSel((s) => Math.max(0, s - 1));
					} else if (e.key === "Enter") {
						e.preventDefault();
						pick(naming && q.trim() ? { create: q } : rows[sel]);
					} else if (!q && /^[1-9]$/.test(e.key) && rows[Number(e.key) - 1]?.id) {
						e.preventDefault();
						pick(rows[Number(e.key) - 1]);
					}
				}}
				placeholder={naming ? t("types.new") : t("triage.typeFilter")}
				ref={field}
				value={q}
			/>
			<div className="flex flex-col" role="listbox">
				{rows.map((row, n) => {
					const type = row.id ? ix.types.get(row.id) : undefined;
					return (
						<Button
							aria-selected={n === sel}
							className={cn(
								"flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
								n === sel && "bg-selected",
								!row.id && "mt-1 border-t border-line pt-2",
							)}
							key={row.id ?? "new"}
							onClick={() => pick(row)}
							onMouseEnter={() => setSel(n)}
							role="option"
							variant="plain"
						>
							{type ? (
								<TypeGlyph schema={type.schema} size={15} />
							) : (
								<Plus className="text-muted-foreground" size={15} />
							)}
							<span className="min-w-0 flex-1 truncate">
								{type
									? type.schema.name
									: row.create
										? t("triage.newTypeNamed", { name: row.create })
										: t("triage.newType")}
							</span>
							{type && row.id === current && <Check className="text-ok" size={14} />}
							{type && n < 9 && !q && <Kbd>{n + 1}</Kbd>}
						</Button>
					);
				})}
			</div>
		</Dialog>
	);
}
