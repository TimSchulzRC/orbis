import { expect, test } from "bun:test";
import { mergeText, textDiff, unifiedDiff } from "@orbis/core/diff";

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

test("merging a draft: edits from elsewhere stay, a clash keeps theirs", () => {
	const base = "Ziel\n\n- Design\n- Umsetzung\n";
	// an agent appended a line while the phone changed another
	expect(mergeText(base, "Ziel!\n\n- Design\n- Umsetzung\n", `${base}- Livegang\n`)).toBe(
		"Ziel!\n\n- Design\n- Umsetzung\n- Livegang\n",
	);
	// nothing changed elsewhere, or only there
	expect(mergeText(base, "neu", base)).toBe("neu");
	expect(mergeText(base, base, "anders")).toBe("anders");
	// both changed the same line: theirs stays, the draft's other edits still go in
	expect(mergeText("a\nb\nc\nd\ne\nf", "a\nB\nc\nd\ne\nF", "a\nX\nc\nd\ne\nf")).toBe(
		"a\nX\nc\nd\ne\nF",
	);
	// lines changed one for one clash one by one
	expect(mergeText("a\nb\nc", "A\nB\nc", "X\nb\nc")).toBe("X\nB\nc");
	// neighbouring lines are no clash
	expect(mergeText("a\nb\nc", "a\nB\nc", "a\nb\nC")).toBe("a\nB\nC");
	// two equal passages: an edit stays where it was made, never moves to the other one
	expect(mergeText("x\ny\nx\ny", "X\ny\nx\ny", "Z\ny\nx\ny")).toBe("Z\ny\nx\ny");
	expect(mergeText("x\ny\nx\ny", "x\ny\nX\ny", "Z\ny\nx\ny")).toBe("Z\ny\nX\ny");
	// insertions at the same place clash, at different places both stay
	expect(mergeText("a\nb", "a\nmine\nb", "a\ntheirs\nb")).toBe("a\ntheirs\nb");
	expect(mergeText("a\nb", "mine\na\nb", "a\nb\ntheirs")).toBe("mine\na\nb\ntheirs");
});
