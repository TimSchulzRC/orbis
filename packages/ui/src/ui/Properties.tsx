// Schema changes never delete values; values of removed properties show as "Weitere Eigenschaften".

import { dateOf } from "@obtion/core/date";
import { fmtDate } from "@obtion/core/i18n";
import { numberText, parseNumber } from "@obtion/core/input";
import {
	formatRange,
	type Item,
	optionNames,
	type PropDef,
	parseRange,
	STATUS_GROUPS,
	type TypeSchema,
	type Value,
} from "@obtion/core/model";
import { matches, parseQuery } from "@obtion/core/query";
import {
	defaultOption,
	doneAt,
	hasValue,
	isSingle,
	isStatusProp,
	optionIds,
	statusOf,
	visibleProps,
} from "@obtion/core/traits";
import { AlertTriangle, ExternalLink, Plus, X } from "lucide-react";
import { useState } from "react";
import { Checkbox } from "../components/ui/checkbox";
import { NativeSelect } from "../components/ui/native-select";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { repo } from "../repo";
import { FreeValueText } from "./FreeProps";
import { DateField, InlineText } from "./fields";
import { EmptyDash, ItemLink, StatusPill } from "./item-look";
import { ItemPicker } from "./Picker";
import {
	AddButton,
	Button,
	EmptyValueButton,
	IconButton,
	MenuItem,
	Popover,
	REVEAL,
} from "./primitives";
import { Progress, ProgressCount } from "./progress";
import { StatusMenu, setStatus } from "./Row";
import { PageTags } from "./Tags";

/** Longer text values get a multi-line field. */
const MULTILINE_FROM = 60;
const TARGET_SUGGESTIONS = 8;

function displayValue(item: Item, p: PropDef): string {
	const value = item.props[p.id];
	const ix = repo.index();
	if (item.rels[p.id]?.length)
		return item.rels[p.id]!.map((id) => ix.get(id)?.title ?? id).join(", ");
	if (value === undefined) return "";
	if (p.options) return optionNames(p, value).join(", ");
	return String(value);
}

