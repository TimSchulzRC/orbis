// Text edits the app makes in a page's Markdown.

/** A checkbox list item, also inside a quote: "- [ ] …", "1. [x] …", "> - [ ] …". */
const TASK = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/;
/** A code fence, also inside a quote. */
const FENCE = /^(?:[ \t]*>)*[ \t]*(```|~~~)/;

/** What follows a checkbox on its line. */
const label = (line: string) => line.replace(TASK, "").trim();

/**
 * Ticks or unticks the n-th checkbox of the text, counted from the top as the page shows them:
 * lines in code blocks are not checkboxes. With `raw`, the source of the list item the page shows
 * there, a line that says something else stays as it is.
 */
export function toggleTask(body: string, n: number, raw?: string): string {
	const expected = raw === undefined ? undefined : label(raw.split("\n")[0] ?? "");
	let i = 0;
	let fence: string | null = null;
	return body
		.split("\n")
		.map((line) => {
			const f = line.match(FENCE)?.[1];
			if (f && (!fence || fence === f)) fence = fence ? null : f;
			if (fence || f) return line;
			const m = line.match(TASK);
			if (!m || i++ !== n) return line;
			if (expected !== undefined && label(line) !== expected) return line;
			return line.replace(TASK, `${m[1]}${m[2] === " " ? "x" : " "}${m[3]}`);
		})
		.join("\n");
}
