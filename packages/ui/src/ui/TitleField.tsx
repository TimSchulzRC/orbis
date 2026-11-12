import type { Item } from "@obtion/core/model";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Textarea } from "../components/ui/textarea";
import { useFocusDraft, useRepo } from "../hooks";
import { useT } from "../i18n";

/**
 * Multi-line title that wraps instead of clipping; Enter commits (`onEnter`: and goes on, as into the text).
 * `live`: every change commits at once, not only on leaving the field.
 */
export function TitleField({
	item,
	autoFocus,
	placeholder,
	onEnter,
	live,
}: {
	item: Item;
	autoFocus: boolean;
	placeholder?: string;
	onEnter?: () => void;
	live?: boolean;
}) {
	const { t } = useT();
	// the workspace of this part of the page (the tray's panel shows entries of several)
	const repo = useRepo();
	const { draft, setDraft, focused, onKeyDown } = useFocusDraft(item.title);
	const ref = useRef<HTMLTextAreaElement>(null);
	useLayoutEffect(() => {
		const el = ref.current!;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [draft]);
	const latest = useRef(draft);
	latest.current = draft;
	const save = (text: string) => {
		const title = text.replace(/\s+/g, " ").trim();
		if (title !== (repo.get(item.id)?.title ?? "")) repo.setTitle(item.id, title);
	};
	const commit = () => ((focused.current = false), save(latest.current));
	useEffect(() => () => void (focused.current && commit()), []);
	return (
		<Textarea
			aria-label={t("item.title")}
			autoFocus={autoFocus}
			className="field page-title block w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-faint focus-visible:ring-0"
			data-large
			onBlur={commit}
			onChange={(e) => {
				const text = e.target.value.replace(/\n/g, " ");
				setDraft(text);
				if (live) save(text);
			}}
			onFocus={() => (focused.current = true)}
			onKeyDown={(e) => (
				onKeyDown(e), e.key === "Enter" && !e.nativeEvent.isComposing && onEnter?.()
			)}
			placeholder={placeholder ?? t("untitled")}
			ref={ref}
			rows={1}
			value={draft}
			variant="inline"
		/>
	);
}