export function PropertyField({
	item,
	prop,
	autoFocus,
}: {
	item: Item;
	prop: PropDef;
	autoFocus?: boolean;
}) {
	const { t, lang } = useT();
	const ix = useIndex();
	const value = item.props[prop.id];
	const setValue = (x: Value | null) => repo.setProp(item.id, prop.id, x);
	switch (prop.kind) {
		case "text":
			return (
				<InlineText
					autoFocus={autoFocus}
					className="text-sm leading-relaxed"
					label={prop.name}
					multiline={String(value ?? "").length > MULTILINE_FROM}
					onCommit={(x) => setValue(x.trim() || null)}
					placeholder={t("props.empty")}
					value={String(value ?? "")}
				/>
			);
		case "url":
			return (
				<span className="flex w-full items-center gap-1">
					<InlineText
						autoFocus={autoFocus}
						className="text-sm"
						label={prop.name}
						onCommit={(x) => setValue(x.trim() || null)}
						placeholder={t("props.empty")}
						value={String(value ?? "")}
					/>
					{typeof value === "string" && /^https?:\/\//.test(value) && (
						<a
							aria-label={t("props.openLink")}
							className="text-muted-foreground hover:text-fg"
							href={value}
							rel="noopener"
							target="_blank"
						>
							<ExternalLink size={13} />
						</a>
					)}
				</span>
			);
		case "number":
			return (
				<InlineText
					autoFocus={autoFocus}
					className="text-sm tabular-nums"
					label={prop.name}
					onCommit={(x) => setValue(parseNumber(lang, x) ?? null)}
					placeholder={t("props.empty")}
					value={typeof value === "number" ? numberText(lang, value) : ""}
				/>
			);
		case "date": {
			const text = typeof value === "string" ? value : "";
			if (!prop.range)
				return (
					<DateField
						autoFocus={autoFocus}
						label={prop.name}
						onChange={(x) => setValue(x || null)}
						value={text || undefined}
					/>
				);
			return (
				<RangeField
					autoFocus={autoFocus}
					name={prop.name}
					onChange={(x) => setValue(x || null)}
					value={text}
				/>
			);
		}
		case "checkbox":
			return (
				<Checkbox
					aria-label={prop.name}
					checked={value === true}
					className="size-4"
					onCheckedChange={(checked) => setValue(checked === true ? true : null)}
				/>
			);
		case "status":
		case "select": {
			if (prop.multiple) return <MultiField item={item} prop={prop} />;
			const schema = ix.schemaOf(item);
			if (!isStatusProp(schema, prop)) {
				// the same menu as its badge at the top
				const opt = prop.options?.find((o) => o.id === value);
				return (
					<SelectMenu
						item={item}
						prop={prop}
						trigger={(p) =>
							opt ? (
								<Button
									variant="plain"
									{...p}
									aria-label={t("props.set", { name: prop.name })}
									className="tap-y inline-flex"
								>
									<StatusPill option={opt} />
								</Button>
							) : (
								<EmptyValueButton {...p} aria-label={t("props.set", { name: prop.name })} />
							)
						}
					/>
				);
			}
			const done = doneAt(item, schema);
			return (
				<>
					<OptionSelect className="inline-flex" item={item} prop={prop} />
					{done && (
						<span className="text-xs tabular-nums text-muted-foreground">
							{t("props.doneOn", { date: fmtDate(lang, dateOf(done)) })}
						</span>
					)}
				</>
			);
		}
		case "relation":
			return <RelationField autoOpen={autoFocus} item={item} prop={prop} />;
		case "computed": {
			const computed = prop.computed;
			if (computed?.fn === "count")
				return (
					<span className="tabular-nums text-muted-foreground">
						{ix.countDescendants(item.id, computed.of)}
					</span>
				);
			const progress = ix.progress(item.id, computed?.of);
			return progress.total ? (
				<span className="flex w-full max-w-64 items-center gap-2">
					<Progress className="flex-1" done={progress.done} total={progress.total} />
					<ProgressCount
						className="text-xs text-muted-foreground"
						done={progress.done}
						total={progress.total}
					/>
				</span>
			) : (
				<EmptyDash />
			);
		}
	}
	return null;
}

function MultiField({ item, prop }: { item: Item; prop: PropDef }) {
	const { t } = useT();
	const ids = optionIds(item.props[prop.id]);
	const set = (x: string[]) => repo.setProp(item.id, prop.id, x.length ? x : null);
	return (
		<>
			{ids.map((id) => {
				const option = prop.options?.find((x) => x.id === id);
				return (
					<span className="inline-flex items-center gap-0.5" key={id}>
						{option ? <StatusPill option={option} small /> : id}
						<Button
							aria-label={t("props.removeValue")}
							className="text-muted-foreground hover:text-fg"
							onClick={() => set(ids.filter((x) => x !== id))}
							variant="plain"
						>
							<X size={11} />
						</Button>
					</span>
				);
			})}
			<Popover
				trigger={(p) =>
					ids.length ? (
						<Button
							variant="plain"
							{...p}
							aria-label={t("props.set", { name: prop.name })}
							className="tap rounded-md px-1 text-xs text-muted-foreground hover:bg-hover"
						>
							<Plus size={12} />
						</Button>
					) : (
						<Button
							variant="plain"
							{...p}
							aria-label={t("props.set", { name: prop.name })}
							className="tap-y -ml-1 rounded px-1 text-faint hover:bg-hover hover:text-muted-foreground"
						>
							{t("props.empty")}
						</Button>
					)
				}
			>
				{(close) =>
					prop.options
						?.filter((o) => !ids.includes(o.id))
						.map((o) => (
							<MenuItem
								key={o.id}
								onClick={() => {
									close();
									set([...ids, o.id]);
								}}
							>
								{o.name}
							</MenuItem>
						))
				}
			</Popover>
		</>
	);
}

