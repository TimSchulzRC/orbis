// One query, two ways in: clickable condition chips, and the same query as text (folded by default).
// The text form parses every language and is shown in the UI language. Storage is JSON.

import type { Index } from "@obtion/core/graph";
import type { Lang, T } from "@obtion/core/i18n";
import { type Cond, parseQuery, printQuery, type QueryDef } from "@obtion/core/query";
import { ChevronLeft, HelpCircle, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Input } from "../components/ui/input";
import { useIndex } from "../hooks";
import { useT } from "../i18n";
import { cn } from "../lib/utils";
import { TypeGlyph } from "./item-look";
import { ItemPicker } from "./Picker";
import { Button, IconButton, MenuItem, Popover } from "./primitives";

type Step = "root" | "type" | "status" | "due" | "tag";
type Ctx = { ix: Index; t: T; lang: Lang };

/** How a condition reads on its chip: the text form, "not …" for a negation. */
function condLabel(c: Cond, { ix, t, lang }: Ctx): string {
	return "not" in c
		? `${t("query.not")} ${condLabel(c.not, { ix, t, lang })}`
		: printQuery({ where: c }, lang, ix);
}

/** No condition, the only one, or several joined by `join` ("and", "or"). */
function combine(conds: Cond[], join: (list: Cond[]) => Cond): Cond | undefined {
	return conds.length <= 1 ? conds[0] : join(conds);
}

/** `onUnder` opens the place picker, a dialog outside the popover. */
function CondPicker({
	pick,
	onUnder,
	context,
}: {
	pick: (c: Cond) => void;
	onUnder: () => void;
	context?: boolean;
}) {
	const ix = useIndex();
	const { t } = useT();
	const [step, setStep] = useState<Step>("root");
	const [tag, setTag] = useState("");
	const types = ix.typesByName();
	const back = (
		<Button
			className="mb-1 flex items-center gap-1 px-2 text-xs text-muted-foreground hover:text-fg"
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
						{t("query.status." + s)}
					</MenuItem>
				))}
			</>
		);
	if (step === "due")
		return (
			<>
				{back}
				<MenuItem onClick={() => pick({ prop: "due", op: "<", value: "+0d" })}>
					{t("query.due.overdue")}
				</MenuItem>
				<MenuItem onClick={() => pick({ prop: "due", op: "<=", value: "+7d" })}>
					{t("query.due.week")}
				</MenuItem>
				<MenuItem onClick={() => pick({ prop: "due", op: "empty" })}>
					{t("query.due.none")}
				</MenuItem>
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
					onKeyDown={(e) =>
						e.key === "Enter" && tag.trim() && (pick({ tag: tag.trim().toLowerCase() }), setTag(""))
					}
					placeholder={t("query.tagName")}
					value={tag}
					variant="sm"
				/>
			</div>
		);
	return (
		<>
			{types.length > 0 && (
				<MenuItem onClick={() => setStep("type")}>{t("query.cond.type")}</MenuItem>
			)}
			{context && (
				<MenuItem onClick={() => pick({ under: { this: true } })}>
					{t("query.cond.underThis")}
				</MenuItem>
			)}
			<MenuItem onClick={onUnder}>{t("query.cond.under")}</MenuItem>
			<MenuItem onClick={() => setStep("status")}>{t("query.cond.status")}</MenuItem>
			<MenuItem onClick={() => setStep("due")}>{t("query.cond.due")}</MenuItem>
			<MenuItem onClick={() => setStep("tag")}>{t("query.cond.tag")}</MenuItem>
			<MenuItem onClick={() => pick({ inbox: true })}>{t("query.cond.inbox")}</MenuItem>
			<MenuItem onClick={() => pick({ file: true })}>{t("query.cond.file")}</MenuItem>
		</>
	);
}

/** Switching off is offered at the top level only. */
function Chip({
	cond,
	ctx,
	off,
	onToggle,
	onNegate,
	onOr,
	onRemove,
	onUnder,
	context,
	quickRemove,
}: {
	cond: Cond;
	ctx: Ctx;
	off?: boolean;
	onToggle?: () => void;
	onNegate?: () => void;
	onOr?: (c: Cond) => void;
	onRemove: () => void;
	onUnder: (then: (c: Cond) => void) => void;
	context?: boolean;
	quickRemove?: boolean;
}) {
	const { t } = ctx;
	const [mode, setMode] = useState<"menu" | "or">("menu");
	const chip = (
		<Popover
			onOpenChange={(o) => o && setMode("menu")}
			trigger={(p) => (
				<Button
					variant="plain"
					{...p}
					className={cn(
						"inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line bg-bg px-1.5 py-0.5 hover:border-focus",
						off && "line-through opacity-50",
					)}
					title={off ? t("query.offHint") : undefined}
				>
					{condLabel(cond, ctx)}
				</Button>
			)}
		>
			{(close) =>
				mode === "or" ? (
					<CondPicker
						context={context}
						onUnder={() => (close(), onUnder(onOr!))}
						pick={(c) => (onOr!(c), close())}
					/>
				) : (
					<>
						{onToggle && (
							<MenuItem onClick={() => (onToggle(), close())}>
								{off ? t("query.on") : t("query.off")}
							</MenuItem>
						)}
						{!off && onNegate && (
							<MenuItem onClick={() => (onNegate(), close())}>
								{"not" in cond ? t("query.unnegate") : t("query.negate")}
							</MenuItem>
						)}
						{!off && onOr && <MenuItem onClick={() => setMode("or")}>{t("query.or")}</MenuItem>}
						<MenuItem danger icon={<X size={13} />} onClick={() => (onRemove(), close())}>
							{t("query.removeCond")}
						</MenuItem>
					</>
				)
			}
		</Popover>
	);
	if (!quickRemove) return chip;
	// in the filter line under the tabs: "status:open ×"
	return (
		<span className="inline-flex items-center">
			{chip}
			<IconButton
				className="-ml-0.5"
				icon={X}
				iconSize={12}
				label={t("query.removeCondNamed", { cond: condLabel(cond, ctx) })}
				onClick={onRemove}
				size="xs"
			/>
		</span>
	);
}

