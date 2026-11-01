// Tables in the editor: a GFM table reads as a table (formatting, links, alignment, line breaks
// in cells), a click into a cell shows its Markdown with the cursor there, Tab and Enter move and
// add rows, "/Tabelle" inserts one, the right-click menu adds and removes columns, only the lines
// an edit is about change, and a long text with many tables draws only the ones on the screen.
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { commands } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { Repo } from "@obtion/sync";
import { Editor } from "../../packages/ui/src/ui/Editor";
import { renderMarkdown } from "../../packages/ui/src/ui/Markdown";
import { workspace } from "./workspace";

type EditorView = NonNullable<Parameters<NonNullable<Parameters<typeof Editor>[0]["onView"]>>[0]>;

const TABLE = [
  "| Feld | Pflicht | Beschreibung |",
  "| :--- | :-: | ---: |",
  "| **Rechnungsnummer** | ja | Eindeutig je `Absender`, siehe [[Kurs Datenbanken\\|den Kurs]] |",
  "| Zahlungsziel | ~~nein~~ | Tage nach [Beispiel](https://example.org)<br>oder ein Datum |",
  "| Trenner | nein | a \\| b |",
].join("\n");
const BODY = ["# Schnittstelle", "Vorweg ein Absatz.", "", TABLE, "", "Danach ein Absatz."].join("\n");

let repo: Repo;
beforeAll(async () => {
  repo = await workspace();
});
afterEach(() => cleanup());

async function open(body = BODY, width = 900) {
  const id = repo.create({ title: "Tabellen-Test" });
  repo.setBody(id, body);
  let view: EditorView | null = null;
  await render(
    <div style={{ padding: "40px 80px", width }}>
      <Editor doc={repo.getDoc(id)} nodeId={id} onView={(v) => (view = v)} />
    </div>,
  );
  await expect.poll(() => view && (!body.includes("| ---") || document.querySelector(".cm-table table"))).toBeTruthy();
  const v = view! as EditorView;
  return { view: v, doc: () => v.state.doc.toString() };
}

const rect = (el: Element) => el.getBoundingClientRect();
const cell = (text: string) => [...document.querySelectorAll<HTMLElement>(".cm-table th, .cm-table td")].find((c) => c.textContent === text)!;
const clickIn = (el: Element, at = 0.5) => commands.mouse("click", rect(el).left + rect(el).width * at, rect(el).top + rect(el).height / 2);
const srcLines = () => [...document.querySelectorAll<HTMLElement>(".cm-line.cm-tablesrc")].map((l) => l.textContent);
/** The cell the cursor is in, as "line:text of the cell" of the Markdown. */
const cursorCell = (view: EditorView) => {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const before = line.text.slice(0, head - line.from).replace(/\\\|/g, "  ");
  const i = before.split("|").length - 1;
  return `${line.number}:${line.text.replace(/\\\|/g, "  ").split("|")[i]!.trim()}`;
};

describe("a table reads as a table", () => {
  test("header, alignment, formatting and links in cells, line breaks, an escaped pipe", async () => {
    await open();
    const table = document.querySelector(".cm-table table")!;
    expect([...table.querySelectorAll("th")].map((c) => c.textContent)).toEqual(["Feld", "Pflicht", "Beschreibung"]);
    expect(table.querySelectorAll("tbody tr").length).toBe(3);
    expect(table.querySelector("td strong")?.textContent).toBe("Rechnungsnummer");
    expect(table.querySelector("td code")?.textContent).toBe("Absender");
    expect(table.querySelector("td del")?.textContent).toBe("nein");
    expect(table.querySelector("td a.wikilink")?.textContent, "a page link with its own text, its | escaped").toBe("den Kurs");
    expect(table.querySelector("td a[href='https://example.org']")?.textContent).toBe("Beispiel");
    expect(table.querySelector("td br"), "<br> breaks the line in a cell").not.toBeNull();
    expect(cell("a | b"), "an escaped pipe is one in the cell").toBeTruthy();
    expect(getComputedStyle(table.querySelectorAll("th")[1]!).textAlign).toBe("center");
    expect(getComputedStyle(table.querySelectorAll("th")[2]!).textAlign).toBe("right");
    expect(document.querySelector(".cm-content")!.textContent, "no Markdown of the table shows").not.toContain("| :---");
  });

  test("a wide table scrolls in its own box, the page stays as wide as before", async () => {
    const cols = 12;
    const wide = [`| ${Array.from({ length: cols }, (_, i) => `Spalte ${i + 1}`).join(" | ")} |`, `|${" --- |".repeat(cols)}`, `| ${Array.from({ length: cols }, () => "ein recht langer Zelleninhalt").join(" | ")} |`].join("\n");
    await open(`Text\n\n${wide}\n`, 420);
    const box = document.querySelector<HTMLElement>(".cm-table .md-table")!;
    expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);
    expect(rect(box).right).toBeLessThanOrEqual(rect(document.querySelector(".cm-content")!).right + 1);
  });
});

