// The Markdown editor on its own: hidden syntax, headings, the link menu, links by "/" and "@",
// moving blocks by their grip, and the "+" and grip hiding while typing.
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { commands } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { Repo } from "@obtion/sync";
import { Editor } from "../../packages/ui/src/ui/Editor";
import { workspace } from "./workspace";

type EditorView = NonNullable<Parameters<NonNullable<Parameters<typeof Editor>[0]["onView"]>>[0]>;

const BODY = ["# Überschrift", "Erster Absatz mit [[Kurs Datenbanken|dem Kurs]] darin.", "", "Zweiter mit [Beispiel](https://example.org).", "Dritter Absatz", "Vierter Absatz"].join("\n");

let repo: Repo;
beforeAll(async () => {
  repo = await workspace();
});
afterEach(() => cleanup());

/** An item with BODY, open in the editor once its text is parsed (CodeMirror parses in slices). */
async function open() {
  const id = repo.create({ title: "Editor-Test" });
  repo.setBody(id, BODY);
  let view: EditorView | null = null;
  await render(
    <div style={{ padding: "40px 80px", width: 900 }}>
      <Editor doc={repo.getDoc(id)} nodeId={id} onView={(v) => (view = v)} />
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
