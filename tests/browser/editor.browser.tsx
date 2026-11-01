// The Markdown editor on its own: hidden syntax, headings, the link menu, links by "/" and "@",
// the toolbar over selected blocks, moving blocks by their grip, and the "+" and grip hiding while typing.
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { commands } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { Repo } from "@obtion/sync";
import { Editor } from "../../packages/ui/src/ui/Editor";
import { toolbarExtract } from "../../packages/ui/src/ui/editor/toolbar";
import { pal } from "../../packages/ui/src/ui/item-look";
import { createType } from "../../packages/ui/src/actions";
import { workspace } from "./workspace";

type EditorView = NonNullable<Parameters<NonNullable<Parameters<typeof Editor>[0]["onView"]>>[0]>;

const BODY = ["# Überschrift", "Erster Absatz mit [[Kurs Datenbanken|dem Kurs]] darin.", "", "Zweiter mit [Beispiel](https://example.org).", "Dritter Absatz", "Vierter Absatz"].join("\n");

let repo: Repo;
beforeAll(async () => {
  repo = await workspace();
});
afterEach(() => cleanup());

/** An item with BODY, open in the editor once its text is parsed (CodeMirror parses in slices). */
async function open(extra: Parameters<typeof Editor>[0]["extra"] = []) {
  const id = repo.create({ title: "Editor-Test" });
  repo.setBody(id, BODY);
  let view: EditorView | null = null;
  await render(
    <div style={{ padding: "40px 80px", width: 900 }}>
      <Editor doc={repo.getDoc(id)} nodeId={id} onView={(v) => (view = v)} extra={extra} />
    </div>,
  );
  await expect.poll(() => view && document.querySelectorAll(".cm-content .cm-line").length).toBe(BODY.split("\n").length);
  await expect.poll(() => !!document.querySelector(".cm-line.cm-h1 ~ .cm-line .cm-wikilink") && !!document.querySelector(".cm-mdlink")).toBe(true);
  return { view: view! as EditorView, doc: () => (view as EditorView | null)!.state.doc.toString() };
}

const lineEls = () => [...document.querySelectorAll<HTMLElement>(".cm-content .cm-line")];
const lines = () => lineEls().map((l) => ({ text: l.innerText, top: Math.round(l.getBoundingClientRect().top), h: Math.round(l.getBoundingClientRect().height) }));
const rect = (el: Element) => el.getBoundingClientRect();
/** A click near the right end of a line (inside its text box). */
const clickEnd = (el: Element) => commands.mouse("click", rect(el).right - 4, rect(el).top + rect(el).height / 2);
const shown = () => document.querySelector(".cm-handles.shown") !== null;
/**
 * A completion list takes no click or Enter right after it opens or changes (CodeMirror's
 * interactionDelay, 75 ms), and its results may still come in after the first ones show.
 */
const pastInteractionDelay = () => new Promise((r) => setTimeout(r, 300));
const selected = () => document.querySelector(".cm-tooltip-autocomplete [aria-selected]")?.textContent ?? "";

describe("hidden syntax", () => {
  test("no # or link brackets show, also not when clicking into a line, and nothing moves", async () => {
    await open();
    const before = lines();
    const syntax = (t: string) => t.includes("#") || t.includes("[[") || t.includes("](");
    expect(syntax(before.map((l) => l.text).join("\n"))).toBe(false);
    for (let i = 0; i < before.length; i++) {
      await clickEnd(lineEls()[i]!);
      const now = lines();
      expect(now.map((l) => [l.top, l.h]), `line ${i + 1} clicked`).toEqual(before.map((l) => [l.top, l.h]));
      expect(syntax(now.map((l) => l.text.replace("/ für Blöcke, @ für einen Link auf eine Seite", "")).join("\n")), `line ${i + 1} clicked`).toBe(false);
    }
    expect(before[2]!.h, "an empty line is as high as a text line").toBe(before[4]!.h);
  });
});

