// Browser check of the editor's quiet Markdown: clicking around a page moves nothing (empty
// lines, headings, links keep their height and width), "#" and link brackets never show, a link's
// menu changes its text and target or takes it away, and a block dragged just below itself stays
// put while one dragged onto the next block swaps with it.
//   bun run build && bun tests/e2e/editor.ts        (Chrome from ~/.cache/ms-playwright)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Page, chromium } from "playwright-core";

const ROOT = resolve(import.meta.dir, "../..");
const failures: string[] = [];
const expect = (ok: boolean, what: string) => (ok ? console.log("ok  " + what) : (failures.push(what), console.log("FAIL " + what)));

const port = await new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => res(p));
  });
});
const dir = mkdtempSync(join(tmpdir(), "obtion-editor-"));
const env = { ...process.env, OBTION_DATA: dir, PORT: String(port), HOST: "127.0.0.1" };
Bun.spawnSync(["bun", "apps/server/src/cli.ts", "setup", "de", "--examples"], { cwd: ROOT, env });
const proc = Bun.spawn(["bun", "apps/server/src/index.ts"], { cwd: ROOT, env, stdout: "ignore", stderr: "inherit" });
const url = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100 && !(await fetch(url + "/api/info").then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
const signup = (await fetch(url + "/api/account/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "E2E", email: "e2e@example.org", password: "geheim12345", lang: "de" }) }).then((r) => r.json())) as { token: string };
const me = (await fetch(url + "/api/account", { headers: { authorization: `Bearer ${signup.token}` } }).then((r) => r.json())) as { user: unknown; workspaces: { id: string }[] };
const token = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).token as string;
const body = ["# Überschrift", "Erster Absatz mit [[Kurs Datenbanken|dem Kurs]] darin.", "", "Zweiter mit [Beispiel](https://example.org).", "Dritter Absatz", "Vierter Absatz"].join("\n");
const created = await fetch(url + "/mcp", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create", arguments: { items: [{ title: "Editor-Test", body }] } } }),
}).then((r) => r.json() as Promise<any>);
const id = /\[([\w-]+)\]/.exec(created.result.content[0].text)![1]!;

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

  // typing at the start of the heading keeps it a heading; Home + typing too
  const h = (await page.$$(".cm-content .cm-line"))[0]!;
  const hr = (await h.boundingBox())!;
  await page.mouse.click(hr.x + 1, hr.y + hr.height / 2);
  await page.keyboard.press("Home");
  await page.keyboard.type("X");
  expect((await doc(page)).startsWith("# XÜberschrift"), "typing at the start of a heading writes into it: " + JSON.stringify((await doc(page)).split("\n")[0]));
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  expect((await doc(page)).startsWith("Überschrift\n"), "Backspace at its start turns the heading into text");
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
  await page.waitForTimeout(200);
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
  await page.waitForSelector(".cm-tooltip-autocomplete");
  await page.keyboard.press("Enter");
  await page.keyboard.type("So funkt");
  await page.waitForTimeout(300);
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
    await page.waitForTimeout(100);
    const grip = (await page.$(".cm-handles.shown .grip"))!;
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
} catch (e) {
  failures.push(String(e));
}
for (const e of errors) failures.push("page error: " + e);
await browser.close();
proc.kill();
rmSync(dir, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failed:\n` + failures.join("\n") : "\nall passed");
process.exit(failures.length ? 1 : 0);
