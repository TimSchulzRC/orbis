// "Edit type": a dialog laid out like the app's settings. A short navigation on the left
// (Allgemein, Eigenschaften, Fähigkeiten), a page of setting rows on the right. "Eigenschaften"
// lists the properties; each opens a page of its own, with a way back.

import type { T } from "@obtion/core/i18n";
import {
	type Item,
	type OptionDef,
	type Patch,
	PROP_KINDS,
	type PropDef,
	type PropKind,
	removeProp,
	STATUS_GROUPS,
	type StatusGroup,
	setCapability,
	setMeta,
	setSchemaField,
	shortId,
	titleKey,
	upsertProp,
} from "@obtion/core/model";
import { COLORS, ICONS } from "@obtion/core/palette";
import { parseQuery, printQuery, runQuery } from "@obtion/core/query";
import { keyBetween } from "@obtion/core/sortkey";
import {
	defaultStatusOptions,
	isProgressProp,
	kindPatch,
	progressProp,
	statusProp,
} from "@obtion/core/traits";
import {
	type DeleteMode,
	deleteType,
	previewTagToType,
	tagToType,
	typeUsage,
} from "@obtion/core/typeops";
import { followKindChange, followPropChange, followTypeRename } from "@obtion/core/typerefs";
import {
	ArrowDown,
	ArrowLeft,
	ArrowUp,
	Calendar,
	CheckSquare,
	ChevronRight,
	CircleDashed,
	GripVertical,
	Hash,
	Link,
	Link2,
	ListChecks,
	Plus,
	Settings2,
	Sigma,
	Sparkles,
	Type,
	X,
} from "lucide-react";
import { type ComponentType, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { Checkbox } from "../components/ui/checkbox";
import { DialogContent, Dialog as DialogRoot, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { Textarea } from "../components/ui/textarea";
import { navigate, useIndex, useRepo } from "../hooks";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { ICON } from "../ui/icons";
import { ItemIcon, pal, TypeGlyph } from "../ui/item-look";
import { isBadge } from "../ui/Properties";
import { Button, Dialog, IconButton, Popover, Seg } from "../ui/primitives";
import { SettingRow, SettingsGroup } from "../ui/SettingRows";
import { NewTypeDialog } from "./Types";

type Page = "general" | "props" | "caps";
type Modal = null | "delete" | "fromTag" | "toTag";

const KIND_ICON: Record<PropKind, ComponentType<{ size?: number; className?: string }>> = {
	text: Type,
	number: Hash,
	date: Calendar,
	checkbox: CheckSquare,
	url: Link,
	select: ListChecks,
	status: CircleDashed,
	relation: Link2,
	computed: Sigma,
};

const INPUT =
	"w-56 max-w-full rounded-md border border-line bg-bg px-2.5 py-1 text-sm outline-none focus:border-focus";
const SELECT = "rounded-md border border-line bg-bg px-2 py-1 pr-8 text-sm";
const AREA =
	"w-full resize-y rounded-lg border border-line bg-bg px-2.5 py-1.5 text-sm outline-none focus:border-focus";

export function TypeEditor({ item, onClose }: { item: Item; onClose: () => void }) {
	const { t } = useT();
	const schema = item.schema!;
	const [page, setPage] = useState<Page>("general");
	const [open, setOpen] = useState<string>();
	// the property just left with "Zurück" gets the focus back; one just added also lights up
	const [left, setLeft] = useState<{ id: string; added: boolean }>();
	const [added, setAdded] = useState<string>();
	const [dialog, setDialog] = useState<Modal>(null);
	const previous = useRef<HTMLElement | null>(document.activeElement as HTMLElement);
	// a property that is gone (removed here or on another device) shows the list again
	const prop = page === "props" ? schema.properties.find((p) => p.id === open) : undefined;
	const go = (next: Page) => (setPage(next), setOpen(undefined), setLeft(undefined));
	const pages: {
		id: Page;
		label: string;
		icon: ComponentType<{ size?: number; className?: string }>;
		count?: number;
	}[] = [
		{ id: "general", label: t("type.general"), icon: Settings2 },
		{ id: "props", label: t("type.properties"), icon: ListChecks, count: schema.properties.length },
		{ id: "caps", label: t("caps.title"), icon: Sparkles },
	];
	const label = pages.find((p) => p.id === page)!.label;
	const back = () => (open && setLeft({ id: open, added: open === added }), setOpen(undefined));
	const onAdded = (id: string) => (setAdded(id), setOpen(id));

	return (
		<DialogRoot
			onOpenChange={(o) => {
				if (!o) onClose();
			}}
			open
		>
			<DialogContent
				aria-describedby={undefined}
				className="flex h-[min(52rem,90vh)] flex-col gap-0 overflow-hidden rounded-2xl bg-bg p-0 sm:max-w-5xl md:flex-row"
				onCloseAutoFocus={(e) => {
					e.preventDefault();
					if (previous.current?.isConnected) previous.current.focus({ preventScroll: true });
				}}
				showCloseButton={false}
			>
				<nav
					aria-label={t("type.edit")}
					className="flex shrink-0 flex-col border-b border-line bg-surface-2/50 md:w-56 md:border-b-0 md:border-r"
				>
					<div className="flex h-12 shrink-0 items-center gap-2 px-4">
						<TypeGlyph schema={schema} size={18} />
						<span className="min-w-0 flex-1 truncate font-semibold">{schema.name}</span>
					</div>
					{/* narrow: the three pages in a row above the page */}
					<div className="flex gap-0.5 px-2 pb-2 md:flex-col">
						{pages.map(({ id, label, icon: Icon, count }) => (
							<Button
								aria-current={page === id ? "page" : undefined}
								className={cn(
									"tap-y flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover max-md:flex-auto max-md:justify-center max-md:px-2 md:w-full",
									page === id
										? "bg-surface font-medium text-fg shadow-xs"
										: "text-muted-foreground",
								)}
								key={id}
								onClick={() => go(id)}
								variant="plain"
							>
								<Icon className="shrink-0 max-sm:hidden" size={15} />
								<span className="min-w-0 truncate md:flex-1">{label}</span>
								{count !== undefined && (
									<span className="text-xs tabular-nums text-muted-foreground max-sm:hidden">
										{count}
									</span>
								)}
							</Button>
						))}
					</div>
				</nav>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-5">
						{prop && (
							<IconButton className="-ml-2" icon={ArrowLeft} label={t("nav.back")} onClick={back} />
						)}
						<DialogTitle className="flex min-w-0 flex-1 items-center gap-2 text-sm font-normal">
							<span className="truncate text-muted-foreground">{schema.name}</span>
							<span className="text-faint">/</span>
							{prop ? (
								<>
									<Button
										className="truncate text-muted-foreground hover:text-fg"
										onClick={back}
										variant="plain"
									>
										{label}
									</Button>
									<span className="text-faint">/</span>
									<span className="truncate font-medium text-fg">{prop.name}</span>
								</>
							) : (
								<span className="truncate font-medium text-fg">{label}</span>
							)}
						</DialogTitle>
						<IconButton icon={X} label={t("close")} onClick={onClose} />
					</div>
					{/* a new key for each page, so it starts scrolled to the top */}
					<div className="min-h-0 flex-1 overflow-y-auto" key={page + (prop?.id ?? "")}>
						<div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
							{page === "general" && <GeneralPage item={item} setDialog={setDialog} />}
							{page === "caps" && <CapsPage item={item} />}
							{page === "props" &&
								(prop ? (
									<PropPage item={item} prop={prop} />
								) : (
									<PropListPage item={item} left={left} onAdded={onAdded} onOpen={setOpen} />
								))}
						</div>
					</div>
				</div>
				{dialog === "delete" && <DeleteTypeDialog item={item} onClose={() => setDialog(null)} />}
				{dialog === "toTag" && (
					<DeleteTypeDialog item={item} onClose={() => setDialog(null)} toTag />
				)}
				{dialog === "fromTag" && <FromTagDialog item={item} onClose={() => setDialog(null)} />}
			</DialogContent>
		</DialogRoot>
	);
}

/** The type itself, then the rare actions spelled out as rows. */
function GeneralPage({ item, setDialog }: { item: Item; setDialog: (m: Modal) => void }) {
	const repo = useRepo();
	const { t } = useT();
	const ix = useIndex();
	const schema = item.schema!;
	const change = (fn: (doc: Y.Doc) => void) => repo.change(item.id, fn);
	const rename = (v: string) => {
		if (!v || v === schema.name) return;
		change((d) => (setSchemaField(d, "name", v), setMeta(d, { title: v })));
		followTypeRename(repo.writer, ix, schema.name, v);
	};
	const plural = ix.typePlural(item.id);
	return (
		<div className="space-y-7">
			<SettingsGroup title={t("type.section")}>
				<SettingRow
					control={
						<Input
							aria-label={t("type.name")}
							className={INPUT}
							defaultValue={schema.name}
							key={schema.name}
							onBlur={(e) => rename(e.target.value.trim())}
							variant="bare"
						/>
					}
					hint={t("type.nameHint")}
					title={t("type.name")}
				/>
				<SettingRow
					control={
						<Input
							aria-label={t("type.plural")}
							className={INPUT}
							defaultValue={plural}
							key={item.id + (schema.plural ?? "")}
							onBlur={(e) =>
								e.target.value.trim() !== plural &&
								change((d) => setSchemaField(d, "plural", e.target.value.trim()))
							}
							variant="bare"
						/>
					}
					hint={t("type.pluralHint")}
					title={t("type.plural")}
				/>
				<SettingRow control={<LookPicker item={item} />} title={t("type.icon")} />
				<SettingRow hint={t("type.descriptionHint")} title={t("type.descriptionTitle")}>
					<Textarea
						aria-label={t("type.descriptionTitle")}
						className={AREA}
						defaultValue={schema.description}
						key={item.id}
						onBlur={(e) =>
							e.target.value !== schema.description &&
							change((d) => setSchemaField(d, "description", e.target.value))
						}
						rows={3}
					/>
				</SettingRow>
			</SettingsGroup>
			<SettingsGroup title={t("type.manage")}>
				<SettingRow
					control={
						<Button onClick={() => setDialog("fromTag")} variant="outline">
							{t("type.fromTagAction")}
						</Button>
					}
					hint={t("type.fromTagHint")}
					title={t("type.fromTagTitle")}
				/>
				<SettingRow
					control={
						<Button onClick={() => setDialog("toTag")} variant="outline">
							{t("type.toTagAction")}
						</Button>
					}
					hint={t("type.toTagHint")}
					title={t("type.modeTag")}
				/>
				<SettingRow
					control={
						<Button className="text-danger" onClick={() => setDialog("delete")} variant="outline">
							{t("type.deleteAction")}
						</Button>
					}
					hint={t("type.deleteHint")}
					title={t("type.delete")}
				/>
			</SettingsGroup>
		</div>
	);
}

function LookPicker({ item }: { item: Item }) {
	const repo = useRepo();
	const { t } = useT();
	const schema = item.schema!;
	const set = (k: "icon" | "color", v: string) =>
		repo.change(item.id, (d) => setSchemaField(d, k, v));
	return (
		<Popover
			align="right"
			trigger={(p) => (
				<Button variant="outline" {...p} aria-label={t("type.icon")} className="gap-2">
					<TypeGlyph schema={schema} size={16} /> {t("type.lookChange")}
				</Button>
			)}
		>
			{(close) => (
				<div className="w-72 p-1">
					<div className="grid grid-cols-8 gap-1">
						{ICONS.map((n) => {
							const Icon = ICON[n] ?? ICON.circle!;
							return (
								<Button
									aria-label={n}
									className={cn(
										"tap rounded-md p-1.5 hover:bg-hover",
										schema.icon === n && "bg-hover",
									)}
									key={n}
									onClick={() => (set("icon", n), close())}
									variant="plain"
								>
									<Icon size={16} style={{ color: pal(schema.color) }} />
								</Button>
							);
						})}
					</div>
					<div className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
						{COLORS.map((c) => (
							<Button
								aria-label={c}
								className={cn(
									"size-6 rounded-full border-2",
									schema.color === c ? "border-fg" : "border-transparent",
								)}
								key={c}
								onClick={() => set("color", c)}
								style={{ background: pal(c) }}
								variant="plain"
							/>
						))}
					</div>
				</div>
			)}
		</Popover>
	);
}

/** Every switch on the right, as in the app's settings. */
function CapsPage({ item }: { item: Item }) {
	const repo = useRepo();
	const { t } = useT();
	const schema = item.schema!;
	const caps = schema.capabilities;
	const set = <K extends keyof typeof caps>(k: K, v: (typeof caps)[K] | null) =>
		repo.change(item.id, (d) => setCapability(d, k, v));
	const dateProps = schema.properties.filter((p) => p.kind === "date");
	return (
		<div className="space-y-7">
			<SettingsGroup title={t("caps.title")}>
				<SettingRow
					control={
						<NativeSelect
							aria-label={t("caps.due")}
							className={SELECT}
							onChange={(e) => set("due", e.target.value || null)}
							value={caps.due ?? ""}
						>
							<option value="">{t("caps.off")}</option>
							{dateProps.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</NativeSelect>
					}
					hint={t("caps.dueHint")}
					title={t("caps.due")}
				/>
				<SettingRow
					control={
						<Checkbox
							aria-label={t("caps.updates")}
							checked={!!caps.updates}
							className="size-4"
							onCheckedChange={(c) => set("updates", c === true || null)}
						/>
					}
					hint={t("caps.updatesHint")}
					title={t("caps.updates")}
				/>
			</SettingsGroup>
			<SettingsGroup title={t("caps.newItems")}>
				<SettingRow
					control={
						<Checkbox
							aria-label={t("caps.template")}
							checked={!!caps.template}
							className="size-4"
							onCheckedChange={(c) => set("template", c === true ? { body: "" } : null)}
						/>
					}
					hint={t("caps.templateHint")}
					title={t("caps.template")}
				>
					{caps.template && (
						<Textarea
							aria-label={t("caps.template")}
							className={cn(AREA, "font-mono text-xs")}
							defaultValue={caps.template.body ?? ""}
							key={item.id + "tpl"}
							onBlur={(e) => set("template", { ...caps.template, body: e.target.value })}
							placeholder={t("caps.templatePlaceholder")}
							rows={5}
						/>
					)}
				</SettingRow>
			</SettingsGroup>
		</div>
	);
}

/**
 * Drag and drop within one list: `onDrop(from, to)` with the ids of the row dragged and the row
 * it was dropped on.
 */
function useDragRows(onDrop: (from: string, to: string) => void) {
	const [drag, setDrag] = useState<string | null>(null);
	const [over, setOver] = useState<string | null>(null);
	const end = () => (setDrag(null), setOver(null));
	const row = (id: string) => ({
		draggable: true,
		onDragStart: (e: React.DragEvent) => (
			e.dataTransfer.setData("text/plain", id), (e.dataTransfer.effectAllowed = "move"), setDrag(id)
		),
		onDragEnd: end,
		onDragOver: (e: React.DragEvent) => drag && drag !== id && (e.preventDefault(), setOver(id)),
		onDragLeave: () => setOver((o) => (o === id ? null : o)),
		onDrop: (e: React.DragEvent) => (
			e.preventDefault(), drag && drag !== id && onDrop(drag, id), end()
		),
	});
	return { row, over, drag };
}

/**
 * One row per property; each opens its own page. The badges (status, single selections) show at
 * the top of a page, the rest below; each part has an order of its own, so each has its own card.
 */
function PropListPage({
	item,
	onOpen,
	onAdded,
	left,
}: {
	item: Item;
	onOpen: (id: string) => void;
	onAdded: (id: string) => void;
	left?: { id: string; added: boolean };
}) {
	const repo = useRepo();
	const { t } = useT();
	const schema = item.schema!;
	const props = schema.properties;
	// dropped on a row: takes its place, the row moves aside in the direction the drag came from
	const move = (from: string, to: string) => {
		const a = props.findIndex((p) => p.id === from);
		const b = props.findIndex((p) => p.id === to);
		const sort =
			a > b
				? keyBetween(props[b - 1]?.sort ?? null, props[b]!.sort)
				: keyBetween(props[b]!.sort, props[b + 1]?.sort ?? null);
		repo.change(item.id, (d) => upsertProp(d, from, { sort }));
	};
	const badges = props.filter(isBadge);
	const rows = props.filter((p) => !isBadge(p));
	return (
		// no properties yet: one card that says how the two parts come about, the button in it
		!props.length ? (
			<div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface px-6 py-10 text-center">
				<p className="text-sm font-medium">{t("type.noProps")}</p>
				<p className="max-w-sm text-sm text-muted-foreground">{t("type.emptyHint")}</p>
				<AddProperty align="center" item={item} onAdded={onAdded} />
			</div>
		) : (
			<div className="space-y-7">
				{/* the button heads the whole list, not one of its cards: the kind decides where a new property goes */}
				<div className="flex items-center gap-4 px-1">
					<h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{t("type.properties")}</h2>
					<AddProperty item={item} onAdded={onAdded} />
				</div>
				<PropGroup
					empty={t("type.noBadges")}
					hint={t("type.badgeHint")}
					left={left}
					move={move}
					onOpen={onOpen}
					props={badges}
					title={t("type.badgeProps")}
				/>
				<PropGroup
					empty={t("type.noRows")}
					hint={t("type.rowHint")}
					left={left}
					move={move}
					onOpen={onOpen}
					props={rows}
					title={t("type.rowProps")}
				/>
			</div>
		)
	);
}

/** A card of properties, sorted by dragging within it (or one step up or down). */
function PropGroup({
	title,
	hint,
	props,
	empty,
	move,
	onOpen,
	left,
}: {
	title: string;
	hint: string;
	props: PropDef[];
	empty: string;
	move: (from: string, to: string) => void;
	onOpen: (id: string) => void;
	left?: { id: string; added: boolean };
}) {
	const { row, over, drag } = useDragRows(move);
	const flash = useFlash(left?.added ? left.id : undefined);
	// back from a property (the list is new then): its row in view and focused, so the keyboard
	// goes on from there
	const buttons = useRef(new Map<string, HTMLButtonElement>());
	useEffect(() => {
		const el = left && buttons.current.get(left.id);
		if (el) el.scrollIntoView({ block: "nearest" }), el.focus({ preventScroll: true });
	}, [left]);
	return (
		<SettingsGroup hint={hint} title={title}>
			{props.map((p, i) => (
				<div
					key={p.id}
					{...row(p.id)}
					className={cn(
						"group flex items-center gap-2 px-2 transition-colors duration-700 hover:bg-hover motion-reduce:transition-none",
						over === p.id && "bg-hover",
						drag === p.id && "opacity-50",
						flash === p.id && "bg-inbox/15",
					)}
				>
					<GripVertical
						aria-hidden
						className="shrink-0 cursor-grab text-faint pointer-coarse:hidden"
						size={14}
					/>
					<Button
						className="tap-row flex min-w-0 flex-1 items-center gap-3 py-2.5 pr-2 text-left"
						onClick={() => onOpen(p.id)}
						ref={(el) => void (el ? buttons.current.set(p.id, el) : buttons.current.delete(p.id))}
						variant="plain"
					>
						<PropRowText prop={p} />
					</Button>
					{/* without a mouse to drag (keyboard, touch): one step up or down */}
					<span className="flex opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
						<MoveButton dir="up" disabled={i === 0} onClick={() => move(p.id, props[i - 1]!.id)} />
						<MoveButton
							dir="down"
							disabled={i === props.length - 1}
							onClick={() => move(p.id, props[i + 1]!.id)}
						/>
					</span>
					<ChevronRight aria-hidden className="mr-2 shrink-0 text-faint" size={16} />
				</div>
			))}
			{!props.length && <p className="px-4 py-3 text-sm text-muted-foreground">{empty}</p>}
		</SettingsGroup>
	);
}

/** `id` for about a second after it is set, then nothing: a row that lights up once. */
function useFlash(id: string | undefined) {
	const [on, setOn] = useState(id);
	useEffect(() => {
		if (!id) return;
		const timer = setTimeout(() => setOn(undefined), 1000);
		return () => clearTimeout(timer);
	}, [id]);
	return on;
}

function MoveButton({
	dir,
	disabled,
	onClick,
}: {
	dir: "up" | "down";
	disabled: boolean;
	onClick: () => void;
}) {
	const { t } = useT();
	return (
		<Button
			aria-label={t(dir === "up" ? "type.up" : "type.down")}
			className="tap rounded p-0.5 text-muted-foreground hover:text-fg disabled:opacity-30"
			disabled={disabled}
			onClick={onClick}
			variant="plain"
		>
			{dir === "up" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
		</Button>
	);
}

function PropRowText({ prop }: { prop: PropDef }) {
	const { t } = useT();
	const Icon = KIND_ICON[prop.kind] ?? Type;
	const kind = kindLabel(prop, t);
	// options say more than the description; without either, the kind alone
	const detail = prop.options?.length
		? prop.options.map((o) => o.name).join(", ")
		: prop.description;
	return (
		<>
			<Icon className="shrink-0 text-muted-foreground" size={16} />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm font-medium">{prop.name}</span>
				<span className="block truncate text-xs text-muted-foreground">
					{detail ? `${kind} · ${detail}` : kind}
				</span>
			</span>
		</>
	);
}

/** A property's page: its settings as rows, its options as cards, removing it at the end. */
function PropPage({ item, prop }: { item: Item; prop: PropDef }) {
	const repo = useRepo();
	const { t, lang } = useT();
	const ix = useIndex();
	const set = (patch: Patch<Omit<PropDef, "id">>) =>
		repo.change(item.id, (d) => upsertProp(d, prop.id, patch));
	const isStatus = prop.kind === "status";
	// a type has one status: the kind is offered only to it or while there is none
	const kinds = PROP_KINDS.filter((k) => k !== "status" || isStatus || !statusProp(item.schema));
	// stored values follow where they can (an option becomes its name as text and back)
	const changeKind = (next: { kind?: PropKind; multiple?: boolean }) => {
		const patch = next.kind ? kindPatch(prop, next.kind, defaultStatusOptions(t)) : {};
		repo.change(item.id, (d) => {
			if (next.kind) upsertProp(d, prop.id, patch);
			if (next.multiple !== undefined)
				upsertProp(
					d,
					prop.id,
					next.multiple ? { multiple: true, default: null } : { multiple: null },
				);
		});
		followKindChange(repo.writer, ix, item.id, prop, {
			...prop,
			...(patch as Partial<PropDef>),
			...next,
		});
	};
	const rename = (v: string) =>
		v &&
		v !== prop.name &&
		(set({ name: v }),
		followPropChange(
			repo.writer,
			ix,
			{ type: item.id, prop: prop.id, from: prop.name, to: v },
			lang,
		));
	const remove = () => (
		repo.change(item.id, (d) => removeProp(d, prop.id)),
		followPropChange(
			repo.writer,
			ix,
			{ type: item.id, prop: prop.id, from: prop.name, to: null },
			lang,
		)
	);
	const options = prop.options ?? [];
	const setOptions = (next: OptionDef[]) =>
		set({
			options: next,
			...(prop.default && !next.some((o) => o.id === prop.default)
				? { default: isStatus ? next[0]?.id : (null as any) }
				: {}),
		});
	const types = [...ix.types.values()];
	const seg = (value: boolean, onChange: (many: boolean) => void, label: string) => (
		<Seg
			label={label}
			onChange={(v) => onChange(v === "many")}
			options={[
				{ value: "one", label: t("type.one") },
				{ value: "many", label: t("type.many") },
			]}
			value={value ? "many" : "one"}
		/>
	);
	const check = (checked: boolean, onChange: (on: true | null) => void, label: string) => (
		<Checkbox
			aria-label={label}
			checked={checked}
			className="size-4"
			onCheckedChange={(c) => onChange(c === true || null)}
		/>
	);
	return (
		<div className="space-y-7">
			<SettingsGroup title={t("type.prop")}>
				<SettingRow
					control={
						<Input
							aria-label={t("props.name")}
							className={INPUT}
							defaultValue={prop.name}
							key={prop.name}
							onBlur={(e) => rename(e.target.value.trim())}
							variant="bare"
						/>
					}
					title={t("props.name")}
				/>
				<SettingRow
					control={
						<NativeSelect
							aria-label={t("props.kind")}
							className={SELECT}
							onChange={(e) => changeKind({ kind: e.target.value as PropKind })}
							value={prop.kind}
						>
							{kinds.map((k) => (
								<option key={k} value={k}>
									{t("kind.prop." + k)}
								</option>
							))}
						</NativeSelect>
					}
					hint={t("type.kindHint")}
					title={t("props.kind")}
				/>
				<SettingRow hint={t("type.propDescriptionHint")} title={t("type.propDescription")}>
					<Textarea
						aria-label={t("type.propDescription")}
						className={AREA}
						defaultValue={prop.description ?? ""}
						key={prop.id + "d"}
						onBlur={(e) => set({ description: e.target.value || null })}
						rows={2}
					/>
				</SettingRow>
				{prop.kind === "select" && (
					<SettingRow
						control={seg(
							!!prop.multiple,
							(many) => changeKind({ multiple: many }),
							t("type.values"),
						)}
						title={t("type.values")}
					/>
				)}
				{(prop.kind === "select" || isStatus) && !prop.multiple && (
					<SettingRow
						control={
							<NativeSelect
								aria-label={t("type.default")}
								className={SELECT}
								onChange={(e) => set({ default: e.target.value || (null as any) })}
								value={prop.default ?? ""}
							>
								{!isStatus && <option value="">{t("type.defaultNone")}</option>}
								{options.map((o) => (
									<option key={o.id} value={o.id}>
										{o.name}
									</option>
								))}
							</NativeSelect>
						}
						hint={
							isStatus || prop.default
								? t(isStatus ? "type.defaultStatusHint" : "type.defaultHint")
								: undefined
						}
						title={t("type.default")}
					/>
				)}
				{(prop.kind === "relation" || prop.kind === "text") && (
					<SettingRow
						control={check(!!prop.blocks, (on) => set({ blocks: on }), t("type.blocks"))}
						hint={t(prop.kind === "relation" ? "type.blocksRelationHint" : "type.blocksTextHint")}
						title={t("type.blocks")}
					/>
				)}
				{prop.kind === "date" && (
					<SettingRow
						control={check(!!prop.range, (on) => set({ range: on }), t("type.range"))}
						title={t("type.range")}
					/>
				)}
				{prop.kind === "computed" && (
					<>
						<SettingRow
							control={
								<Seg
									label={t("type.computed")}
									onChange={(fn) => set({ computed: { ...prop.computed, fn } })}
									options={[
										{ value: "progress", label: t("type.fnProgress") },
										{ value: "count", label: t("type.fnCount") },
									]}
									value={prop.computed?.fn ?? "progress"}
								/>
							}
							hint={
								isProgressProp(prop)
									? t(
											progressProp(item.schema)?.id === prop.id
												? "type.progressMain"
												: "type.progressMore",
										)
									: undefined
							}
							title={t("type.computed")}
						/>
						<SettingRow
							control={
								<NativeSelect
									aria-label={t("type.ofType")}
									className={SELECT}
									onChange={(e) =>
										set({
											computed: {
												fn: prop.computed?.fn ?? "progress",
												of: e.target.value || undefined,
											},
										})
									}
									value={prop.computed?.of ?? ""}
								>
									<option value="">{t("type.anyType")}</option>
									{types.map((x) => (
										<option key={x.id} value={x.id}>
											{x.schema.name}
										</option>
									))}
								</NativeSelect>
							}
							title={t("type.ofType")}
						/>
					</>
				)}
			</SettingsGroup>
			{prop.kind === "relation" && (
				<SettingsGroup title={t("type.link")}>
					<SettingRow hint={t("type.targetHint")} title={t("type.target")}>
						<TargetField
							hits={relationTargets(prop, ix)}
							key={prop.id + "t"}
							onChange={(target) => set({ target: target || null })}
							target={prop.target}
						/>
					</SettingRow>
					<SettingRow
						control={seg(
							!!prop.multiple,
							(many) => set({ multiple: many || null }),
							t("type.count"),
						)}
						title={t("type.count")}
					/>
					<SettingRow
						control={
							<Input
								aria-label={t("type.inverse")}
								className={INPUT}
								defaultValue={prop.inverseName ?? ""}
								key={prop.id + "i"}
								onBlur={(e) => set({ inverseName: e.target.value.trim() || null })}
								placeholder={t("type.inverseOf", { name: prop.name })}
								variant="bare"
							/>
						}
						hint={t("type.inverseHint")}
						title={t("type.inverse")}
					/>
					<SettingRow
						control={check(
							!!prop.symmetric,
							(on) => set({ symmetric: on }),
							t("type.symmetricTitle"),
						)}
						hint={t("type.symmetricHint")}
						title={t("type.symmetricTitle")}
					/>
				</SettingsGroup>
			)}
			{(prop.kind === "select" || isStatus) && (
				<OptionGroups grouped={isStatus} onChange={setOptions} prop={prop} />
			)}
			<SettingsGroup title={t("type.removeSection")}>
				<SettingRow
					control={
						<Button className="text-danger" onClick={remove} variant="outline">
							{t("type.removeProp")}
						</Button>
					}
					hint={t("type.removeHint")}
					title={t("type.removeProp")}
				/>
			</SettingsGroup>
		</div>
	);
}

/**
 * A select's options in one card; a status's under its three groups, each a card with a sentence
 * on what the group does (as in Notion: To-do, In progress, Complete). Dragging an option onto
 * another moves it there, into that one's group.
 */
function OptionGroups({
	prop,
	grouped,
	onChange,
}: {
	prop: PropDef;
	grouped: boolean;
	onChange: (o: OptionDef[]) => void;
}) {
	const { t } = useT();
	const options = prop.options ?? [];
	const groupOf = (o: OptionDef) => o.group ?? "todo";
	const patch = (id: string, p: Partial<OptionDef>) =>
		onChange(options.map((o) => (o.id === id ? { ...o, ...p } : o)));
	// a moved option goes after the last one of its new group, so the order stays by group
	const intoGroup = (list: OptionDef[], o: OptionDef, group?: StatusGroup) => {
		const later = group
			? list.findIndex((x) => STATUS_GROUPS.indexOf(groupOf(x)) > STATUS_GROUPS.indexOf(group))
			: -1;
		const at = later < 0 ? list.length : later;
		return [...list.slice(0, at), o, ...list.slice(at)];
	};
	const add = (group?: StatusGroup) =>
		onChange(
			intoGroup(
				options,
				{ id: shortId("o"), name: t("type.newOption"), group, color: "gray" },
				group,
			),
		);
	const moveTo = (o: OptionDef, group: StatusGroup) =>
		onChange(
			intoGroup(
				options.filter((x) => x.id !== o.id),
				{ ...o, group },
				group,
			),
		);
	const { row, over, drag } = useDragRows((from, to) => {
		const a = options.findIndex((o) => o.id === from);
		const b = options.findIndex((o) => o.id === to);
		const moved = { ...options[a]!, ...(grouped ? { group: options[b]!.group } : {}) };
		const rest = options.filter((o) => o.id !== from);
		const at = rest.findIndex((o) => o.id === to) + (a < b ? 1 : 0);
		onChange([...rest.slice(0, at), moved, ...rest.slice(at)]);
	});
	const action = (group?: StatusGroup) => (
		<Button
			className="flex items-center gap-1 pb-0.5 text-xs text-muted-foreground hover:text-fg"
			onClick={() => add(group)}
			variant="plain"
		>
			<Plus size={12} /> {t("type.addOption")}
		</Button>
	);
	const optionRow = (o: OptionDef) => (
		<div
			key={o.id}
			{...row(o.id)}
			className={cn(
				"flex items-center gap-2.5 px-2 py-1.5 pr-3",
				over === o.id && "bg-hover",
				drag === o.id && "opacity-50",
			)}
		>
			<GripVertical aria-hidden className="shrink-0 cursor-grab text-faint" size={14} />
			<Popover
				trigger={(p) => (
					<Button
						variant="plain"
						{...p}
						aria-label={grouped ? t("type.colorGroup") : t("type.color")}
						className="tap size-4 shrink-0 rounded-full"
						style={{ background: pal(o.color ?? "gray") }}
					/>
				)}
			>
				{(close) => (
					<div className="w-56 p-1">
						<div className="flex flex-wrap gap-1.5">
							{COLORS.map((c) => (
								<Button
									aria-label={c}
									className={cn(
										"size-5 rounded-full border-2",
										o.color === c ? "border-fg" : "border-transparent",
									)}
									key={c}
									onClick={() => (patch(o.id, { color: c }), close())}
									style={{ background: pal(c) }}
									variant="plain"
								/>
							))}
						</div>
						{/* the way into another group without dragging, also into one that is empty */}
						{grouped && (
							<div className="mt-2 border-t border-line pt-2">
								<p className="px-1 pb-1 text-xs text-muted-foreground">{t("type.group")}</p>
								<Seg
									label={t("type.group")}
									onChange={(g) => (moveTo(o, g), close())}
									options={STATUS_GROUPS.map((g) => ({ value: g, label: t("group." + g) }))}
									value={groupOf(o)}
								/>
							</div>
						)}
					</div>
				)}
			</Popover>
			<Input
				aria-label={t("type.optionName")}
				className="field min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-sm outline-none hover:bg-hover"
				defaultValue={o.name}
				onBlur={(e) =>
					e.target.value.trim() &&
					e.target.value !== o.name &&
					patch(o.id, { name: e.target.value.trim() })
				}
				variant="bare"
			/>
			{prop.default === o.id && (
				<span className="shrink-0 rounded-full border border-line px-1.5 text-xs text-muted-foreground">
					{t("type.default")}
				</span>
			)}
			{/* a status keeps at least one option */}
			{!(grouped && options.length === 1) && (
				<IconButton
					className="text-muted-foreground"
					icon={X}
					iconSize={13}
					label={t("type.removeOption")}
					onClick={() => onChange(options.filter((x) => x.id !== o.id))}
					size="xs"
				/>
			)}
		</div>
	);
	if (!grouped)
		return (
			<SettingsGroup action={action()} title={t("type.options")}>
				{options.map(optionRow)}
				{!options.length && (
					<p className="px-4 py-3 text-sm text-muted-foreground">{t("type.noOptions")}</p>
				)}
			</SettingsGroup>
		);
	return (
		<>
			{STATUS_GROUPS.map((g) => {
				const mine = options.filter((o) => groupOf(o) === g);
				return (
					<SettingsGroup
						action={action(g)}
						hint={t("type.statusGroup." + g)}
						key={g}
						title={t("group." + g)}
					>
						{mine.map(optionRow)}
						{!mine.length && (
							<p className="px-4 py-3 text-sm text-muted-foreground">{t("type.noOptions")}</p>
						)}
					</SettingsGroup>
				);
			})}
		</>
	);
}

function AddProperty({
	item,
	onAdded,
	align = "right",
}: {
	item: Item;
	onAdded: (id: string) => void;
	align?: "right" | "center";
}) {
	const repo = useRepo();
	const { t } = useT();
	const ix = useIndex();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [kind, setKind] = useState<PropKind>("text");
	const hasStatus = !!statusProp(item.schema);
	// Same name on another type: offer to copy its settings (the types stay independent).
	const twins = name.trim()
		? [...ix.types.values()].flatMap((type) =>
				type.id === item.id
					? []
					: type.schema.properties
							.filter((p) => p.name.toLowerCase() === titleKey(name))
							.map((prop) => ({ type, prop })),
			)
		: [];
	const add = (copy?: PropDef) => {
		if (!name.trim()) return;
		const id = shortId("p");
		const { id: _i, sort: _s, ...rest } = copy ?? ({ id: "", sort: "", name: "", kind } as PropDef);
		// copied options keep their ids: queries by option name and conversions then work the same.
		// a type has one status: a copied one becomes a select
		const k = copy ? (copy.kind === "status" && hasStatus ? "select" : copy.kind) : kind;
		repo.change(item.id, (d) => {
			upsertProp(d, id, {
				...rest,
				name: name.trim(),
				kind: k,
				options: copy?.options ?? (kind === "select" ? [] : undefined),
				...(!copy && kind === "relation"
					? { inverseName: t("type.inverseOf", { name: name.trim() }) }
					: {}),
			});
			if (k === "status" || (copy && k !== copy.kind))
				upsertProp(d, id, kindPatch(rest, k, defaultStatusOptions(t)));
		});
		onAdded(id);
		setOpen(false);
		setName("");
	};
	return (
		<Popover
			align={align === "center" ? "left" : "right"}
			onOpenChange={setOpen}
			open={open}
			trigger={(p) => (
				// narrow: the plus alone, the label stays for screen readers
				<Button aria-label={t("type.addProp")} variant="outline" {...p}>
					<Plus size={14} />{" "}
					<span className={align === "right" ? "max-sm:hidden" : undefined}>
						{t("type.addProp")}
					</span>
				</Button>
			)}
		>
			<div className="w-72 space-y-2 p-2">
				<Input
					autoFocus
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && !twins.length && add()}
					placeholder={t("props.name")}
					value={name}
					variant="sm"
				/>
				{twins.length > 0 && (
					<div className="rounded-lg bg-surface-2 p-2 text-xs">
						<p className="mb-1 text-muted-foreground">{t("type.twins")}</p>
						{twins.map(({ type, prop }) => (
							<Button
								className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-hover"
								key={type.id + prop.id}
								onClick={() => add(prop)}
								variant="plain"
							>
								<TypeGlyph schema={type.schema} size={12} /> {type.schema.name} › {prop.name}{" "}
								<span className="ml-auto text-muted-foreground">{kindLabel(prop, t)}</span>
							</Button>
						))}
					</div>
				)}
				<NativeSelect
					aria-label={t("props.kind")}
					className="w-full rounded-md border border-line bg-bg px-1.5 py-1 text-sm"
					full
					onChange={(e) => setKind(e.target.value as PropKind)}
					value={kind}
				>
					{PROP_KINDS.filter((k) => k !== "status" || !hasStatus).map((k) => (
						<option key={k} value={k}>
							{t("kind.prop." + k)}
						</option>
					))}
				</NativeSelect>
				<Button className="w-full" disabled={!name.trim()} onClick={() => add()} variant="primary">
					{twins.length ? t("type.addNew") : t("props.add")}
				</Button>
			</div>
		</Popover>
	);
}

/** A select with several values says so. */
function kindLabel(p: PropDef, t: T): string {
	return t(p.kind === "select" && p.multiple ? "kind.prop.multiselect" : "kind.prop." + p.kind);
}

/** How many entries a relation can point to; without a target anything can be chosen. */
function relationTargets(prop: PropDef, ix: ReturnType<typeof useIndex>): number {
	if (prop.target) return runQuery(parseQuery(prop.target, ix).def, { ix }).total;
	return ix.live.filter((i) => i.kind === "note").length;
}

function DeleteTypeDialog({
	item,
	onClose,
	toTag,
}: {
	item: Item;
	onClose: () => void;
	toTag?: boolean;
}) {
	const repo = useRepo();
	const { t } = useT();
	const ix = useIndex();
	const schema = item.schema!;
	const usage = typeUsage(ix, item.id);
	const [mode, setMode] = useState<"tag" | "type" | "remove">("tag");
	const [tag, setTag] = useState(schema.name.toLowerCase().replace(/\s+/g, "-"));
	const others = [...ix.types.values()].filter((x) => x.id !== item.id);
	const [target, setTarget] = useState(others[0]?.id ?? "");
	const run = () => {
		const [how, label]: [DeleteMode, string] =
			mode === "tag"
				? [{ mode: "tag", tag }, t("op.typeToTag", { name: schema.name, tag })]
				: mode === "type"
					? [
							{ mode: "type", target },
							t("op.typeToType", { name: schema.name, target: ix.typeName(target) }),
						]
					: [{ mode: "remove" }, t("op.typeRemoved", { name: schema.name })];
		deleteType(repo.writer, ix, item.id, how, label, repo.origin);
		onClose();
		navigate("/");
	};
	return (
		<Dialog
			onClose={onClose}
			title={
				toTag
					? t("type.toTagTitle", { name: schema.name })
					: t("type.deleteTitle", { name: schema.name })
			}
		>
			<p className="text-sm">{t("type.affects", { count: usage.items.length })}</p>
			<ul className="mt-2 space-y-1 text-sm text-muted-foreground">
				{usage.queries.length > 0 && (
					<li>{t("type.usedInQueries", { list: usage.queries.map((q) => q.title).join(", ") })}</li>
				)}
				{usage.relations.length > 0 && (
					<li>
						{t("type.usedInRelations", { list: usage.relations.map((r) => r.name).join(", ") })}
					</li>
				)}
				{usage.progress.length > 0 && (
					<li>
						{t("type.usedInProgress", { list: usage.progress.map((r) => r.name).join(", ") })}
					</li>
				)}
			</ul>
			{!toTag && (
				<div className="mt-4">
					<Seg
						label={t("type.deleteMode")}
						onChange={setMode}
						options={[
							{ value: "tag", label: t("type.modeTag") },
							{ value: "type", label: t("type.modeType") },
							{ value: "remove", label: t("type.modeRemove") },
						]}
						value={mode}
					/>
				</div>
			)}
			{mode === "tag" && (
				<label className="mt-3 flex items-center gap-2 text-sm">
					{t("type.tagName")}{" "}
					<Input onChange={(e) => setTag(e.target.value)} value={tag} variant="sm" />
				</label>
			)}
			{mode === "type" && (
				<NativeSelect
					className="mt-3 rounded-md border border-line bg-bg px-2 py-1 text-sm"
					onChange={(e) => setTarget(e.target.value)}
					value={target}
				>
					{others.map((x) => (
						<option key={x.id} value={x.id}>
							{x.schema.name}
						</option>
					))}
				</NativeSelect>
			)}
			<p className="mt-3 text-xs text-muted-foreground">{t("type.valuesKept")}</p>
			{mode !== "type" && usage.inboxAfterRemove > 0 && (
				<p className="mt-1 text-xs text-warn">
					{t("type.toInbox", { count: usage.inboxAfterRemove })}
				</p>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<Button onClick={onClose} variant="outline">
					{t("cancel")}
				</Button>
				<Button
					disabled={(mode === "tag" && !tag.trim()) || (mode === "type" && !target)}
					onClick={run}
					variant="primary"
				>
					{toTag ? t("type.convert") : t("type.delete")}
				</Button>
			</div>
		</Dialog>
	);
}

function FromTagDialog({ item, onClose }: { item: Item; onClose: () => void }) {
	const repo = useRepo();
	const { t } = useT();
	const ix = useIndex();
	const schema = item.schema!;
	const [tag, setTag] = useState(schema.name.toLowerCase());
	const [replace, setReplace] = useState(false);
	const [removeTag, setRemoveTag] = useState(false);
	const preview = previewTagToType(ix, tag, item.id);
	const count = preview.untyped.length + (replace ? preview.typedOther.length : 0);
	return (
		<Dialog onClose={onClose} title={t("type.fromTagTitle")}>
			<label className="flex items-center gap-2 text-sm">
				# <Input onChange={(e) => setTag(e.target.value)} value={tag} variant="sm" />
			</label>
			<p className="mt-3 text-sm">
				{t("type.fromTagCount", {
					count: preview.untyped.length,
					name: schema.name,
					tag: tag.trim().replace(/^#/, ""),
				})}
			</p>
			{preview.untyped.length > 0 && (
				<details className="mt-1 text-sm">
					<summary className="tap-y cursor-pointer text-xs text-muted-foreground hover:text-fg">
						{t("type.fromTagShow")}
					</summary>
					<ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
						{preview.untyped.slice(0, 50).map((id) => (
							<li className="flex items-center gap-1" key={id}>
								<ItemIcon item={ix.get(id)!} size={11} /> {ix.get(id)!.title}
							</li>
						))}
						{preview.untyped.length > 50 && <li>…</li>}
					</ul>
				</details>
			)}
			{preview.typedOther.length > 0 && (
				<div className="mt-2 rounded-lg bg-surface-2 p-2.5 text-sm">
					<p>{t("type.fromTagConflict", { count: preview.typedOther.length })}</p>
					<ul className="mt-1 max-h-28 overflow-y-auto text-xs text-muted-foreground">
						{preview.typedOther.slice(0, 20).map((id) => (
							<li className="flex items-center gap-1" key={id}>
								<ItemIcon item={ix.get(id)!} size={11} /> {ix.get(id)!.title}
							</li>
						))}
					</ul>
					<Seg
						label={t("type.conflict")}
						onChange={(v) => setReplace(v === "replace")}
						options={[
							{ value: "skip", label: t("type.skip") },
							{ value: "replace", label: t("type.replaceType") },
						]}
						value={replace ? "replace" : "skip"}
					/>
				</div>
			)}
			<label className="mt-3 flex items-center gap-2 text-sm">
				<Checkbox
					checked={removeTag}
					onCheckedChange={(checked) => setRemoveTag(checked === true)}
				/>{" "}
				{t("type.removeTagAfter", { tag })}
			</label>
			<div className="mt-4 flex justify-end gap-2">
				<Button onClick={onClose} variant="outline">
					{t("cancel")}
				</Button>
				<Button
					disabled={!count && !(removeTag && preview.already.length)}
					onClick={() => {
						tagToType(
							repo.writer,
							ix,
							tag,
							item.id,
							{ replaceTypes: replace, removeTag },
							t("op.tagToType", { tag, name: schema.name }),
							repo.origin,
						);
						onClose();
					}}
					variant="primary"
				>
					{t("type.convertCount", { count })}
				</Button>
			</div>
		</Dialog>
	);
}

/** A type, a tag or any query; stored as query text, e.g. "type:Person" or "#author". */
function TargetField({
	target,
	hits,
	onChange,
}: {
	target?: string;
	hits: number;
	onChange: (t: string) => void;
}) {
	const repo = useRepo();
	const { t, lang } = useT();
	const ix = useIndex();
	const where = target ? parseQuery(target, ix).def.where : undefined;
	const typeId = where && "type" in where ? where.type : undefined;
	const tag = where && "tag" in where ? where.tag : undefined;
	const [mode, setMode] = useState<"type" | "tag" | "query">(
		typeId || !target ? "type" : tag ? "tag" : "query",
	);
	const [creating, setCreating] = useState(false);
	const types = ix.typesByName();
	const box = "w-full rounded-md border border-line bg-bg px-2 py-1 text-sm outline-none";
	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-2">
				<NativeSelect
					aria-label={t("type.target")}
					className={box}
					full
					onChange={(e) => {
						const value = e.target.value;
						if (value === "new") return setCreating(true);
						if (value === "tag" || value === "query") return setMode(value);
						setMode("type");
						onChange(value ? printQuery({ where: { type: value } }, lang, ix) : "");
					}}
					value={mode === "type" ? (typeId ?? "") : mode}
				>
					<option value="">{t("type.targetAny")}</option>
					{types.map((x) => (
						<option key={x.id} value={x.id}>
							{x.schema.name}
						</option>
					))}
					<option value="tag">{t("type.targetTag")}</option>
					<option value="query">{t("type.targetQuery")}</option>
					<option value="new">{t("type.targetNew")}</option>
				</NativeSelect>
				<span className="shrink-0 text-xs text-muted-foreground">
					{t("type.hits", { count: hits })}
				</span>
			</div>
			{mode === "tag" && (
				<Input
					defaultValue={tag ?? ""}
					onBlur={(e) =>
						e.target.value.trim() &&
						onChange("#" + e.target.value.trim().replace(/^#/, "").toLowerCase())
					}
					placeholder="#autor"
					variant="sm"
				/>
			)}
			{mode === "query" && (
				<Input
					className="font-mono"
					defaultValue={target ?? ""}
					onBlur={(e) => onChange(e.target.value.trim())}
					placeholder={t("type.targetPlaceholder")}
					variant="sm"
				/>
			)}
			{/* the target type does not exist yet: make it here, without leaving the editor */}
			{creating && (
				<NewTypeDialog
					onClose={() => setCreating(false)}
					onCreated={(id) => (
						setMode("type"), onChange(printQuery({ where: { type: id } }, lang, repo.index()))
					)}
					title={t("type.targetNewTitle")}
				/>
			)}
		</div>
	);
}
