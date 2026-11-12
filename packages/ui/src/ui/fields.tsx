import { dayOf, timeOf, withTime } from "@obtion/core/date";
import { dateText, parseDateTime } from "@obtion/core/input";
import { todayISO } from "@obtion/core/model";
import { CalendarDays } from "lucide-react";
import { useRef, useState } from "react";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useFocusDraft } from "../hooks";
import { useT } from "../i18n";
import { isCoarse } from "../lib/platform";
import { cn } from "../lib/utils";
import { Button } from "./primitives";

/** Commits on blur or Enter. */
export function InlineText({
	value,
	onCommit,
	placeholder,
	className,
	multiline,
	autoFocus,
	label,
	large,
}: {
	value: string;
	onCommit: (v: string) => void;
	placeholder?: string;
	className?: string;
	multiline?: boolean;
	autoFocus?: boolean;
	label?: string;
	/** Heading-sized, keeps its size on phones. */
	large?: boolean;
}) {
	const { draft, setDraft, focused, onKeyDown } = useFocusDraft(value);
	const commit = () => {
		focused.current = false;
		if (draft !== value) onCommit(draft);
	};
	const props = {
		value: draft,
		placeholder,
		autoFocus,
		"data-large": large || undefined,
		"aria-label": label ?? placeholder,
		onFocus: () => (focused.current = true),
		onBlur: commit,
		onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
			setDraft(e.target.value),
		className: cn(
			"field w-full bg-transparent outline-none placeholder:text-muted-foreground",
			className,
		),
	};
	if (multiline)
		return (
			<Textarea
				variant="inline"
				{...props}
				className={cn(props.className, "resize-none [field-sizing:content]")}
				rows={Math.max(2, draft.split("\n").length)}
			/>
		);
	return <Input variant="bare" {...props} onKeyDown={onKeyDown} />;
}

/**
 * Commits only complete, plausible dates. Parses in the app language, not the browser's
 * (30.10.2026, 10/30/2026, morgen, Freitag …), the same way as the agent's input. A time is
 * optional (30.10.2026 14:30); the calendar picker changes the day and keeps the time.
 */
export function DateField({
	value,
	onChange,
	label,
	className,
	autoFocus,
}: {
	value?: string;
	onChange: (v: string) => void;
	label: string;
	className?: string;
	autoFocus?: boolean;
}) {
	const { t, lang } = useT();
	const shown = dateText(lang, value);
	const { draft: text, setDraft: setText, focused, onKeyDown } = useFocusDraft(shown);
	const [bad, setBad] = useState(false);
	const [editing, setEditing] = useState(false);
	const picker = useRef<HTMLInputElement>(null);
	const commit = () => {
		focused.current = false;
		setEditing(false);
		const raw = text.trim();
		if (!raw) {
			setBad(false);
			if (value) onChange("");
			return;
		}
		const iso = parseDateTime(raw, todayISO());
		if (!iso) {
			setBad(true);
			setTimeout(() => (setBad(false), setText(shown)), 1500);
			return;
		}
		setBad(false);
		setText(dateText(lang, iso));
		if (iso !== value) onChange(iso);
	};
	return (
		<span
			className={cn(
				"field-within group/date -ml-1 inline-flex items-center rounded-md hover:bg-hover",
				className,
			)}
		>
			<Input
				aria-invalid={bad || undefined}
				aria-label={label}
				autoFocus={autoFocus}
				className={cn(
					text.length > 10 ? "w-[9.2rem]" : "w-[6.6rem]",
					"bg-transparent px-1 py-0.5 tabular-nums outline-none placeholder:text-muted-foreground",
					bad && "text-danger",
				)}
				onBlur={commit}
				onChange={(e) => setText(e.target.value)}
				// typing a date on a touch screen is awkward, so an empty one opens the picker
				onClick={() => !value && isCoarse() && picker.current?.showPicker?.()}
				onFocus={() => ((focused.current = true), setEditing(true))}
				onKeyDown={onKeyDown}
				placeholder={editing ? t("date.placeholder") : "–"}
				value={text}
				variant="bare"
			/>
			<Button
				aria-label={t("date.calendar")}
				className="tap relative rounded p-0.5 text-muted-foreground opacity-60 hover:text-fg focus-visible:opacity-100 group-hover/date:opacity-100"
				onClick={() => picker.current?.showPicker?.()}
				type="button"
				variant="plain"
			>
				<CalendarDays size={13} />
				<Input
					aria-hidden
					className="pointer-events-none absolute inset-0 opacity-0"
					onChange={(e) =>
						e.target.value && onChange(withTime(e.target.value, value ? timeOf(value) : undefined))
					}
					ref={picker}
					tabIndex={-1}
					type="date"
					value={value ? dayOf(value) : ""}
					variant="bare"
				/>
			</Button>
		</span>
	);
}
