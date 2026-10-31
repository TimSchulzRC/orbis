// Browser check of the editor's quiet Markdown: clicking around a page moves nothing (empty
// lines, headings, links keep their height and width), link brackets never show, a heading's "#"
// only with the cursor at the start of its text, a link's menu changes its text and target or
// takes it away, and a block dragged just below itself stays put while one dragged onto the next
// block swaps with it.
//   bun run test:e2e:editor        (builds first; Chrome from ~/.cache/ms-playwright)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, chromium } from "playwright-core";
import { bootServer, firstAccount, mcpTool, seedExamples } from "../support/server";

const failures: string[] = [];
const expect = (ok: boolean, what: string) => (ok ? console.log("ok  " + what) : (failures.push(what), console.log("FAIL " + what)));

const dir = mkdtempSync(join(tmpdir(), "obtion-editor-"));
await seedExamples({ ...process.env, OBTION_DATA: dir });
const { url, proc } = await bootServer({ OBTION_DATA: dir }, "inherit");
const signup = await firstAccount(url);
const me = signup.me;
const token = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).token as string;
const body = ["# Überschrift", "Erster Absatz mit [[Kurs Datenbanken|dem Kurs]] darin.", "", "Zweiter mit [Beispiel](https://example.org).", "Dritter Absatz", "Vierter Absatz"].join("\n");
const id = /\[([\w-]+)\]/.exec(await mcpTool(url, token, "create", { items: [{ title: "Editor-Test", body }] }))![1]!;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: url, viewport: { width: 1280, height: 900 }, locale: "de-DE" });
await context.addInitScript(
  ({ account, spaces }) => {
    if (localStorage.getItem("obtion.account")) return;
    localStorage.setItem("obtion.account", JSON.stringify(account));
    localStorage.setItem("obtion.spaces", JSON.stringify(spaces));
    localStorage.setItem("obtion.active", spaces[0]!.id);
  },
  { account: { token: signup.token, user: me.user }, spaces: me.workspaces },
);
const page = await context.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));

const lines = (p: Page) => p.$$eval(".cm-content .cm-line", (ls) => ls.map((l) => ({ text: (l as HTMLElement).innerText, top: Math.round(l.getBoundingClientRect().top), h: Math.round(l.getBoundingClientRect().height), w: Math.round(l.getBoundingClientRect().width) })));
const doc = (p: Page) => p.$eval(".cm-content", (el) => ((el as any).cmTile.root.view.state.doc.toString() as string));
const same = (a: { top: number; h: number }[], b: { top: number; h: number }[]) => a.length === b.length && a.every((l, i) => l.top === b[i]!.top && l.h === b[i]!.h);
/** Whether the selector matches (or, with `false`, stops matching) within a second. */
const shows = (selector: string, want = true) => page.waitForSelector(selector, { state: want ? "attached" : "detached", timeout: 1000 }).then(() => true, () => false);

