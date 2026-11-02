// GFM tables as text (packages/ui/src/ui/editor/tableText.ts): the cells of a row, and the edits
// to a row that keep every other cell's spacing as it is.
import { describe, expect, test } from "bun:test";
import { parseWikiLinks, renameLinksIn } from "@obtion/core/model";
import { plainText } from "@obtion/core/search";
import { type Change, DELIMITER, alignments, cellAt, deleteCell, emptyRow, insertCell, newTable, parseRow, sourceOffset } from "../../packages/ui/src/ui/editor/tableText";

const apply = (text: string, c: Change | null) => (c ? text.slice(0, c.from) + c.insert + text.slice(c.to) : text);
const cells = (text: string) => parseRow(text).cells.map((c) => text.slice(c.from, c.to));

describe("parseRow", () => {
  test("cells with and without pipes at the ends", () => {
    expect(cells("| Feld | Wert |")).toEqual(["Feld", "Wert"]);
    expect(cells("Feld | Wert")).toEqual(["Feld", "Wert"]);
    expect(cells("| Feld | Wert")).toEqual(["Feld", "Wert"]);
    expect(cells("Feld | Wert |")).toEqual(["Feld", "Wert"]);
    expect(cells("|a|b|")).toEqual(["a", "b"]);
  });
  test("an escaped pipe stays in its cell", () => {
    expect(cells("| [[Seite\\|Alias]] | `a \\| b` |")).toEqual(["[[Seite\\|Alias]]", "`a \\| b`"]);
  });
  test("empty cells sit after the first space", () => {
    const row = parseRow("|  | x |");
    expect(row.cells.map((c) => [c.from, c.to])).toEqual([[2, 2], [5, 6]]);
    expect(cells(emptyRow(3))).toEqual(["", "", ""]);
  });
  test("cellAt finds the column between two pipes", () => {
    const row = parseRow("| aa | bb | cc |");
    expect([0, 1, 3, 5, 6, 9, 14, 16].map((o) => cellAt(row, o))).toEqual([0, 0, 0, 0, 1, 1, 2, 2]);
  });
});

test("delimiter rows and alignment", () => {
  expect(DELIMITER.test("| --- | :-: | --: |")).toBe(true);
  expect(DELIMITER.test("---|---")).toBe(true);
  expect(DELIMITER.test("| Feld | Wert |")).toBe(false);
  expect(alignments("| :--- | :-: | --: | --- |")).toEqual(["left", "center", "right", null]);
});

test("a new table is valid GFM with its header", () => {
  expect(newTable(["A", "B"])).toBe("| A | B |\n| --- | --- |\n|  |  |");
});

describe("insertCell", () => {
  test("in front, between and behind, the other cells unchanged", () => {
    const row = "| a   | b |";
    expect(apply(row, insertCell(row, 0, "x"))).toBe("| x | a   | b |");
    expect(apply(row, insertCell(row, 1, "x"))).toBe("| a   | x | b |");
    expect(apply(row, insertCell(row, 2, "x"))).toBe("| a   | b | x |");
    expect(cells(apply(row, insertCell(row, 1)))).toEqual(["a", "", "b"]);
  });
  test("rows without pipes at the ends", () => {
    const row = "a | b";
    expect(cells(apply(row, insertCell(row, 0)))).toEqual(["", "a", "b"]);
    expect(cells(apply(row, insertCell(row, 2)))).toEqual(["a", "b", ""]);
    expect(apply("--- | ---", insertCell("--- | ---", 2, "---"))).toBe("--- | --- | ---");
  });
  test("a row shorter than the place stays", () => {
    expect(insertCell("| a |", 3)).toBeNull();
  });
});