describe("headings", () => {
  test("the # show at the start of the text and change the level there", async () => {
    const { doc } = await open();
    const h = rect(lineEls()[0]!);
    await commands.mouse("click", h.left + 60, h.top + h.height / 2);
    expect(lines()[0]!.text).not.toContain("#");
    await commands.keys("press", "Home");
    expect(lines()[0]!.text.startsWith("# Überschrift")).toBe(true);
    await commands.keys("press", "ArrowLeft");
    await commands.keys("type", "#");
    expect(doc().startsWith("## Überschrift\n")).toBe(true);
    expect(document.querySelector(".cm-line.cm-h2")).not.toBeNull();
    await commands.keys("press", "End");
    expect(lines()[0]!.text, "at its end they hide again").not.toContain("#");
    await commands.keys("press", "Home");
    await commands.keys("press", "Backspace");
    expect(doc().startsWith("# Überschrift\n"), "Backspace takes one level away").toBe(true);
    await commands.keys("press", "Backspace");
    expect(doc().startsWith("Überschrift\n"), "after the last one it is text").toBe(true);
    await commands.keys("type", "# ");
    expect(doc().startsWith("# Überschrift\n"), '"# " makes it a heading again').toBe(true);
  });
});

describe("links", () => {
  const rightClick = (selector: string) => {
    const r = rect(document.querySelector(selector)!);
    return commands.mouse("click", r.left + r.width / 2, r.top + r.height / 2, { button: "right" });
  };
  const choose = async (text: string) => {
    await expect.poll(() => [...document.querySelectorAll(".cm-menu-row")].some((r) => r.textContent?.includes(text))).toBe(true);
    const row = [...document.querySelectorAll<HTMLElement>(".cm-menu-row")].find((r) => r.textContent?.includes(text))!;
    await commands.mouse("click", rect(row).left + 10, rect(row).top + rect(row).height / 2);
  };

  test("the menu changes a link's text and target and takes the link away", async () => {
    const { doc } = await open();
    await rightClick(".cm-wikilink");
    await choose("Text ändern");
    const ask = document.querySelector<HTMLInputElement>(".cm-ask-input")!;
    ask.select();
    await commands.keys("type", "den Kurs DB");
    await commands.keys("press", "Enter");
    expect(doc()).toContain("[[Kurs Datenbanken|den Kurs DB]]");

    await rightClick(".cm-wikilink");
    await choose("Ziel ändern");
    await expect.poll(() => document.querySelector(".cm-toolbar-link input")).not.toBeNull();
    await commands.keys("type", "So funktioniert");
    await expect.poll(() => document.querySelector(".cm-toolbar-results .cm-menu-row.active")?.textContent ?? "").toContain("So funktioniert Obtion");
    await commands.keys("press", "Enter");
    expect(doc(), "the target changes, the text stays").toContain("[[So funktioniert Obtion|den Kurs DB]]");

    await rightClick(".cm-mdlink");
    await choose("Link entfernen");
    expect(doc(), "removing a link keeps its text").toContain("Zweiter mit Beispiel.");
  });

  test('"/Link" searches a page after an "@" and links it, shown without brackets', async () => {
    const { doc } = await open();
    await clickEnd(lineEls().at(-1)!);
    await commands.keys("press", "End");
    await commands.keys("type", " /Link");
    // chosen by keys, not by a click: the list may still move under the pointer
    await expect
      .poll(async () => {
        if (!selected().includes("Link auf Seite") && document.querySelector(".cm-tooltip-autocomplete")) await commands.keys("press", "ArrowDown");
        return selected();
      }, { interval: 100 })
      .toContain("Link auf Seite");
    await pastInteractionDelay();
    await commands.keys("press", "Enter");
    await expect.poll(doc).toMatch(/ @$/);
    await commands.keys("type", "So funkt");
    expect(lines().at(-1)!.text.endsWith("@So funkt")).toBe(true);
    await expect.poll(selected).toContain("So funktioniert Obtion");
    await pastInteractionDelay();
    await commands.keys("press", "Enter");
    expect(doc().endsWith("Vierter Absatz [[So funktioniert Obtion]]")).toBe(true);
    expect(lines().at(-1)!.text).toBe("Vierter Absatz So funktioniert Obtion");
  });
});