try {
  await page.goto(`/#/i/${id}`);
  await page.waitForSelector(".cm-content .cm-line");
  await page.waitForTimeout(500);
  const before = await lines(page);
  const text = before.map((l) => l.text).join("\n");
  expect(!text.includes("#") && !text.includes("[[") && !text.includes("]("), "no # or link brackets before clicking: " + JSON.stringify(text));

  // click into every line: nothing moves, no syntax appears
  for (let i = 0; i < before.length; i++) {
    const box = (await page.$$(".cm-content .cm-line"))[i]!;
    const r = (await box.boundingBox())!;
    await page.mouse.click(r.x + r.width - 4, r.y + r.height / 2);
    await page.waitForTimeout(120);
    const now = await lines(page);
    const shown = now.map((l) => l.text.replace("/ für Blöcke, @ für einen Link auf eine Seite", "")).join("\n");
    expect(same(before, now), `line ${i + 1} clicked: no line moved or changed height`);
    expect(!shown.includes("#") && !shown.includes("[[") && !shown.includes("]("), `line ${i + 1} clicked: no # or brackets`);
  }
  const blank = before[2]!;
  expect(blank.h === before[4]!.h, `an empty line is as high as a text line (${blank.h} vs ${before[4]!.h})`);

  // a heading's "#" show only with the cursor at the start of its text
  const head = () => page.$eval(".cm-content", (el) => (el as any).cmTile.root.view.state.selection.main.head as number);
  const h = (await page.$$(".cm-content .cm-line"))[0]!;
  const hr = (await h.boundingBox())!;
  await page.mouse.click(hr.x + 60, hr.y + hr.height / 2);
  expect(!(await lines(page))[0]!.text.includes("#"), "clicked into a heading, its # stay hidden");
  await page.keyboard.press("Home");
  expect((await lines(page))[0]!.text.startsWith("# Überschrift"), "at the start of its text they show");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("#");
  expect((await doc(page)).startsWith("## Überschrift\n") && !!(await page.$(".cm-line.cm-h2")), "typing a # there makes it a level deeper");
  await page.keyboard.press("End");
  expect(!(await lines(page))[0]!.text.includes("#"), "at its end they hide again");
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  expect((await doc(page)).startsWith("# Überschrift\n"), "Backspace at the start of the text takes one level away");
  await page.keyboard.press("Backspace");
  expect((await doc(page)).startsWith("Überschrift\n"), "and after the last one it is text");
  await page.keyboard.type("# ");
  expect((await doc(page)).startsWith("# Überschrift\n"), "\"# \" makes it a heading again");

  // the link's menu: change the text, the target, take the link away
  await page.click(".cm-wikilink", { button: "right" });
  await page.click(".cm-menu-row:has-text('Text ändern')");
  await page.fill(".cm-ask-input", "den Kurs DB");
  await page.keyboard.press("Enter");
  expect((await doc(page)).includes("[[Kurs Datenbanken|den Kurs DB]]"), "the link's text changes");
  await page.click(".cm-wikilink", { button: "right" });
  await page.click(".cm-menu-row:has-text('Ziel ändern')");
  await page.fill(".cm-toolbar-link input", "So funktioniert");
  await page.waitForSelector(".cm-toolbar-results .cm-menu-row.active:has-text('So funktioniert Obtion')");
  await page.keyboard.press("Enter");
  const d1 = await doc(page);
  expect(d1.includes("[[So funktioniert Obtion|den Kurs DB]]"), "the link's target changes and its text stays: " + JSON.stringify(d1.split("\n")[1]));
  await page.click(".cm-mdlink", { button: "right" });
  await page.click(".cm-menu-row:has-text('Link entfernen')");
  expect((await doc(page)).includes("Zweiter mit Beispiel."), "removing a link keeps its text");

  // "/Link" searches with "@": no brackets while choosing, a link after it
  const last = (await page.$$(".cm-content .cm-line")).at(-1)!;
  const lr = (await last.boundingBox())!;
  await page.mouse.click(lr.x + lr.width - 4, lr.y + lr.height / 2);
  await page.keyboard.press("End");
  await page.keyboard.type(" /Link");
  await page.click(".cm-tooltip-autocomplete li:has-text('Link auf Seite')");
  await page.waitForFunction(() => (document.querySelector(".cm-content") as any).cmTile.root.view.state.doc.toString().endsWith(" @"));
  await page.keyboard.type("So funkt");
  await page.waitForTimeout(300); // the completion ignores Enter right after it opens (interactionDelay)
  const typed = (await lines(page)).at(-1)!.text;
  expect(typed.endsWith("@So funkt"), "the page is searched after an @: " + JSON.stringify(typed));
  await page.keyboard.press("Enter");
  const d2 = await doc(page);
  expect(d2.endsWith("Vierter Absatz [[So funktioniert Obtion]]"), "and becomes a link: " + JSON.stringify(d2.split("\n").at(-1)));
  expect((await lines(page)).at(-1)!.text === "Vierter Absatz So funktioniert Obtion", "shown without brackets");

  // drag: just below itself is still its own place; onto the next block swaps them
  const drag = async (from: number, toY: (r: { y: number; height: number }) => number, at: number) => {
    const ls = await page.$$(".cm-content .cm-line");
    const r = (await ls[from]!.boundingBox())!;
    await page.mouse.move(r.x + 20, r.y + r.height / 2);
    const grip = (await page.waitForSelector(".cm-handles.shown .grip"))!;
    const g = (await grip.boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    const t = (await ls[at]!.boundingBox())!;
    await page.mouse.move(g.x + 40, toY(t), { steps: 8 });
    const line = await page.$eval(".cm-drop", (d) => Math.round(d.getBoundingClientRect().top));
    await page.mouse.up();
    await page.waitForTimeout(150);
    return { line, r, t };
  };
  const order = async () => (await doc(page)).split("\n").filter((l) => /Absatz/.test(l) && !l.startsWith("Erster"));
  const start = await order();
  const a = await drag(4, (t) => t.y + t.height * 0.75, 4); // lower half of itself
  expect(Math.abs(a.line - a.r.y) <= 3, `over its own lower half the line stays above the block (${a.line} vs ${Math.round(a.r.y)})`);
  expect(JSON.stringify(await order()) === JSON.stringify(start), "dropped there it stays");
  const b = await drag(4, (t) => t.y + t.height * 0.25, 5); // upper half of the next block
  expect(Math.abs(b.line - (b.t.y + b.t.height)) <= 3, `over the next block the line is below it (${b.line} vs ${Math.round(b.t.y + b.t.height)})`);
  expect(JSON.stringify(await order()) === JSON.stringify([start[1], start[0]]), "dropped there the two swap: " + JSON.stringify(await order()));
  await page.screenshot({ path: join(tmpdir(), "obtion-editor.png") });

  // typing hides "+" and "⠿" until the pointer moves again
  const tl = (await page.$$(".cm-content .cm-line"))[1]!;
  const tb = (await tl.boundingBox())!;
  await page.mouse.move(tb.x + 30, tb.y + tb.height / 2);
  await page.mouse.click(tb.x + tb.width - 4, tb.y + tb.height / 2);
  expect(await shows(".cm-handles.shown"), "the handles show under the pointer");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("N");
  expect((await page.$eval(".cm-handles", (b) => getComputedStyle(b).opacity)) === "0", "typing hides the handles at once, without fading");
  await page.keyboard.type("eue Zeile");
  expect(await shows(".cm-handles.shown", false), "typing hides the handles");
  await page.mouse.move(tb.x + 40, tb.y + tb.height / 2);
  expect(await shows(".cm-handles.shown"), "moving the pointer shows them again");
  await page.keyboard.press("ArrowUp");
  expect(await shows(".cm-handles.shown", false), "moving the cursor with the keys hides them too");
  await page.mouse.move(tb.x + 30, tb.y + tb.height / 2);
  await page.waitForTimeout(100);

  // selecting everything and typing replaces everything, the heading's "# " too
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Neu");
  expect((await doc(page)) === "Neu", "select all and typing replaces the whole text: " + JSON.stringify(await doc(page)));
} catch (e) {
  failures.push(String(e));
}
for (const e of errors) failures.push("page error: " + e);
await browser.close();
proc.kill();
rmSync(dir, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed:\n` + failures.join("\n") : "\nall passed");
process.exit(failures.length ? 1 : 0);