/** An invisible native select lies over the chip, so a click picks right there. */
export function OptionSelect({
	item,
	prop,
	className,
}: {
	item: Item;
	prop: PropDef;
	className?: string;
}) {
	const { t } = useT();
	const schema = useIndex().schemaOf(item);
	const isStatus = isStatusProp(schema, prop);
	// the status shows its default when no value is stored yet
	const value = isStatus ? statusOf(item, schema)?.option.id : item.props[prop.id];
	const opt = prop.options?.find((o) => o.id === value);
	// a select with a default is never empty
	const required = !!defaultOption(prop);
	return (
		// no label needed: the select lies over the whole chip and has its own aria-label
		<span className={cn("tap-row relative cursor-pointer items-center", className)}>
			{opt ? (
				<StatusPill group={isStatus ? (opt.group ?? "todo") : undefined} option={opt} />
			) : (
				<span className="text-muted-foreground">{t("props.empty")}</span>
			)}
			<NativeSelect
				aria-label={prop.name}
				onChange={(e) =>
					isStatus && e.target.value
						? void setStatus(item, e.target.value)
						: repo.setProp(item.id, prop.id, e.target.value || null)
				}
				overlay
				value={String(value ?? "")}
			>
				{(!required || !opt) && <option value="">–</option>}
				{isStatus
					? STATUS_GROUPS.map((g) => (
							<optgroup key={g} label={t(`group.${g}`)}>
								{prop
									.options!.filter((o) => (o.group ?? "todo") === g)
									.map((o) => (
										<option key={o.id} value={o.id}>
											{o.name}
										</option>
									))}
							</optgroup>
						))
					: prop.options?.map((o) => (
							<option key={o.id} value={o.id}>
								{o.name}
							</option>
						))}
			</NativeSelect>
		</span>
	);
}

export function RangeEditor({
	value,
	onChange,
	autoFocus,
	className,
}: {
	value: string;
	onChange: (v: string) => void;
	autoFocus?: boolean;
	className?: string;
}) {
	const { t } = useT();
	const { start, end } = parseRange(value);
	// an empty end shows the date format, not a "–" beside the range's own dash
	const empty = t("date.placeholder");
	return (
		<span className={cn("flex flex-wrap items-center gap-1", className)}>
			<DateField
				autoFocus={autoFocus}
				label={t("props.start")}
				onChange={(x) => onChange(formatRange(x, end))}
				placeholder={empty}
				value={start || undefined}
			/>
			<EmptyDash />
			<DateField
				label={t("props.end")}
				onChange={(x) => onChange(formatRange(start, x))}
				placeholder={empty}
				value={end || undefined}
			/>
		</span>
	);
}

function RangeField({
	value,
	name,
	autoFocus,
	onChange,
}: {
	value: string;
	name: string;
	autoFocus?: boolean;
	onChange: (v: string) => void;
}) {
	const { t, lang } = useT();
	const [open, setOpen] = useState(!!autoFocus);
	if (!value && !open)
		return (
			<EmptyValueButton
				aria-label={t("props.set", { name })}
				onClick={() => setOpen(true)}
				type="button"
			/>
		);
	if (!open) {
		const { start, end } = parseRange(value);
		const long = (d: string) =>
			d ? fmtDate(lang, d, { day: "numeric", month: "long", year: "numeric" }) : "…";
		return (
			<Button
				aria-label={t("props.set", { name })}
				className="tap-y -ml-1 rounded px-1 text-left tabular-nums hover:bg-hover"
				onClick={() => setOpen(true)}
				type="button"
				variant="plain"
			>
				{long(start)} – {long(end)}
			</Button>
		);
	}
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: only notices the focus leaving its two date fields, which take the keys
		<span
			className="contents"
			// left without a date: back to the "–" instead of two empty fields. The fields' text, not
			// `value`: a date typed just now is committed in this same blur
			onBlur={(e) => {
				const box = e.currentTarget;
				const typed = [...box.querySelectorAll("input")].some((x) => x.value);
				if (!typed && !box.contains(e.relatedTarget)) setOpen(false);
			}}
		>
			<RangeEditor autoFocus onChange={onChange} value={value} />
		</span>
	);
}