export function AddFilter({
	onAdd,
	trigger,
	context,
}: {
	onAdd: (c: Cond) => void;
	trigger: (p: { onClick: () => void; "aria-expanded": boolean }) => React.ReactNode;
	context?: boolean;
}) {
	const { t } = useT();
	const [picking, setPicking] = useState(false);
	return (
		<>
			<Popover trigger={trigger}>
				{(close) => (
					<CondPicker
						context={context}
						onUnder={() => (close(), setPicking(true))}
						pick={(c) => (onAdd(c), close())}
					/>
				)}
			</Popover>
			{picking && (
				<ItemPicker
					filter={(x) => x.kind === "note"}
					onClose={() => setPicking(false)}
					onPick={(id) => (onAdd({ under: { id } }), setPicking(false))}
					title={t("query.cond.under")}
				/>
			)}
		</>
	);
}

/** `bare`: the quiet line under a view's tabs – chips with ×, "+ Filter", no box and no text form. */
export function QueryEditor({
	def,
	onChange,
	autoFocus,
	context,
	bare,
}: {
	def: QueryDef;
	onChange: (d: QueryDef) => void;
	autoFocus?: boolean;
	context?: boolean;
	bare?: boolean;
}) {
	const ix = useIndex();
	const { t, lang } = useT();
	const ctx: Ctx = { ix, t, lang };
	const printed = printQuery(def, lang, ix);
	const [text, setText] = useState(printed);
	const [errors, setErrors] = useState<string[]>([]);
	const [focused, setFocused] = useState(false);
	const [asText, setAsText] = useState(false);
	const [picking, setPicking] = useState<((c: Cond) => void) | null>(null);
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
	const add = (c: Cond) => setParts([...parts, c]);
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
	const under = (then: (c: Cond) => void) => setPicking(() => then);
	const chip = (c: Cond, n: number) => {
		// an "or" shows its alternatives one by one, each with its own menu
		if ("or" in c)
			return (
				<span
					className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-dashed border-line px-1 py-0.5"
					key={n}
				>
					{c.or.map((alt, k) => (
						<span className="inline-flex items-center gap-1" key={k}>
							{k > 0 && <span className="text-muted-foreground">{t("query.orWord")}</span>}
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
				onToggle={bare ? undefined : () => switchOff(n)}
				onUnder={under}
				quickRemove={bare}
			/>
		);
	};
	return (
		<div className={bare ? undefined : "rounded-xl border border-line bg-surface p-2.5"}>
			<div className="flex flex-wrap items-center gap-1.5 text-xs">
				{parts.map((p, n) => (
					<span className="inline-flex items-center gap-1.5" key={n}>
						{n > 0 && !bare && <span className="text-muted-foreground">{t("query.and")}</span>}
						{chip(p, n)}
					</span>
				))}
				{off.map((o, k) => (
					<Chip
						cond={o.cond}
						ctx={ctx}
						key={"off" + k}
						off
						onRemove={() => setOff(off.filter((_, i) => i !== k))}
						onToggle={() => switchOn(k)}
						onUnder={under}
					/>
				))}
				<Popover
					trigger={(p) => (
						<Button
							variant="plain"
							{...p}
							autoFocus={autoFocus && !parts.length}
							className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-hover hover:text-fg"
						>
							<Plus size={12} /> {bare ? t("query.addFilter") : t("query.addCond")}
						</Button>
					)}
				>
					{(close) => (
						<CondPicker
							context={context}
							onUnder={() => (close(), under(add))}
							pick={(c) => (add(c), close())}
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
						onBlur={() => (setFocused(false), text !== printed && commit())}
						onChange={(e) => setText(e.target.value)}
						onFocus={() => setFocused(true)}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.preventDefault(), commit();
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
						picking({ under: { id } });
						setPicking(null);
					}}
					title={t("query.cond.under")}
				/>
			)}
		</div>
	);
}
