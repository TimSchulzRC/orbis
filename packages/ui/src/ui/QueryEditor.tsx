// One query, two ways in: a pill per condition, and the same query as text (folded by default).
// A condition on a property reads "Status: Open, Paused" and opens its own small editor: how it
// compares and with what. The text form parses every language and is shown in the UI language.
// Storage is JSON.

import type { Index } from "@obtion/core/graph";
import { fmtDate, type Lang, type T } from "@obtion/core/i18n";
import { titleKey } from "@obtion/core/model";
import {
	type Cond,
	type FieldValue,
	type Op,
	parseQuery,
	printQuery,
	type QueryDef,
	type StatusKey,
} from "@obtion/core/query";
import { Check, ChevronDown, ChevronLeft, HelpCircle, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Input } from "../components/ui/input";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { fieldLabel } from "./groups";
import { pal, TypeGlyph } from "./item-look";
import { ItemPicker } from "./Picker";
import { Button, IconButton, MenuItem, Popover } from "./primitives";
import { FieldIcon, useViewFields, type ViewField } from "./view-fields";

type Step = "root" | "type" | "status" | "tag";
type Ctx = { ix: Index; t: T; lang: Lang; fields: ViewField[] };

/** How a condition on a field compares: the query's operators, and "has a value". */
type Mode = Op | "filled";
/** A condition on one field, as its pill shows it: several values mean "one of them". */
interface FieldCond {
	prop: string;
	mode: Mode;
	values: FieldValue[];
}
/** What a field holds decides how it can be compared and how its value is chosen. */
type Shape = "options" | "date" | "number" | "check" | "ref" | "text";

const MODES: Record<Shape, Mode[]> = {
	options: [":", "!=", "empty", "filled"],
	text: [":", "!=", "empty", "filled"],
	ref: [":", "!=", "empty", "filled"],
	number: [":", "!=", "<", ">", "<=", ">=", "empty", "filled"],
	date: [":", "<", ">", "<=", ">=", "empty", "filled"],
	check: [":", "!="],
};
const SIGN: Partial<Record<Mode, string>> = {
	":": "=",
	"!=": "≠",
	"<": "<",
	">": ">",
	"<=": "≤",
	">=": "≥",
};
/** Dates that move with today, as the query stores them. */
const DAYS = [
	["+0d", "today"],
	["+1d", "tomorrow"],
	["+7d", "in7"],
	["-7d", "ago7"],
	["+30d", "in30"],
] as const;
const BUILTIN_DATES = ["due", "done", "created", "updated"];
const BUILTIN_NUMBERS = ["progress", "subtasks"];

function shapeOf(f: ViewField): Shape {
	if ((f.kind === "select" || f.kind === "status") && f.prop?.options?.length) return "options";
	if (f.kind === "date" || f.kind === "builtin-date") return "date";
	if (f.kind === "number" || f.kind === "computed") return "number";
	if (f.kind === "checkbox") return "check";
	if (f.kind === "relation" || f.kind === "item") return "ref";
	return "text";
}

/** The field a condition names: one of the view's, or a built-in one ("due", "title"). */
function fieldFor(prop: string, { fields, t }: Ctx): ViewField {
	const known = fields.find((f) => titleKey(f.key) === titleKey(prop));
	if (known) return known;
	const kind = BUILTIN_DATES.includes(prop)
		? "builtin-date"
		: BUILTIN_NUMBERS.includes(prop)
			? "number"
			: "text";
	return { key: prop, label: fieldLabel(prop, t, fields), kind };
}

function modeLabel(shape: Shape, mode: Mode, t: T): string {
	if (mode === "empty") return t("filter.empty");
	if (mode === "filled") return t("filter.filled");
	if (shape === "check") return t(mode === ":" ? "filter.checked" : "filter.unchecked");
	if (shape === "number") return SIGN[mode]!;
	if (shape === "date")
		return t(
			{ ":": "filter.is", "<": "filter.before", ">": "filter.after", "<=": "filter.until" }[
				mode as string
			] ?? "filter.from",
		);
	if (shape === "options") return t(mode === ":" ? "filter.is" : "filter.isNot");
	return t(mode === ":" ? "filter.contains" : "filter.containsNot");
}

