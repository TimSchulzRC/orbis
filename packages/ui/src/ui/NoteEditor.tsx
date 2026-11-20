// A note's text as on its page: the Markdown editor with live query blocks and the toolbar's
// "extract". The page, the inbox's card and the quick note all write with it.

import type { EditorView } from "@codemirror/view";
import type { Item } from "@orbis/core/model";
import { useContext, useMemo } from "react";
import { useIndex, useRepo } from "../hooks";
import { useT } from "../i18n";
import { ScopeContext } from "../scope";
import { Editor } from "./Editor";
import { toolbarExtract } from "./editor/toolbar";
import { queryBlocks } from "./QueryBlock";

export function NoteEditor({
	item,
	autoFocus,
	minHeight,
	onView,
}: {
	item: Item;
	autoFocus?: boolean;
	minHeight?: string;
	onView?: (v: EditorView | null) => void;
}) {
	const { t } = useT();
	// the workspace of this part of the page (the inbox shows entries of several)
	const repo = useRepo();
	const space = useContext(ScopeContext)?.id;
	const doc = useMemo(() => repo.getDoc(item.id), [repo, item.id]);
	const typed = !!useIndex().schemaOf(item);
	return (
		<Editor
			autoFocus={autoFocus}
			doc={doc}
			extra={[queryBlocks(item.id), toolbarExtract.of(true)]}
			minHeight={minHeight}
			nodeId={item.id}
			onView={onView}
			placeholder={t(typed ? "editor.placeholderTyped" : "editor.placeholder")}
			space={space}
		/>
	);
}