describe("editing", () => {
  test("a click into a cell shows the Markdown with the cursor in that cell", async () => {
    const { view } = await open();
    await clickIn(cell("Zahlungsziel"), 0.3);
    await expect.poll(() => srcLines().length).toBe(5);
    expect(cursorCell(view)).toBe("7:Zahlungsziel");
    // a click into formatted text lands in it too
    await commands.keys("press", "Control+End");
    await expect.poll(() => document.querySelector(".cm-table table")).not.toBeNull();
    await clickIn(cell("Rechnungsnummer"), 0.5);
    await expect.poll(() => srcLines().length).toBe(5);
    expect(cursorCell(view)).toBe("6:**Rechnungsnummer**");
    // leaving the table draws it again
    await commands.keys("press", "Control+End");
    await expect.poll(() => srcLines().length).toBe(0);
    expect(document.querySelector(".cm-table table")).not.toBeNull();
  });

  test("a click on a link opens it and keeps the table as it is", async () => {
    const { view } = await open();
    const link = document.querySelector<HTMLElement>(".cm-table a.wikilink")!;
    const head = view.state.selection.main.head;
    link.addEventListener("click", (e) => e.preventDefault(), { once: true });
    await clickIn(link);
    expect(srcLines().length).toBe(0);
    expect(view.state.selection.main.head).toBe(head);
  });

  test("Tab and Shift-Tab go from cell to cell, Tab in the last cell and Enter add rows, Enter in an empty last row ends the table", async () => {
    const { view, doc } = await open();
    await clickIn(cell("Feld"));
    await expect.poll(() => srcLines().length).toBe(5);
    await commands.keys("press", "Tab");
    expect(cursorCell(view)).toBe("4:Pflicht");
    await commands.keys("press", "Tab");
    await commands.keys("press", "Tab");
    expect(cursorCell(view), "past the header row: the first row below the delimiter").toBe("6:**Rechnungsnummer**");
    await commands.keys("press", "Shift+Tab");
    expect(cursorCell(view)).toBe("4:Beschreibung");
    // to the last cell, then on: a new row
    for (let i = 0; i < 9; i++) await commands.keys("press", "Tab");
    expect(cursorCell(view)).toBe("8:a | b".replace("a | b", "a    b"));
    await commands.keys("press", "Tab");
    expect(doc().split("\n")[8]).toBe("|  |  |  |");
    await commands.keys("type", "neu");
    expect(doc().split("\n")[8]).toBe("| neu |  |  |");
    await commands.keys("press", "Enter");
    expect(doc().split("\n")[9]).toBe("|  |  |  |");
    await commands.keys("press", "Enter");
    expect(doc()).toBe(BODY.replace(TABLE, TABLE + "\n| neu |  |  |\n\n"));
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(11);
  });

  test("Shift-Enter breaks the line within a cell", async () => {
    const { doc } = await open();
    await clickIn(cell("ja"), 0.9);
    await expect.poll(() => srcLines().length).toBe(5);
    await commands.keys("press", "End");
    await commands.keys("press", "Home");
    await commands.keys("press", "Tab");
    await commands.keys("press", "Shift+Enter");
    await commands.keys("type", "x");
    expect(doc().split("\n")[5]).toBe("| **Rechnungsnummer** | ja<br>x | Eindeutig je `Absender`, siehe [[Kurs Datenbanken\\|den Kurs]] |");
  });

  test('"/Tabelle" inserts a table, its first header cell selected', async () => {
    const { view, doc } = await open("Absatz\n\n");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();
    await commands.keys("type", "/Tabelle");
    await expect.poll(() => document.querySelector(".cm-tooltip-autocomplete [aria-selected]")?.textContent ?? "").toContain("Tabelle");
    await new Promise((r) => setTimeout(r, 300));
    await commands.keys("press", "Enter");
    expect(doc()).toBe("Absatz\n\n| Spalte 1 | Spalte 2 | Spalte 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n");
    const s = view.state.selection.main;
    expect(view.state.sliceDoc(s.from, s.to)).toBe("Spalte 1");
    await commands.keys("type", "Name");
    await commands.keys("press", "Control+End");
    await expect.poll(() => document.querySelector(".cm-table th")?.textContent).toBe("Name");
  });

  test("the right-click menu adds and takes away columns and rows, the other cells keep their spacing", async () => {
    const odd = ["| a   | b |", "|-----|---|", "| 1   | 2 |", "| 3   | 4 |"].join("\n");
    const { doc } = await open(`Text\n\n${odd}\n\nEnde`);
    const menu = async (text: string, entry: string) => {
      const c = rect(cell(text));
      await commands.mouse("click", c.left + c.width / 2, c.top + c.height / 2, { button: "right" });
      const row = [...document.querySelectorAll<HTMLElement>(".cm-menu .cm-menu-row")].find((r) => r.textContent === entry);
      expect(row, entry).toBeTruthy();
      row!.click();
      await commands.keys("press", "Control+End");
      await expect.poll(() => srcLines().length).toBe(0);
    };
    await menu("1", "Spalte rechts einfügen");
    expect(doc()).toBe(`Text\n\n${["| a   |  | b |", "|-----| --- |---|", "| 1   |  | 2 |", "| 3   |  | 4 |"].join("\n")}\n\nEnde`);
    await menu("b", "Spalte löschen");
    expect(doc()).toBe(`Text\n\n${["| a   |  |", "|-----| --- |", "| 1   |  |", "| 3   |  |"].join("\n")}\n\nEnde`);
    await menu("1", "Zeile darüber einfügen");
    expect(doc()).toBe(`Text\n\n${["| a   |  |", "|-----| --- |", "|  |  |", "| 1   |  |", "| 3   |  |"].join("\n")}\n\nEnde`);
    await menu("3", "Zeile löschen");
    expect(doc()).toBe(`Text\n\n${["| a   |  |", "|-----| --- |", "|  |  |", "| 1   |  |"].join("\n")}\n\nEnde`);
  });

  test("the grip moves the whole table as one block", async () => {
    const { view, doc } = await open();
    const { moveBy } = await import("../../packages/ui/src/ui/editor/blocks");
    moveBy(view, view.state.doc.line(4).from, 1);
    expect(doc()).toBe(["# Schnittstelle", "Vorweg ein Absatz.", "", "", TABLE, "Danach ein Absatz."].join("\n"));
  });
});