const TRUE_WORDS = ["ja", "yes", "true", "1", "wahr", "x"];
/** A checkbox is checked or not: "is false" and "is not true" both read as "is not checked". */
function checkCond(c: FieldCond): FieldCond {
	if (c.mode !== ":" && c.mode !== "!=") return c; // "is empty", as typed in the text form
	const word = typeof c.values[0] === "string" ? c.values[0].toLowerCase() : "true";
	const checked = (c.mode === ":") === TRUE_WORDS.includes(word);
	return { prop: c.prop, mode: checked ? ":" : "!=", values: ["true"] };
}

/** The condition as "field, comparison, values" – where it is one on a single field. */
function readField(c: Cond): FieldCond | undefined {
	if ("prop" in c)
		return {
			prop: c.prop,
			mode: c.op,
			values: c.value === undefined || c.value === "" ? [] : [c.value],
		};
	if ("or" in c) {
		const parts = c.or.map(readField);
		const first = parts[0];
		const same = parts.filter((p) => p?.mode === ":" && p.prop === first?.prop) as FieldCond[];
		if (!first || same.length !== parts.length) return;
		return { prop: first.prop, mode: ":", values: same.flatMap((p) => p.values) };
	}
	if ("not" in c) {
		const inner = readField(c.not);
		if (inner?.mode === ":") return { ...inner, mode: "!=" };
		if (inner?.mode === "empty") return { ...inner, mode: "filled" };
	}
	return;
}

function writeField({ prop, mode, values }: FieldCond): Cond {
	const one = (value: FieldValue | undefined): Cond => ({ prop, op: ":", value });
	if (mode === "empty") return { prop, op: "empty" };
	if (mode === "filled") return { not: { prop, op: "empty" } };
	if (values.length > 1) {
		const any: Cond = { or: values.map(one) };
		return mode === "!=" ? { not: any } : any;
	}
	return { prop, op: mode, value: values[0] };
}

function valueText(v: FieldValue, shape: Shape, { ix, t, lang }: Ctx): string {
	if (typeof v === "object")
		return "this" in v.ref ? t("filter.thisPage") : (ix.get(v.ref.id)?.title ?? "?");
	if (shape === "date") {
		const day = DAYS.find(([token]) => token === v);
		if (day) return t(`filter.date.${day[1]}`);
		return /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(lang, v) : v;
	}
	return v;
}

/** How a condition that is no field comparison reads on its pill. */
function condLabel(c: Cond, ctx: Ctx): string {
	const { ix, t, lang } = ctx;
	if ("not" in c) return `${t("query.not")} ${condLabel(c.not, ctx)}`;
	if ("type" in c) return `${t("group.type")}: ${ix.typeName(c.type) ?? c.type}`;
	if ("tag" in c) return `#${c.tag}`;
	if ("under" in c)
		return "this" in c.under
			? t("query.cond.underThis")
			: `${t("filter.under")}: ${ix.get(c.under.id)?.title ?? "?"}`;
	if ("status" in c && c.status !== "new")
		return `${t("group.status")}: ${t(`query.status.${c.status}`)}`;
	return printQuery({ where: c }, lang, ix);
}

/** No condition, the only one, or several joined by `join` ("and", "or"). */
function combine(conds: Cond[], join: (list: Cond[]) => Cond): Cond | undefined {
	return conds.length <= 1 ? conds[0] : join(conds);
}

const PILL =
	"inline-flex h-7 max-w-80 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-surface px-2.5 text-[13px] text-muted-foreground hover:bg-hover aria-expanded:border-focus";

