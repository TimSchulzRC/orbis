import type { EditorView } from "@codemirror/view";
import { repo } from "../repo";
import { tr } from "../i18n";

/** The type "extract" uses: the first pinned capture type (shipped: Karte). Survives deleting that type. */
export function extractType(): string | null {
  return repo.index().captureTypes()[0] ?? null;
}

/**
 * "Als Karte herauslösen": the selected paragraph becomes a new standalone item, and a
 * link to it takes its place. Without a selection the paragraph at the cursor is used.
 */
export function extractAsCard(view: EditorView) {
  const sel = view.state.selection.main;
  let { from, to } = sel;
  if (from === to) {
    const line = view.state.doc.lineAt(from);
    from = line.from;
    to = line.to;
  }
  const text = view.state.sliceDoc(from, to).trim();
  if (!text) return alert(tr("extract.empty"));
  const lines = text.split("\n");
  const first = lines[0]!.replace(/^[-*#>\s]+/, "").trim();
  const title = first.length > 80 ? first.slice(0, 77) + "…" : first;
  const body = lines.length > 1 || first.length > 80 ? text : "";
  const ix = repo.index();
  let unique = title;
  for (let n = 2; ix.resolveTitle(unique); n++) unique = `${title} (${n})`;
  repo.create({ title: unique, body, type: extractType() });
  view.dispatch({ changes: { from, to, insert: `[[${unique}]]` } });
}