describe("long texts", () => {
  test("40 KB with dozens of tables: only those on the screen are drawn, typing stays quick", async () => {
    const section = (i: number) => [`## Abschnitt ${i}`, "", `Ein Absatz über Feld ${i}, mit etwas Text davor und danach.`, "", "| Feld | Typ | Pflicht | Beschreibung |", "| --- | --- | :-: | --- |", ...Array.from({ length: 6 }, (_, r) => `| Feld${i}_${r} | \`string\` | ja | Ein **längerer** Text für Zeile ${r}, mit [[Kurs Datenbanken]] und mehr |`), ""].join("\n");
    const body = Array.from({ length: 60 }, (_, i) => section(i)).join("\n");
    expect(body.length).toBeGreaterThan(40_000);
    const { view } = await open(body);
    const drawn = document.querySelectorAll(".cm-table").length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn, "tables below the screen are not drawn").toBeLessThan(20);
    view.dispatch({ selection: { anchor: view.state.doc.line(3).to } });
    view.focus();
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) view.dispatch(view.state.replaceSelection("x"));
    expect((performance.now() - t0) / 20, "ms per keystroke").toBeLessThan(25);
  });
});

test("read-only text renders tables the same way, in a box that scrolls sideways", () => {
  const div = document.createElement("div");
  div.className = "md";
  div.innerHTML = renderMarkdown(TABLE);
  expect(div.querySelector(".md-table > table")).not.toBeNull();
  expect(div.querySelector("td a.wikilink")?.textContent).toBe("den Kurs");
  expect(div.querySelector("td br")).not.toBeNull();
  expect(div.innerHTML).not.toContain("&lt;br&gt;");
  expect(renderMarkdown("<b>nein</b><br><script>x</script>")).not.toContain("<b>");
});