describe("deleteCell", () => {
  test("each place, the rest unchanged", () => {
    const row = "| a | bb  | c |";
    expect(apply(row, deleteCell(row, 0))).toBe("| bb  | c |");
    expect(apply(row, deleteCell(row, 1))).toBe("| a | c |");
    expect(apply(row, deleteCell(row, 2))).toBe("| a | bb  |");
    expect(apply("a | b", deleteCell("a | b", 1))).toBe("| a |");
  });
  test("a row without that cell stays", () => {
    expect(deleteCell("| a |", 1)).toBeNull();
  });
});

test("a place in the shown text maps into the Markdown", () => {
  expect(sourceOffset("**fett** und `code`", "fett und code", 4)).toBe(6);
  expect(sourceOffset("**fett** und `code`", "fett und code", 0)).toBe(0);
  expect(sourceOffset("a ~~b~~ c", "a b c", 5)).toBe(9);
  expect(sourceOffset("[[Seite|Alias]]", "Alias", 5)).toBeLessThanOrEqual(15);
});

describe("tables in the rest of the app", () => {
  test("a link in a table cell escapes its | and still links", () => {
    expect(parseWikiLinks("| [[Seite\\|Alias]] | [[Andere#Teil\\|mehr]] |")).toEqual([
      { target: "Seite", embed: false, size: undefined, alias: "Alias" },
      { target: "Andere", embed: false, size: undefined, alias: "mehr" },
    ]);
    expect(renameLinksIn("| [[Seite\\|Alias]] |", "Seite", "Neu")).toBe("| [[Neu\\|Alias]] |");
    expect(parseWikiLinks("[[Seite|Alias]] [[Nur]]").map((l) => [l.target, l.alias])).toEqual([["Seite", "Alias"], ["Nur", undefined]]);
  });
  test("previews show a table's cells, not its pipes and dashes", () => {
    const body = "Vorweg.\n\n| Feld | Wert |\n| :--- | ---: |\n| **Typ** | [[Seite\\|Alias]] |\n| Zeile<br>zwei | `a \\| b` |";
    expect(plainText(body)).toBe("Vorweg. Feld · Wert Typ · Alias Zeile zwei · a | b");
  });
});

describe("tables without pipes at the ends", () => {
  test("a new row always has them, so its empty cells count", () => {
    expect(emptyRow(2)).toBe("|  |  |");
    expect(cells(emptyRow(2))).toEqual(["", ""]);
  });
  test("taking a column away leaves a row with pipes, not plain text", () => {
    expect(apply("a | b", deleteCell("a | b", 0))).toBe("| b |");
    expect(apply("--- | ---", deleteCell("--- | ---", 1))).toBe("| --- |");
    expect(apply("a | b | c", deleteCell("a | b | c", 0))).toBe("b | c");
  });
  test("a short row loses the cell too", () => {
    expect(apply("| one |", deleteCell("| one |", 0))).toBe("|  |");
    expect(apply("one", deleteCell("one", 0))).toBe("|  |");
  });
  test("previews", () => {
    expect(plainText("Name | Wert\n--- | ---\neins | zwei\n\nDanach a | b.")).toBe("Name · Wert eins · zwei Danach a | b.");
  });
});

test("a click after a <br> lands after it", () => {
  expect(sourceOffset("a<br>bar", "abar", 2)).toBe(6);
});

test("a <br> in code is text; a heading right after a table is no row of it", () => {
  expect(sourceOffset("`<br>` x", "<br> x", 2)).toBe(3);
  expect(sourceOffset("``<br>`` x", "<br> x", 2)).toBe(4);
  expect(sourceOffset("\\`a<br>b", "`ab", 3)).toBe(8);
  expect(plainText("a | b\n--- | ---\n1 | 2\n# Weiter a | b")).toBe("a · b 1 · 2 Weiter a | b");
});

test("a \\ before a letter stays a letter; a single ` in `` code is text", () => {
  expect(sourceOffset("C:\\Daten x", "C:\\Daten x", 8)).toBe(8);
  expect(sourceOffset("``a`b`` x", "a`b x", 3)).toBe(5);
});
