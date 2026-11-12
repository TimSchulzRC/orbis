// "Rules for agents": an item's own rules and the ones it inherits – from everything above it over
// "Part of" (all parents) and from the workspace (its settings). Agents get them over MCP with every
// answer about the item (see core rules.ts); people rarely need them, so the page shows only an icon
// at the right edge after the tags.

import type { Item } from "@obtion/core/model";
import { inheritedOwners, workspaceRules } from "@obtion/core/rules";
import { Bot } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAccounts } from "../accounts";
import { Textarea } from "../components/ui/textarea";
import { itemHref, useIndex, useRepo } from "../hooks";
import { titleOf, useT } from "../i18n";
import { Button, Dialog } from "./primitives";
import { openSpaceSettings } from "./settings-open";

/** The workspace's rules in its settings (an element id). */
export const WORKSPACE_RULES = "workspace-rules";

/** The settings of the workspace, at its rules (the dialog renders a moment after opening). */
function openWorkspaceRules(space: string) {
	openSpaceSettings(space);
	let tries = 20;
	const find = () => {
		const el = document.getElementById(WORKSPACE_RULES);
		if (el) el.scrollIntoView({ block: "center" });
		else if (tries--) requestAnimationFrame(find);
	};
	requestAnimationFrame(find);
}

/** A hint of a rule's text: its first lines. */
const preview = (text: string) => (text.length > 300 ? `${text.slice(0, 299)}…` : text);

/**
 * The text of rules (an item's or, with the settings id, the workspace's). Saved when it loses
 * focus – one step to undo –, and following changes from elsewhere while it has no focus.
 */
export function RulesField({
	id,
	value,
	autoFocus,
	onBlur,
	label,
	placeholder,
}: {
	id: string;
	value: string;
	autoFocus?: boolean;
	onBlur?: (text: string) => void;
	label: string;
	placeholder: string;
}) {
	const repo = useRepo();
	const [draft, setDraft] = useState(value);
	const focused = useRef(false);
	const latest = useRef({ draft, value });
	latest.current = { draft, value };
	useEffect(() => {
		if (!focused.current) setDraft(value);
	}, [value]);
	const save = () => {
		const { draft: d, value: v } = latest.current;
		if (d !== v && (d.trim() || v.trim())) repo.setRules(id, d);
	};
	// leaving the page while typing keeps what was typed
	useEffect(() => () => void (focused.current && save()), [id]);
	return (
		<Textarea
			aria-label={label}
			autoFocus={autoFocus}
			className="min-h-20 w-full resize-y rounded-lg border-line bg-bg text-sm"
			onBlur={() => {
				focused.current = false;
				save();
				onBlur?.(latest.current.draft);
			}}
			onChange={(e) => setDraft(e.target.value)}
			onFocus={() => (focused.current = true)}
			placeholder={placeholder}
			rows={3}
			value={draft}
		/>
	);
}

/** The robot icon after the tags: an item's own rules and what applies from above. Only agents act
 * on them, so they live in this dialog and not on the page. Nothing is saved until "Save"
 * (or Ctrl/Cmd+Enter); closing the dialog drops what was typed. Until then a change from elsewhere
 * replaces the text, unless it was edited. */
export function AgentRulesDialog({ item, onClose }: { item: Item; onClose: () => void }) {
	const ix = useIndex();
	const repo = useRepo();
	const { t } = useT();
	const { active } = useAccounts();
	const inherited = inheritedOwners(ix, item.id);
	const ws = workspaceRules(ix);
	const [draft, setDraft] = useState(item.rules);
	const [base, setBase] = useState(item.rules);
	if (item.rules !== base) {
		setBase(item.rules);
		if (draft === base) setDraft(item.rules);
	}
	const dirty = draft !== item.rules;
	const save = () => {
		if (dirty) repo.setRules(item.id, draft);
		onClose();
	};
	return (
		<Dialog onClose={onClose} title={t("rules.title")}>
			<Textarea
				aria-label={t("rules.title")}
				autoFocus
				className="min-h-20 w-full resize-y rounded-lg border-line bg-bg text-sm"
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.preventDefault(), save();
				}}
				placeholder={t("rules.placeholder")}
				rows={3}
				value={draft}
			/>
			<p className="mt-2 text-xs text-muted-foreground">{t("rules.hint")}</p>
			{(inherited.length > 0 || ws) && (
				<p className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted-foreground">
					<Bot aria-hidden className="shrink-0" size={13} />
					<span>{t("rules.alsoInherited")}</span>
					{ws && active && (
						<Button
							className="tap-y text-link hover:underline"
							onClick={() => (onClose(), openWorkspaceRules(active.id))}
							title={preview(ws.text)}
							variant="plain"
						>
							{t("rules.workspace")}
						</Button>
					)}
					{inherited.map((o, n) => (
						<span key={o.id}>
							{(n > 0 || ws) && <span aria-hidden>· </span>}
							<a
								className="text-link hover:underline"
								href={itemHref(o.id)}
								onClick={onClose}
								title={preview(o.rules)}
							>
								{titleOf(o, t)}
							</a>
						</span>
					))}
				</p>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<Button onClick={onClose} variant="outline">
					{t("cancel")}
				</Button>
				<Button disabled={!dirty} onClick={save} variant="primary">
					{t("view.save")}
				</Button>
			</div>
		</Dialog>
	);
}