function RelationField({
	item,
	prop,
	autoOpen,
}: {
	item: Item;
	prop: PropDef;
	autoOpen?: boolean;
}) {
	const { t } = useT();
	const ix = useIndex();
	const [picking, setPicking] = useState(!!autoOpen);
	const ids = ix.relValues(item, prop.id, prop.symmetric);
	const target = prop.target ? parseQuery(prop.target, ix).def.where : undefined;
	const fits = (x: Item) => !target || matches(x, target, { ix, thisId: item.id });
	const own = item.rels[prop.id] ?? [];
	const remove = (id: string) => {
		if (own.includes(id)) repo.setRel(item.id, prop.id, id, false);
		else repo.setRel(id, prop.id, item.id, false); // a symmetric relation may be stored on the other side
	};
	return (
		<>
			{ids.map((id) => {
				const related = ix.get(id)!;
				return (
					<span
						className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 py-0.5 pl-1.5 pr-0.5 text-xs"
						key={id}
					>
						<ItemLink className="min-w-0" item={related} />
						{!fits(related) && (
							<span className="text-warn" title={t("props.notTarget", { target: prop.target })}>
								<AlertTriangle size={11} />
							</span>
						)}
						<Button
							aria-label={t("props.removeValue")}
							className="rounded px-1 text-muted-foreground hover:bg-hover hover:text-fg"
							onClick={() => remove(id)}
							variant="plain"
						>
							<X size={11} />
						</Button>
					</span>
				);
			})}
			{!ids.length ? (
				<EmptyValueButton
					aria-label={t("props.set", { name: prop.name })}
					onClick={() => setPicking(true)}
					type="button"
				/>
			) : (
				prop.multiple && (
					<AddButton
						aria-label={t("props.set", { name: prop.name })}
						onClick={() => setPicking(true)}
					/>
				)
			)}
			{picking && (
				<ItemPicker
					exclude={(x) => x.id === item.id || ids.includes(x.id)}
					onClose={() => setPicking(false)}
					onCreate={(title) => {
						const id = repo.create({
							title,
							type: target && "type" in target ? target.type : null,
						});
						repo.setRel(item.id, prop.id, id, true);
						setPicking(false);
					}}
					onPick={(id) => {
						if (!prop.multiple) for (const old of own) repo.setRel(item.id, prop.id, old, false);
						repo.setRel(item.id, prop.id, id, true);
						setPicking(false);
					}}
					suggestions={ix.live
						.filter((x) => target && x.id !== item.id && fits(x) && !ids.includes(x.id))
						.slice(0, TARGET_SUGGESTIONS)
						.map((x) => ({ id: x.id, reason: "target" as const }))}
					title={prop.name}
				/>
			)}
		</>
	);
}

/**
 * A click on the empty space of an empty field starts the input, as if it hit the "–": it focuses
 * the text field or presses the button that opens the menu, editor or picker.
 */
function startInput(e: React.MouseEvent<HTMLDivElement>) {
	if (e.target !== e.currentTarget) return;
	const control = e.currentTarget.querySelector<HTMLElement>(
		"input:not([tabindex='-1']), textarea, button",
	);
	if (control instanceof HTMLButtonElement) control.click();
	else control?.focus();
}

