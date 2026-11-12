import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { tr } from "../i18n";
import { repo } from "../repo";
import { notify } from "./feedback";

const MAX_TITLE = 80;

/**
 * The selected text becomes a new item of `type` and a link to it takes its place. Without a
 * selection the paragraph at the cursor is used.
 */
export function extractAs(view: EditorView, type: string) {
	const sel = view.state.selection.main;
	let { from, to } = sel;
	if (from === to) {
		const line = view.state.doc.lineAt(from);
		from = line.from;
		to = line.to;
	}
	const text = view.state.sliceDoc(from, to).trim();
	if (!text) return notify(tr("extract.empty"));
	const lines = text.split("\n");
	const first = lines[0]!.replace(/^[-*#>\s]+/, "").trim();
	const tooLong = first.length > MAX_TITLE;
	const title = tooLong ? `${first.slice(0, MAX_TITLE - 3)}…` : first;
	const body = lines.length > 1 || tooLong ? text : "";
	const ix = repo.index();
	let unique = title;
	for (let n = 2; ix.resolveTitle(unique); n++) unique = `${title} (${n})`;
	repo.create({ title: unique, body, type });
	const insert = `[[${unique}]]`;
	view.dispatch({
		changes: { from, to, insert },
		selection: EditorSelection.cursor(from + insert.length),
	});
	view.focus();
}
