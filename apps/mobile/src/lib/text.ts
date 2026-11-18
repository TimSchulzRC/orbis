// Text edits the app makes in a page's Markdown.

/** A checkbox list item, also inside a quote: "- [ ] …", "1. [x] …", "> - [ ] …". */
const TASK = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/;
const FENCE = /^[ \t]*(```|~~~)/;

/**
 * Ticks or unticks the n-th checkbox of the text, counted from the top as the page shows them:
 * lines in code blocks are not checkboxes.
 */
export function toggleTask(body: string, n: number): string {
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
			return line.replace(TASK, `${m[1]}${m[2] === " " ? "x" : " "}${m[3]}`);
		})
		.join("\n");
}