test('"/Trennlinie" right under a line of text draws a line and keeps the text as it was', async () => {
  const { doc } = await open();
  await clickEnd(lineEls().at(-1)!);
  await commands.keys("press", "End");
  await commands.keys("press", "Enter");
  await commands.keys("type", "/Trennlinie");
  await expect.poll(selected).toContain("Trennlinie");
  await pastInteractionDelay();
  await commands.keys("press", "Enter");
  await expect.poll(() => document.querySelectorAll(".cm-rule").length).toBe(1);
  const above = lineEls().find((l) => l.innerText.includes("Vierter"))!;
  expect(above.classList.contains("cm-h"), "the text above stays a paragraph").toBe(false);
  expect(above.innerText).toBe("Vierter Absatz");
  expect(doc().split("\n").slice(5, 7)).toEqual(["Vierter Absatz", "***"]);
});

describe("the toolbar over selected text", () => {
  const toolbar = () => document.querySelector<HTMLElement>(".cm-toolbar.shown");
  const button = (cls: string) => document.querySelector<HTMLElement>(".cm-toolbar.shown " + cls)!;
  /** A click in the middle of an element, once the toolbar has moved to its place (a frame after a change). */
  const press = async (el: Element) => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await commands.mouse("click", rect(el).left + rect(el).width / 2, rect(el).top + rect(el).height / 2);
  };
  /** The toolbar shown at its place for the selection (it moves a frame after the selection changes). */
  const settled = async () => {
    await expect.poll(toolbar).not.toBeNull();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  };
  /** Drag from the start of line `a` to the end of line `b`. */
  async function select(a: number, b: number) {
    const s = rect(lineEls()[a]!);
    const e = rect(lineEls()[b]!);
    await commands.mouse("move", s.left + 1, s.top + s.height / 2);
    await commands.mouse("down");
    await commands.mouse("move", e.right - 2, e.top + e.height / 2, { steps: 6 });
    await commands.mouse("up");
    await expect.poll(toolbar, { message: "the toolbar shows over the selection" }).not.toBeNull();
  }

  test("over several blocks it shows; Turn into opens below it, the bar stays, and changes all blocks", async () => {
    const { doc } = await open();
    await select(4, 5);
    expect(button(".kind").textContent).toBe("Text");
    expect(button(".cm-tb[aria-label^='Link']").offsetParent, "no link over several blocks").toBeNull();
    const bar = rect(toolbar()!);
    await press(button(".kind"));
    await expect.poll(() => document.querySelector(".cm-menu")).not.toBeNull();
    expect(toolbar(), "the bar stays while the menu is open").not.toBeNull();
    expect(rect(document.querySelector(".cm-menu")!).top, "the menu opens below the bar").toBeGreaterThanOrEqual(bar.bottom);
    const row = [...document.querySelectorAll<HTMLElement>(".cm-menu-row")].find((r) => r.textContent === "Überschrift 2")!;
    await press(row);
    expect(doc().split("\n").slice(4)).toEqual(["## Dritter Absatz", "## Vierter Absatz"]);
    await expect.poll(() => toolbar() && button(".kind").textContent, { message: "the selection and the bar stay" }).toBe("Überschrift 2");

    await press(button(".kind"));
    await expect.poll(() => document.querySelector(".cm-menu")).not.toBeNull();
    await commands.keys("press", "Escape");
    await expect.poll(() => document.querySelector(".cm-menu")).toBeNull();
    expect(toolbar(), "Escape closes the menu, not the bar").not.toBeNull();
  });

  test("bold over several blocks marks each block's text, and takes it away again", async () => {
    const { doc } = await open();
    await select(3, 5);
    await press(button(".cm-tb[aria-label^='Fett']"));
    expect(doc().split("\n").slice(3)).toEqual(["**Zweiter mit [Beispiel](https://example.org).**", "**Dritter Absatz**", "**Vierter Absatz**"]);
    await press(button(".cm-tb[aria-label^='Fett']"));
    expect(doc()).toBe(BODY);
  });

  test("bold and strikethrough toggle on and off, also together and in any order", async () => {
    const { view, doc } = await open();
    const line = () => doc().split("\n")[4];
    await select(4, 4);
    const bold = () => press(button(".cm-tb[aria-label^='Fett']"));
    const strike = () => press(button(".cm-tb[aria-label^='Durch']"));
    await bold();
    expect(line()).toBe("**Dritter Absatz**");
    await bold();
    expect(line(), "a second click takes bold away").toBe("Dritter Absatz");
    await strike();
    expect(line()).toBe("~~Dritter Absatz~~");
    await strike();
    expect(line(), "a second click takes strikethrough away").toBe("Dritter Absatz");
    await bold();
    await strike();
    expect(line()).toBe("**~~Dritter Absatz~~**");
    await bold();
    expect(line(), "bold goes from under strikethrough").toBe("~~Dritter Absatz~~");
    await bold();
    await strike();
    expect(line(), "strikethrough goes from under bold").toBe("**Dritter Absatz**");
    await bold();
    expect(line()).toBe("Dritter Absatz");
    // italic beside bold: "*" is not one star of "**"
    view.dispatch({ changes: { from: view.state.doc.line(5).from, to: view.state.doc.line(5).to, insert: "***Dritter Absatz***" } });
    view.dispatch({ selection: { anchor: view.state.doc.line(5).from + 3, head: view.state.doc.line(5).to - 3 } });
    await settled();
    await press(button(".cm-tb[aria-label^='Kursiv']"));
    expect(line(), "italic goes, bold stays").toBe("**Dritter Absatz**");
    await press(button(".cm-tb[aria-label^='Kursiv']"));
    expect(line()).toBe("***Dritter Absatz***");
    await bold();
    expect(line(), "bold goes, italic stays").toBe("*Dritter Absatz*");
  });

  test("over several blocks too, bold toggles under strikethrough", async () => {
    const { view, doc } = await open();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "~~**eins**~~\n~~zwei~~" } });
    view.focus();
    view.dispatch({ selection: { anchor: 4, head: view.state.doc.length } });
    await settled();
    await press(button(".cm-tb[aria-label^='Fett']"));
    expect(doc(), "one block without bold: bold is added there").toBe("~~**eins**~~\n**~~zwei~~**");
    await press(button(".cm-tb[aria-label^='Fett']"));
    expect(doc()).toBe("~~eins~~\n~~zwei~~");
  });

  test("the marks may lie partly inside the selection", async () => {
    const { view, doc } = await open();
    const toggle = async (text: string, from: number, to: number, label: string) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: from, head: to } });
      view.focus();
      await settled();
      await press(button(`.cm-tb[aria-label^='${label}']`));
      return doc();
    };
    expect(await toggle("**x**", 0, 3, "Fett")).toBe("x");
    expect(await toggle("~~**x**~~", 0, 5, "Fett")).toBe("~~x~~");
    expect(await toggle("~~**x**~~", 0, 5, "Durch")).toBe("**x**");
    expect(await toggle("**~~x~~** y", 2, 9, "Fett")).toBe("~~x~~ y");
  });

  test("a mark put across the edge of another one nests with it, piece by piece", async () => {
    const { view, doc } = await open();
    const pressed = () => button(".cm-tb[aria-label^='Fett']").getAttribute("aria-pressed");
    const bold = async (text: string, from: number, to: number) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: from, head: to } });
      view.focus();
      await settled();
      await press(button(".cm-tb[aria-label^='Fett']"));
      return doc();
    };
    expect(await bold("~~x~~ y", 2, 7)).toBe("~~**x**~~ **y**");
    expect(pressed(), "all of it bold now").toBe("true");
    expect(await bold("~~**x**~~ y", 4, 11), "bold already there merges").toBe("~~**x**~~ **y**");
    expect(await bold("~~abc~~ y", 4, 9), "only the selected letters").toBe("~~ab**c**~~ **y**");
    expect(await bold("a ~~x~~", 0, 5)).toBe("**a** ~~**x**~~");
    expect(await bold("~~x~~ y", 0, 3), "from the very start of the struck span").toBe("~~**x**~~ y");
    expect(await bold("~~x~~ y", 1, 3), "from within its marks").toBe("~~**x**~~ y");
    expect(await bold("y ~~x~~", 4, 7), "to its very end").toBe("y ~~**x**~~");
    expect(await bold("**one\ntwo** x", 0, 13), "a span over two lines: each line its own pair").toBe("**one**\n**two x**");
  });

  test("bold, italic, strikethrough and code show pressed while all of the selected text has them", async () => {
    const { view, doc } = await open();
    const pressed = () => ["Fett", "Kursiv", "Durch", "Code"].filter((l) => button(`.cm-tb[aria-label^='${l}']`).getAttribute("aria-pressed") === "true");
    const choose = async (text: string, from: number, to: number) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: from, head: to } });
      view.focus();
      await settled();
    };
    await select(4, 4);
    expect(pressed()).toEqual([]);
    await press(button(".cm-tb[aria-label^='Fett']"));
    expect(pressed(), "a click presses it").toEqual(["Fett"]);
    await press(button(".cm-tb[aria-label^='Durch']"));
    expect(pressed()).toEqual(["Fett", "Durch"]);
    await press(button(".cm-tb[aria-label^='Fett']"));
    expect(pressed(), "and releases it").toEqual(["Durch"]);

    await choose("**eins** zwei", 2, 13);
    expect(pressed(), "only part of it bold: not pressed").toEqual([]);
    await press(button(".cm-tb[aria-label^='Fett']"));
    expect(doc(), "a click makes all of it bold").toBe("**eins zwei**");
    expect(pressed()).toEqual(["Fett"]);

    await choose("**ein Satz in fett**", 6, 10);
    expect(pressed(), "a word in a bold sentence is bold").toEqual(["Fett"]);
    await choose("***x***", 3, 4);
    expect(pressed(), "bold and italic").toEqual(["Fett", "Kursiv"]);
    await choose("**x**", 2, 3);
    expect(pressed(), "bold is not italic").toEqual(["Fett"]);
    await choose("`code` und ~~weg~~", 0, 18);
    expect(pressed(), "mixed marks: none pressed").toEqual([]);
    await choose("**eins**\n**zwei**", 2, 15);
    expect(pressed(), "over blocks, all bold").toEqual(["Fett"]);
    await choose("**eins**\nzwei", 2, 13);
    expect(pressed(), "over blocks, one not bold").toEqual([]);
  });

  test("⌘B without a selection puts an empty pair, a second ⌘B takes it away", async () => {
    const { view, doc } = await open();
    await clickEnd(lineEls()[5]!);
    await commands.keys("press", "End");
    await commands.keys("press", "Control+b");
    expect(doc().endsWith("Vierter Absatz****")).toBe(true);
    await commands.keys("press", "Control+b");
    expect(doc().endsWith("Vierter Absatz")).toBe(true);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  test("bold over several bold blocks takes the hidden marks around the selection away", async () => {
    const { view, doc } = await open();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "**eins**\n**zwei**" } });
    view.focus();
    view.dispatch({ selection: { anchor: 2, head: 15 } });
    await settled();
    await press(button(".cm-tb[aria-label^='Fett']"));
    expect(doc()).toBe("eins\nzwei");
  });

  test("on a page, Extract at the right end opens all types below the bar and extracts as the chosen one", async () => {
    const { doc } = await open([toolbarExtract.of(true)]);
    await select(4, 5);
    const extract = button(".extract");
    expect(extract.textContent).toBe("Herauslösen");
    expect([...document.querySelectorAll(".cm-toolbar.shown .cm-tb")].filter((b) => (b as HTMLElement).offsetParent).at(-1), "the last button").toBe(extract);
    const bar = rect(toolbar()!);
    await press(extract);
    await expect.poll(() => document.querySelector(".cm-menu")).not.toBeNull();
    expect(toolbar(), "the bar stays while the menu is open").not.toBeNull();
    expect(rect(document.querySelector(".cm-menu")!).top, "the menu opens below the bar").toBeGreaterThanOrEqual(bar.bottom);
    const names = [...document.querySelectorAll(".cm-menu-row")].map((r) => r.textContent);
    expect(names).toEqual(repo.index().typesInOrder().map((t) => t.schema.name));
    const icons = [...document.querySelectorAll<HTMLElement>(".cm-menu-row .cm-menu-icon")].map((i) => getComputedStyle(i).color);
    expect(icons, "each icon in its type's colour, as in the sidebar").toEqual(repo.index().typesInOrder().map((t) => getComputedStyle(Object.assign(document.body.appendChild(document.createElement("i")), { style: `color: ${pal(t.schema.color)}` })).color));
    const project = repo.index().typeByName("Projekt")!;
    await press([...document.querySelectorAll<HTMLElement>(".cm-menu-row")].find((r) => r.textContent === "Projekt")!);
    expect(doc().split("\n").slice(4)).toEqual(["[[Dritter Absatz]]"]);
    const id = repo.index().resolveTitle("Dritter Absatz")!;
    expect(repo.get(id)?.type).toBe(project);
    expect(repo.get(id)?.body).toBe("Dritter Absatz\nVierter Absatz");
  });

  test("with many types the list scrolls inside the menu after ten", async () => {
    for (let i = 1; i <= 12; i++) createType(`Typ ${i}`, repo);
    await open([toolbarExtract.of(true)]);
    await select(4, 5);
    await press(button(".extract"));
    await expect.poll(() => document.querySelector(".cm-menu")).not.toBeNull();
    const menu = document.querySelector<HTMLElement>(".cm-menu")!;
    const rows = [...menu.querySelectorAll<HTMLElement>(".cm-menu-row")];
    expect(rows.length).toBe(repo.index().typesInOrder().length);
    expect(menu.scrollHeight, "the list is longer than the menu").toBeGreaterThan(menu.clientHeight);
    expect(rect(rows[9]!).bottom, "ten rows show").toBeLessThanOrEqual(rect(menu).bottom);
    expect(rect(rows[10]!).top, "the eleventh shows in part").toBeLessThan(rect(menu).bottom);
    expect(rect(rows[10]!).bottom).toBeGreaterThan(rect(menu).bottom);
    expect(rect(menu).bottom).toBeLessThanOrEqual(innerHeight);
  });

  test("without a page it offers no extracting", async () => {
    await open();
    await select(4, 4);
    expect(button(".extract").offsetParent).toBeNull();
  });
});