/** `empty`: the whole value cell starts the input (startInput). */
function BlockRow({
	label,
	title,
	empty,
	children,
}: {
	label: React.ReactNode;
	title?: string;
	empty?: boolean;
	children: React.ReactNode;
}) {
	return (
		<>
			<div
				className="flex min-h-[34px] items-center truncate rounded-md px-1.5 text-sm text-muted-foreground pointer-coarse:min-h-11"
				title={title ?? (typeof label === "string" ? label : undefined)}
			>
				<span className="truncate">{label}</span>
			</div>
			{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a larger target for the mouse; the field's own control takes the keyboard */}
			<div
				className={cn(
					"group flex min-h-[34px] min-w-0 flex-wrap items-center gap-1.5 rounded-md px-1.5 text-sm hover:bg-hover/60 pointer-coarse:min-h-11",
					empty && "cursor-pointer",
				)}
				onClick={empty ? startInput : undefined}
			>
				{children}
			</div>
		</>
	);
}

/**
 * `first` goes before the badges, `afterTags` right after the tags, `end` at the right edge, `links`
 * in a row of its own below them (a divider follows), `progress` above the rows. `noEndLine`: what
 * follows sets itself apart (the update card), so the block ends without a line.
 */
interface PageHead {
	first?: React.ReactNode;
	afterTags?: React.ReactNode;
	end?: React.ReactNode;
	links?: React.ReactNode;
	progress?: React.ReactNode;
	noEndLine?: boolean;
}

/**
 * Status and single selections read as badges by themselves at the top, so they need no label.
 * "Edit type" orders them apart from the rest.
 */
export const isBadge = (p: PropDef) => isSingle(p);

/**
 * A page adds no property its type lacks. Those with a value show: the badges in a row at the top,
 * everything else below as rows with its name, each in the type's order. The empty ones wait at
 * the very bottom behind "n more properties", again in the type's order, as rows to fill in.
 * Tags are no property and follow the badges (see PageTags).
 */
export function PropertyBlock({
	item,
	schema,
	head = {},
}: {
	item: Item;
	schema?: TypeSchema;
	head?: PageHead;
}) {
	const { t } = useT();
	const ix = useIndex();
	const visible = schema
		? visibleProps(item, schema, ix).filter(
				(p) => !(p.kind === "computed" && p.computed?.fn !== "count"),
			)
		: [];
	// a select with a default always shows one, stored or not
	const used = (p: PropDef) => hasValue(item, p, ix) || !!defaultOption(p);
	const badges = visible.filter((p) => isBadge(p) && used(p));
	const shown = visible.filter((p) => !isBadge(p) && used(p));
	const unused = visible.filter((p) => !used(p));
	// open for this page only: the next page starts closed again
	const [openFor, setOpenFor] = useState<string>();
	const open = openFor === item.id;
	const leftovers = schema
		? schema.removedProperties.filter(
				(p) => item.props[p.id] !== undefined || item.rels[p.id]?.length,
			)
		: [];
	const free = Object.entries(item.extra);
	const rows = shown.length || free.length || leftovers.length || unused.length;
	return (
		<div className="group/props">
			<div className="mt-3 flex flex-wrap items-center gap-1.5">
				{head.first}
				{badges.map((p) => (
					<span className="inline-flex" key={p.id}>
						{isStatusProp(schema, p) ? (
							<StatusBadge item={item} />
						) : (
							<SelectBadge item={item} prop={p} />
						)}
					</span>
				))}
				<PageTags item={item} />
				{head.afterTags}
				{head.end && <span className="ml-auto inline-flex items-center gap-0.5">{head.end}</span>}
			</div>
			{head.links}
			<div className="mt-3 border-t border-line" />
			{head.progress}
			{rows > 0 && (
				<div className="-mx-1.5 mt-4 grid grid-cols-[160px_minmax(0,1fr)] gap-x-1 max-md:grid-cols-[124px_minmax(0,1fr)]">
					{/* one keyed list: a row filled in below the toggle moves up with its state (an open date range) */}
					{[
						...shown.map((p) => (
							<BlockRow key={p.id} label={p.name} title={p.description || p.name}>
								<PropertyField item={item} prop={p} />
							</BlockRow>
						)),
						...free.map(([n, v]) => (
							<BlockRow key={`free:${n}`} label={n}>
								<FreeValueText value={v} />
								<IconButton
									className={cn("ml-auto text-faint", REVEAL.any)}
									icon={X}
									iconSize={12}
									label={t("props.removeFree", { name: n })}
									onClick={() => repo.setExtra(item.id, n, null)}
									size="xs"
								/>
							</BlockRow>
						)),
						...leftovers.map((p) => (
							<BlockRow key={`old:${p.id}`} label={p.name} title={t("props.more")}>
								<span className="text-muted-foreground">{displayValue(item, p)}</span>
								<IconButton
									className={cn("ml-auto text-faint", REVEAL.any)}
									icon={X}
									iconSize={12}
									label={t("props.removeFree", { name: p.name })}
									onClick={() => repo.setProp(item.id, p.id, null)}
									size="xs"
								/>
							</BlockRow>
						)),
						...(open ? unused : []).map((p) => (
							<BlockRow empty key={p.id} label={p.name} title={p.description || p.name}>
								<PropertyField item={item} prop={p} />
							</BlockRow>
						)),
						unused.length > 0 && (
							// a quiet link below all rows: "Mehr" opens the empty ones above it, "Weniger" closes them
							<Button
								aria-expanded={open}
								className="col-span-2 flex min-h-[34px] items-center justify-self-start rounded-md px-1.5 text-left text-sm text-faint underline-offset-2 hover:text-muted-foreground hover:underline pointer-coarse:min-h-11"
								key="unused"
								onClick={() => setOpenFor(open ? undefined : item.id)}
								type="button"
								variant="plain"
							>
								{t(open ? "props.showLess" : "props.showMore")}
							</Button>
						),
					]}
				</div>
			)}
			{!head.noEndLine && (!!head.progress || rows > 0) && (
				<div className="mt-4 border-t border-line" />
			)}
		</div>
	);
}

function StatusBadge({ item }: { item: Item }) {
	const { t } = useT();
	const ix = useIndex();
	const status = statusOf(item, ix.schemaOf(item));
	if (!status) return null;
	return (
		<StatusMenu
			item={item}
			trigger={(p) => (
				<Button
					variant="plain"
					{...p}
					aria-label={t("row.status", { name: status.option.name })}
					className="tap-y inline-flex"
				>
					<StatusPill group={status.group} option={status.option} />
				</Button>
			)}
		/>
	);
}

/** Shows the property's name before the value ("Stage Draft"). */
function SelectBadge({ item, prop }: { item: Item; prop: PropDef }) {
	const { t } = useT();
	const opt = prop.options?.find((o) => o.id === item.props[prop.id]);
	const label = !opt ? null : (
		<>
			<span className="opacity-70">{prop.name}</span> {opt.name}
		</>
	);
	return (
		<SelectMenu
			item={item}
			prop={prop}
			trigger={(p) => (
				<Button
					variant="plain"
					{...p}
					aria-label={t("props.set", { name: prop.name })}
					className="tap-y inline-flex"
					title={prop.description || prop.name}
				>
					{opt ? (
						<StatusPill label={label} option={opt} />
					) : (
						<span className="inline-flex items-center gap-1 rounded-full border border-dashed border-line px-2 py-0.5 text-xs text-muted-foreground hover:text-fg">
							<Plus size={11} /> {prop.name}
						</span>
					)}
				</Button>
			)}
		/>
	);
}

/** A single select's options as a menu, with "Remove value" when it may be empty. */
function SelectMenu({
	item,
	prop,
	trigger,
}: {
	item: Item;
	prop: PropDef;
	trigger: React.ComponentProps<typeof Popover>["trigger"];
}) {
	const { t } = useT();
	const value = item.props[prop.id];
	const opt = prop.options?.find((o) => o.id === value);
	// a select with a default is never empty
	const required = !!defaultOption(prop);
	return (
		<Popover trigger={trigger}>
			{(close) => (
				<>
					<p className="px-2.5 pb-1 pt-1.5 text-xs text-muted-foreground">{prop.name}</p>
					{prop.options?.map((o) => (
						<MenuItem
							active={o.id === value}
							key={o.id}
							onClick={() => {
								close();
								repo.setProp(item.id, prop.id, o.id);
							}}
						>
							<StatusPill option={o} />
						</MenuItem>
					))}
					{opt && !required && (
						<>
							<div className="my-1 border-t border-line" />
							<MenuItem
								icon={<X size={13} />}
								onClick={() => {
									close();
									repo.setProp(item.id, prop.id, null);
								}}
							>
								{t("props.removeValue")}
							</MenuItem>
						</>
					)}
				</>
			)}
		</Popover>
	);
}
