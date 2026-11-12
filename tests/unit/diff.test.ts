import { expect, test } from "bun:test";
import { textDiff, unifiedDiff } from "@obtion/core/diff";

test("same text: no hunks", () => {
	expect(textDiff("a\nb\n", "a\nb\n")).toEqual({ hunks: [], added: 0, removed: 0 });
	// a missing newline at the end is no change worth showing
	expect(textDiff("a\nb", "a\nb\n").hunks).toEqual([]);
});

test("a changed line with context, counted", () => {
	const d = textDiff(
		"one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n",
		"one\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight\n",
	);
	expect(d.added).toBe(1);
	expect(d.removed).toBe(1);
	expect(d.hunks.length).toBe(1);
	expect(unifiedDiff(d).text).toBe(
		["@@ -1,7 +1,7 @@", " one", " two", " three", "-four", "+FOUR", " five", " six", " seven"].join(
			"\n",
		),
	);
});

test("changes far apart are separate hunks; context can be narrowed", () => {
	const a = Array.from({ length: 30 }, (_, i) => `Line ${i}`).join("\n");
	const b = a.replace("Line 2\n", "Line two\n").replace("Line 27\n", "Line twenty-seven\n");
	expect(textDiff(a, b).hunks.length).toBe(2);
	const tight = textDiff(a, b, 0);
	expect(tight.hunks.map((h) => h.lines.map((l) => l.op + l.text))).toEqual([
		["-Line 2", "+Line two"],
		["-Line 27", "+Line twenty-seven"],
	]);
	expect(tight.hunks.map((h) => [h.oldStart, h.newStart])).toEqual([
		[3, 3],
		[28, 28],
	]);
});

test("from and to the empty text", () => {
	expect(unifiedDiff(textDiff("", "new\ntwo\n")).text).toBe("@@ -1,0 +1,2 @@\n+new\n+two");
	const gone = textDiff("gone\n", "");
	expect([gone.added, gone.removed]).toEqual([0, 1]);
});

test("unified text is capped by lines and width, and says how much there was", () => {
	const d = textDiff(
		"",
		Array.from({ length: 50 }, (_, i) => `${i} ${"x".repeat(300)}`).join("\n"),
	);
	const u = unifiedDiff(d, { maxLines: 10, maxWidth: 40 });
	expect(u.shown).toBe(10);
	expect(u.total).toBe(51); // one hunk header and 50 lines
	expect(u.text.split("\n").length).toBe(10);
	expect(u.text.split("\n")[1]!.length).toBe(40);
	expect(u.text.split("\n")[1]!.endsWith("…")).toBe(true);
});

test("a rewrite too big to diff closely shows as replaced, still counted right", () => {
	const a = Array.from({ length: 6000 }, (_, i) => `old ${i}`).join("\n");
	const b = Array.from({ length: 6000 }, (_, i) => `new ${i}`).join("\n");
	const d = textDiff(a, b);
	expect([d.added, d.removed]).toEqual([6000, 6000]);
	expect(d.hunks.length).toBe(1);
	expect(d.hunks[0]!.lines[0]).toEqual({ op: "-", text: "old 0" });
});