/** The first step of a new filter: a field of the view, or one of the conditions every list knows. */
function CondPicker({
	pick,
	onUnder,
	context,
	fields,
}: {
	pick: (c: Cond) => void;
	onUnder: () => void;
	context?: boolean;
	fields: ViewField[];
}) {
	const ix = useIndex();
	const { t } = useT();
	const [step, setStep] = useState<Step>("root");
	const [search, setSearch] = useState("");
	const [tag, setTag] = useState("");
	const types = ix.typesByName();
	const back = (
		<Button
			className="mb-1 flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-fg"
			onClick={() => setStep("root")}
			variant="plain"
		>
			<ChevronLeft size={12} /> {t("query.back")}
		</Button>
	);
	if (step === "type")
		return (
			<>
				{back}
				{types.map((x) => (
					<MenuItem
						icon={<TypeGlyph schema={x.schema} size={14} />}
						key={x.id}
						onClick={() => pick({ type: x.id })}
					>
						{x.schema.name}
					</MenuItem>
				))}
			</>
		);
	if (step === "status")
		return (
			<>
				{back}
				{(["open", "active", "done"] as const).map((s) => (
					<MenuItem key={s} onClick={() => pick({ status: s })}>
						{t(`query.status.${s}`)}
					</MenuItem>
				))}
			</>
		);
	if (step === "tag")
		return (
			<div className="p-1">
				{back}
				<Input
					autoFocus
					className="w-48"
					onChange={(e) => setTag(e.target.value.replace(/^#/, ""))}
					onKeyDown={(e) => {
						if (e.key !== "Enter" || !tag.trim()) return;
						pick({ tag: tag.trim().toLowerCase() });
						setTag("");
					}}
					placeholder={t("query.tagName")}
					value={tag}
					variant="sm"
				/>
			</div>
		);
	const has = (label: string) => label.toLowerCase().includes(search.trim().toLowerCase());
	const due: ViewField = { key: "due", label: t("field.due"), kind: "builtin-date" };
	const title: ViewField = { key: "title", label: t("field.title"), kind: "text" };
	const named = (f: ViewField) => fields.some((x) => titleKey(x.label) === titleKey(f.label));
	// tags have their own condition below; a field's first comparison is the start
	const offered = [
		...fields.filter((f) => f.kind !== "tags"),
		...[title, due].filter((f) => !named(f)),
	].filter((f) => has(f.label));
	const others: { label: string; run: () => void }[] = [
		...(types.length ? [{ label: t("query.cond.type"), run: () => setStep("type") }] : []),
		...(context
			? [{ label: t("query.cond.underThis"), run: () => pick({ under: { this: true } }) }]
			: []),
		{ label: t("query.cond.under"), run: onUnder },
		{ label: t("query.cond.status"), run: () => setStep("status") },
		{ label: t("query.cond.tag"), run: () => setStep("tag") },
		{ label: t("query.cond.inbox"), run: () => pick({ inbox: true }) },
		{ label: t("query.cond.file"), run: () => pick({ file: true }) },
	].filter((o) => has(o.label));
	return (
		<div className="w-60">
			<Input
				aria-label={t("filter.search")}
				autoFocus
				className="mb-1 w-full"
				onChange={(e) => setSearch(e.target.value)}
				placeholder={t("filter.search")}
				value={search}
				variant="sm"
			/>
			{offered.map((f) => (
				<MenuItem
					icon={<FieldIcon kind={f.kind} />}
					key={f.key}
					onClick={() => {
						const shape = shapeOf(f);
						pick(
							writeField({
								prop: f.key,
								mode: MODES[shape][0]!,
								values: shape === "check" ? ["true"] : [],
							}),
						);
					}}
				>
					{f.label}
				</MenuItem>
			))}
			{offered.length > 0 && others.length > 0 && <div className="my-1 border-t border-line" />}
			{others.map((o) => (
				<MenuItem key={o.label} onClick={o.run}>
					{o.label}
				</MenuItem>
			))}
		</div>
	);
}

/** A condition on one field: the pill says it in words, its popover changes comparison and value. */
function FieldPill({
	cond: stored,
	ctx,
	off,
	startOpen,
	onChange,
	onRemove,
	onToggle,
	onPickPage,
}: {
	cond: FieldCond;
	ctx: Ctx;
	off?: boolean;
	startOpen?: boolean;
	onChange: (c: Cond) => void;
	onRemove: () => void;
	onToggle?: () => void;
	onPickPage: (then: (id: string) => void) => void;
}) {
	const { t } = ctx;
	const field = fieldFor(stored.prop, ctx);
	const shape = shapeOf(field);
	const cond = shape === "check" ? checkCond(stored) : stored;
	const [open, setOpen] = useState(!!startOpen);
	const [modes, setModes] = useState(false);
	const set = (patch: Partial<FieldCond>) => onChange(writeField({ ...cond, ...patch }));
	const needsValue = cond.mode !== "empty" && cond.mode !== "filled" && shape !== "check";
	const shown = cond.values.map((v) => valueText(v, shape, ctx)).join(", ");
	const text = (v: FieldValue | undefined) => (typeof v === "string" ? v : "");
	const options = field.prop?.options ?? [];
	const chosen = (name: string, id: string) =>
		cond.values.some((v) => typeof v === "string" && (titleKey(v) === titleKey(name) || v === id));
	const editor = () => {
		if (!needsValue) return null;
		if (shape === "options")
			return options.map((o) => {
				const on = chosen(o.name, o.id);
				return (
					<Button
						aria-pressed={on}
						className="tap-row flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-hover"
						key={o.id}
						onClick={() =>
							set({
								values: on
									? cond.values.filter(
											(v) =>
												typeof v !== "string" || (titleKey(v) !== titleKey(o.name) && v !== o.id),
										)
									: [...cond.values, o.name],
							})
						}
						variant="plain"
					>
						<span
							className={cn(
								"flex size-4 shrink-0 items-center justify-center rounded border",
								on ? "border-fg bg-fg text-bg" : "border-line",
							)}
						>
							{on && <Check size={12} />}
						</span>
						<span className="size-2 shrink-0 rounded-full" style={{ background: pal(o.color) }} />
						<span className="min-w-0 flex-1 truncate">{o.name}</span>
					</Button>
				);
			});
		if (shape === "ref") {
			const ref = cond.values[0];
			return (
				<Button
					className="tap-row flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-hover"
					onClick={() => {
						setOpen(false);
						onPickPage((id) => set({ values: [{ ref: { id } }] }));
					}}
					variant="plain"
				>
					<span className={cn("min-w-0 flex-1 truncate", !ref && "text-muted-foreground")}>
						{ref ? valueText(ref, shape, ctx) : t("filter.pickPage")}
					</span>
					<ChevronDown className="shrink-0 text-muted-foreground" size={13} />
				</Button>
			);
		}
		if (shape === "date")
			return (
				<>
					{DAYS.map(([token, name]) => (
						<MenuItem
							active={cond.values[0] === token}
							key={token}
							onClick={() => set({ values: [token] })}
						>
							{t(`filter.date.${name}`)}
						</MenuItem>
					))}
					<Input
						aria-label={t("filter.date.pick")}
						className="mt-1 w-full"
						onChange={(e) => set({ values: e.target.value ? [e.target.value] : [] })}
						type="date"
						value={/^\d{4}-\d{2}-\d{2}$/.test(text(cond.values[0])) ? text(cond.values[0]) : ""}
						variant="sm"
					/>
				</>
			);
		return (
			<Input
				aria-label={t("filter.value")}
				autoFocus
				className="w-full"
				inputMode={shape === "number" ? "decimal" : undefined}
				onChange={(e) => set({ values: e.target.value ? [e.target.value] : [] })}
				onKeyDown={(e) => e.key === "Enter" && setOpen(false)}
				placeholder={t("filter.value")}
				value={text(cond.values[0])}
				variant="sm"
			/>
		);
	};
	return (
		<Popover
			onOpenChange={(o) => {
				setOpen(o);
				setModes(false);
			}}
			open={open}
			trigger={(p) => (
				<Button
					variant="plain"
					{...p}
					className={cn(PILL, off && "line-through opacity-50")}
					title={off ? t("query.offHint") : undefined}
				>
					<FieldIcon kind={field.kind} size={13} />
					<span className="truncate">
						{field.label}
						{needsValue && !shown ? null : (
							<>
								{cond.mode === ":" && shape !== "check"
									? ": "
									: ` ${modeLabel(shape, cond.mode, t)} `}
								<span className="font-medium text-fg">{shown}</span>
							</>
						)}
					</span>
					<ChevronDown className="shrink-0" size={12} />
				</Button>
			)}
		>
			<div className="w-60 text-sm">
				<div className="flex items-center gap-1 px-1 pb-1 text-xs">
					<span className="min-w-0 truncate text-muted-foreground">{field.label}</span>
					<Button
						aria-expanded={modes}
						aria-label={t("filter.compare")}
						className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 font-medium text-fg hover:bg-hover"
						onClick={() => setModes(!modes)}
						variant="plain"
					>
						{modeLabel(shape, cond.mode, t)} <ChevronDown size={11} />
					</Button>
					<span className="flex-1" />
					<IconButton
						icon={Trash2}
						iconSize={13}
						label={t("view.removeFilter")}
						onClick={() => {
							setOpen(false);
							onRemove();
						}}
						size="xs"
					/>
				</div>
				{modes
					? MODES[shape].map((m) => (
							<MenuItem
								active={m === cond.mode}
								key={m}
								onClick={() => {
									set({ mode: m });
									setModes(false);
								}}
							>
								{modeLabel(shape, m, t)}
							</MenuItem>
						))
					: editor()}
				{!modes && onToggle && (
					<div className="mt-1 border-t border-line pt-1">
						<MenuItem
							onClick={() => {
								setOpen(false);
								onToggle();
							}}
						>
							{off ? t("query.on") : t("query.off")}
						</MenuItem>
					</div>
				)}
			</div>
		</Popover>
	);
}

/** Any other condition: its menu switches it off, turns it around, adds an alternative, removes it. */
function Chip({
	cond,
	ctx,
	off,
	onToggle,
	onNegate,
	onOr,
	onRemove,
	onUnder,
	onStatus,
	context,
}: {
	cond: Cond;
	ctx: Ctx;
	off?: boolean;
	onToggle?: () => void;
	onNegate?: () => void;
	onOr?: (c: Cond) => void;
	onRemove: () => void;
	onUnder: (then: (c: Cond) => void) => void;
	onStatus?: (s: StatusKey) => void;
	context?: boolean;
}) {
	const { t } = ctx;
	const [mode, setMode] = useState<"menu" | "or">("menu");
	return (
		<Popover
			onOpenChange={(o) => o && setMode("menu")}
			trigger={(p) => (
				<Button
					variant="plain"
					{...p}
					className={cn(PILL, "text-fg", off && "line-through opacity-50")}
					title={off ? t("query.offHint") : undefined}
				>
					<span className="truncate">{condLabel(cond, ctx)}</span>
					<ChevronDown className="shrink-0 text-muted-foreground" size={12} />
				</Button>
			)}
		>
			{(close) =>
				mode === "or" ? (
					<CondPicker
						context={context}
						fields={ctx.fields}
						onUnder={() => {
							close();
							onUnder(onOr!);
						}}
						pick={(c) => {
							onOr!(c);
							close();
						}}
					/>
				) : (
					<>
						{!off &&
							onStatus &&
							"status" in cond &&
							(["open", "active", "done"] as const).map((s) => (
								<MenuItem
									active={cond.status === s}
									key={s}
									onClick={() => {
										onStatus(s);
										close();
									}}
								>
									{t(`query.status.${s}`)}
								</MenuItem>
							))}
						{!off && onStatus && "status" in cond && <div className="my-1 border-t border-line" />}
						{onToggle && (
							<MenuItem
								onClick={() => {
									onToggle();
									close();
								}}
							>
								{off ? t("query.on") : t("query.off")}
							</MenuItem>
						)}
						{!off && onNegate && (
							<MenuItem
								onClick={() => {
									onNegate();
									close();
								}}
							>
								{"not" in cond ? t("query.unnegate") : t("query.negate")}
							</MenuItem>
						)}
						{!off && onOr && <MenuItem onClick={() => setMode("or")}>{t("query.or")}</MenuItem>}
						<MenuItem
							danger
							icon={<X size={13} />}
							onClick={() => {
								onRemove();
								close();
							}}
						>
							{t("query.removeCond")}
						</MenuItem>
					</>
				)
			}
		</Popover>
	);
}

/** "Filter" in a view's toolbar: the first step, then the new pill opens in the line below. */
export function AddFilter({
	onAdd,
	trigger,
	context,
	fields,
}: {
	onAdd: (c: Cond) => void;
	trigger: (p: { onClick: () => void; "aria-expanded": boolean }) => React.ReactNode;
	context?: boolean;
	fields?: ViewField[];
}) {
	const { t } = useT();
	const own = useViewFields(undefined);
	const [picking, setPicking] = useState(false);
	return (
		<>
			<Popover align="right" trigger={trigger}>
				{(close) => (
					<CondPicker
						context={context}
						fields={fields ?? own}
						onUnder={() => {
							close();
							setPicking(true);
						}}
						pick={(c) => {
							onAdd(c);
							close();
						}}
					/>
				)}
			</Popover>
			{picking && (
				<ItemPicker
					filter={(x) => x.kind === "note"}
					onClose={() => setPicking(false)}
					onPick={(id) => {
						onAdd({ under: { id } });
						setPicking(false);
					}}
					title={t("query.cond.under")}
				/>
			)}
		</>
	);
}

/**
 * `bare`: the quiet line under a view's tabs – pills and "+ Filter", no box and no text form.
 * `fields`: what the view lists can be filtered by (default: what the query's own types have).
 * `openLast`: the last pill starts open (it was just added from outside); `before`: in front of the pills.
 */
export function QueryEditor({
	def,
	onChange,
	autoFocus,
	context,
	bare,
	fields,
	openLast,
	before,
}: {
	def: QueryDef;
	onChange: (d: QueryDef) => void;
	autoFocus?: boolean;
	context?: boolean;
	bare?: boolean;
	fields?: ViewField[];
	openLast?: boolean;
	before?: React.ReactNode;
}) {
	const ix = useIndex();
	const { t, lang } = useT();
	const own = useViewFields(def.where);
	const ctx: Ctx = { ix, t, lang, fields: fields ?? own };
	const printed = printQuery(def, lang, ix);
	const [text, setText] = useState(printed);
	const [errors, setErrors] = useState<string[]>([]);
	const [focused, setFocused] = useState(false);
	const [asText, setAsText] = useState(false);
	const [picking, setPicking] = useState<((id: string) => void) | null>(null);
	// the pill added last opens at once: a new filter still wants its value
	const [fresh, setFresh] = useState<number | null>(null);
	// switched off: kept here while the editor is open (dimmed, a click switches it back on), not saved
	const [off, setOff] = useState<{ cond: Cond; at: number }[]>([]);
	useEffect(() => {
		if (!focused) setText(printed);
	}, [printed, focused]);
	const commit = (src = text) => {
		const parsed = parseQuery(src, ix);
		setErrors(parsed.errors);
		setOff([]);
		onChange(parsed.def);
	};
	const parts: Cond[] = def.where ? ("and" in def.where ? def.where.and : [def.where]) : [];
	const setParts = (next: Cond[]) => onChange({ ...def, where: combine(next, (and) => ({ and })) });
	const add = (c: Cond) => {
		setFresh(parts.length);
		setParts([...parts, c]);
	};
	const replace = (n: number, c: Cond | null) =>
		setParts(c ? parts.map((x, i) => (i === n ? c : x)) : parts.filter((_, i) => i !== n));
	const negate = (c: Cond): Cond => ("not" in c ? c.not : { not: c });
	const switchOff = (n: number) => {
		setOff([...off, { cond: parts[n]!, at: n }]);
		replace(n, null);
	};
	const switchOn = (k: number) => {
		const entry = off[k]!;
		setOff(off.filter((_, i) => i !== k));
		const next = [...parts];
		next.splice(Math.min(entry.at, next.length), 0, entry.cond);
		setParts(next);
	};
	const under = (then: (c: Cond) => void) =>
		setPicking(() => (id: string) => then({ under: { id } }));
	const chip = (c: Cond, n: number) => {
		const field = readField(c);
		if (field)
			return (
				<FieldPill
					cond={field}
					ctx={ctx}
					key={n}
					onChange={(x) => replace(n, x)}
					onPickPage={(then) => setPicking(() => then)}
					onRemove={() => replace(n, null)}
					onToggle={bare ? undefined : () => switchOff(n)}
					startOpen={fresh === n || (openLast && n === parts.length - 1)}
				/>
			);
		// an "or" shows its alternatives one by one, each with its own menu
		if ("or" in c)
			return (
				<span
					className="inline-flex flex-wrap items-center gap-1 rounded-full border border-dashed border-line p-0.5"
					key={n}
				>
					{c.or.map((alt, k) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id; a chip is its place in the query
						<span className="inline-flex items-center gap-1" key={k}>
							{k > 0 && <span className="text-xs text-muted-foreground">{t("query.orWord")}</span>}
							<Chip
								cond={alt}
								context={context}
								ctx={ctx}
								onNegate={() => replace(n, { or: c.or.map((x, i) => (i === k ? negate(x) : x)) })}
								onOr={(x) => replace(n, { or: [...c.or, x] })}
								onRemove={() => {
									const rest = c.or.filter((_, i) => i !== k);
									replace(n, combine(rest, (or) => ({ or })) ?? null);
								}}
								onUnder={under}
							/>
						</span>
					))}
				</span>
			);
		return (
			<Chip
				cond={c}
				context={context}
				ctx={ctx}
				key={n}
				onNegate={() => replace(n, negate(c))}
				onOr={(x) => replace(n, { or: [c, x] })}
				onRemove={() => replace(n, null)}
				onStatus={(status) => replace(n, { status })}
				onToggle={bare ? undefined : () => switchOff(n)}
				onUnder={under}
			/>
		);
	};
	return (
		<div className={bare ? undefined : "rounded-xl border border-line bg-surface p-2.5"}>
			<div className="flex flex-wrap items-center gap-1.5 text-xs">
				{before}
				{parts.map((p, n) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id; a chip is its place in the query
					<span className="inline-flex items-center gap-1.5" key={n}>
						{n > 0 && !bare && <span className="text-muted-foreground">{t("query.and")}</span>}
						{chip(p, n)}
					</span>
				))}
				{off.map((o, k) => {
					const field = readField(o.cond);
					const back = {
						ctx,
						off: true,
						onRemove: () => setOff(off.filter((_, i) => i !== k)),
						onToggle: () => switchOn(k),
					};
					return field ? (
						<FieldPill
							{...back}
							cond={field}
							// biome-ignore lint/suspicious/noArrayIndexKey: switched-off conditions have no id; a chip is its place in the list
							key={`off${k}`}
							onChange={() => undefined}
							onPickPage={() => undefined}
						/>
					) : (
						// biome-ignore lint/suspicious/noArrayIndexKey: switched-off conditions have no id; a chip is its place in the list
						<Chip {...back} cond={o.cond} key={`off${k}`} onUnder={under} />
					);
				})}
				<Popover
					trigger={(p) => (
						<Button
							variant="plain"
							{...p}
							autoFocus={autoFocus && !parts.length}
							className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[13px] text-muted-foreground hover:bg-hover hover:text-fg"
						>
							<Plus size={13} /> {bare ? t("query.addFilter") : t("query.addCond")}
						</Button>
					)}
				>
					{(close) => (
						<CondPicker
							context={context}
							fields={ctx.fields}
							onUnder={() => {
								close();
								under(add);
							}}
							pick={(c) => {
								add(c);
								close();
							}}
						/>
					)}
				</Popover>
				{!bare && (
					<Button
						className="ml-auto text-muted-foreground hover:text-fg"
						onClick={() => setAsText(!asText)}
						variant="plain"
					>
						{asText ? t("query.hideText") : t("query.asText")}
					</Button>
				)}
			</div>
			{asText && (
				<div className="mt-2 flex items-center gap-1.5">
					<Input
						aria-label={t("query.label")}
						autoFocus
						className={cn(
							"field min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground",
							errors.length > 0 && "text-warn",
						)}
						onBlur={() => {
							setFocused(false);
							if (text !== printed) commit();
						}}
						onChange={(e) => setText(e.target.value)}
						onFocus={() => setFocused(true)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								commit();
							}
							if (e.key === "Escape") setText(printed);
						}}
						placeholder={t("query.placeholder")}
						spellCheck={false}
						value={text}
						variant="bare"
					/>
					<span
						aria-label={t("query.help")}
						className="cursor-help text-muted-foreground"
						role="img"
						title={t("query.help")}
					>
						<HelpCircle size={14} />
					</span>
				</div>
			)}
			{errors.length > 0 && (
				<p className="mt-1 text-xs text-warn">{t("query.errors", { list: errors.join(", ") })}</p>
			)}
			{picking && (
				<ItemPicker
					filter={(x) => x.kind === "note"}
					onClose={() => setPicking(null)}
					onPick={(id) => {
						picking(id);
						setPicking(null);
					}}
					title={t("filter.pickPage")}
				/>
			)}
		</div>
	);
}