describe("moving blocks by the grip", () => {
  /** Drags line `from` by its grip to `toY` of line `at`; where the drop line showed. */
  async function drag(from: number, at: number, part: number) {
    const r = rect(lineEls()[from]!);
    await commands.mouse("move", r.left + 20, r.top + r.height / 2);
    await expect.poll(() => document.querySelector(".cm-handles.shown .grip")).not.toBeNull();
    const g = rect(document.querySelector(".cm-handles.shown .grip")!);
    await commands.mouse("move", g.left + g.width / 2, g.top + g.height / 2);
    await commands.mouse("down");
    const t = rect(lineEls()[at]!);
    await commands.mouse("move", g.left + 40, t.top + t.height * part, { steps: 8 });
    const line = Math.round(rect(document.querySelector(".cm-drop")!).top);
    await commands.mouse("up");
    return { line, r, t };
  }
  const order = (doc: string) => doc.split("\n").filter((l) => /Absatz/.test(l) && !l.startsWith("Erster"));

  test("just below itself it stays, onto the next block the two swap", async () => {
    const { doc } = await open();
    const start = order(doc());
    const a = await drag(4, 4, 0.75);
    expect(Math.abs(a.line - a.r.top), "over its own lower half the line stays above it").toBeLessThanOrEqual(3);
    expect(order(doc())).toEqual(start);
    const b = await drag(4, 5, 0.25);
    expect(Math.abs(b.line - b.t.bottom), "over the next block the line is below it").toBeLessThanOrEqual(3);
    await expect.poll(() => order(doc())).toEqual([start[1], start[0]]);
  });
});

