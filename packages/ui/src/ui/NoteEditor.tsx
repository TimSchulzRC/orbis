// A note's text as on its page: the Markdown editor with live query blocks and the toolbar's
// "extract". The page, the inbox's card and the quick note all write with it.
import { useMemo } from "react";
import type { EditorView } from "@codemirror/view";
import type { Item } from "@obtion/core/model";
import { useIndex, useRepo } from "../hooks";
import { useT } from "../i18n";
import { Editor } from "./Editor";
import { queryBlocks } from "./QueryBlock";
import { toolbarExtract } from "./editor/toolbar";

export function NoteEditor({ item, autoFocus, minHeight, onView }: { item: Item; autoFocus?: boolean; minHeight?: string; onView?: (v: EditorView | null) => void }) {
  const { t } = useT();
  // the workspace of this part of the page (the inbox shows entries of several)
  const repo = useRepo();
  const doc = useMemo(() => repo.getDoc(item.id), [repo, item.id]);
  const typed = !!useIndex().schemaOf(item);
  return (
    <Editor
      doc={doc}
      nodeId={item.id}
      autoFocus={autoFocus}
      onView={onView}
      extra={[queryBlocks(item.id), toolbarExtract.of(true)]}
      minHeight={minHeight}
      placeholder={t(typed ? "editor.placeholderTyped" : "editor.placeholder")}
    />
  );
}