describe("handles while typing", () => {
  test('typing hides "+" and the grip at once, until the pointer moves; arrow keys too', async () => {
    await open();
    const tb = rect(lineEls()[1]!);
    await commands.mouse("move", tb.left + 30, tb.top + tb.height / 2);
    await commands.mouse("click", tb.right - 4, tb.top + tb.height / 2);
    await expect.poll(shown, { message: "the handles show under the pointer" }).toBe(true);
    await commands.keys("press", "End");
    await commands.keys("press", "Enter");
    await commands.keys("type", "N");
    expect(getComputedStyle(document.querySelector(".cm-handles")!).opacity, "hidden at once, without fading").toBe("0");
    await commands.keys("type", "eue Zeile");
    await expect.poll(shown).toBe(false);
    await commands.mouse("move", tb.left + 40, tb.top + tb.height / 2);
    await expect.poll(shown, { message: "moving the pointer shows them again" }).toBe(true);
    await commands.keys("press", "ArrowUp");
    await expect.poll(shown, { message: "moving the cursor with the keys hides them too" }).toBe(false);
  });
});

test("select all and typing replaces the whole text, the heading's # too", async () => {
  const { doc } = await open();
  await clickEnd(lineEls()[1]!);
  await commands.keys("press", "Control+a");
  await commands.keys("type", "Neu");
  expect(doc()).toBe("Neu");
});
