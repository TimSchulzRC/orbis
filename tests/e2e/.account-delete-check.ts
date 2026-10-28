// Browser smoke test: starts an empty server, one filled with the examples of the setup (the
// server's "setup --examples", plus a file and an item in the trash) and the same data with every type deleted (the app runs
// with zero types) on free ports, opens every route and one page per kind of item in a real
// browser – desktop and phone – and fails on console errors, page errors, an error
// boundary or a blank page. A fourth server is set up on the page with its examples, which are
// removed again in the settings and brought back with "Rückgängig"; then it gets a second
// workspace (sidebar, inbox filter, a move into it). Every server gets its first
// account through the API; the browser holds it as if it had signed in (the sign-in page itself
// is checked once).
//   bun run test:e2e        (builds first; Chrome from ~/.cache/ms-playwright)
// Not part of `bun test`: it needs a browser and takes a few minutes.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Page, chromium } from "playwright-core";

const ROOT = resolve(import.meta.dir, "../..");
const failures: string[] = [];
let checks = 0;

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

async function startServer(seeded: boolean, noTypes = false) {
  const dir = mkdtempSync(join(tmpdir(), "obtion-e2e-"));
  const port = await freePort();
  const env = { ...process.env, OBTION_DATA: dir, PORT: String(port), HOST: "127.0.0.1" };
  if (seeded) {
    const seed = Bun.spawnSync(["bun", "apps/server/src/cli.ts", "setup", "de", "--examples"], { cwd: ROOT, env });
    if (seed.exitCode !== 0) throw new Error("seed failed: " + seed.stderr.toString());
    if (noTypes) {
      const del = Bun.spawnSync(["bun", "tests/e2e/no-types.ts"], { cwd: ROOT, env });
      if (!del.stdout.toString().includes("types left: 0")) throw new Error("deleting types failed: " + del.stderr.toString());
    }
  }
  const proc = Bun.spawn(["bun", "apps/server/src/index.ts"], { cwd: ROOT, env, stdout: "ignore", stderr: "pipe" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(url + "/api/info").then((r) => r.ok, () => false)) break;
    await Bun.sleep(100);
  }
  // the first account (the admin): with the seeded data it gets them, otherwise a personal workspace
  const signup = (await fetch(url + "/api/account/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "E2E", email: "e2e@example.org", password: "geheim12345", lang: "de" }) }).then((r) => r.json())) as { token: string };
  const me = (await fetch(url + "/api/account", { headers: { authorization: `Bearer ${signup.token}` } }).then((r) => r.json())) as { user: unknown; workspaces: { id: string }[] };
  const server = { dir, url, proc, file: "", trashed: "", token: signup.token, me };
  if (seeded && !noTypes) {
    const token = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).token as string;
    const mcp = async (name: string, args: unknown) => {
      const res = await fetch(url + "/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const text = ((await res.json()) as any).result.content[0].text as string;
      return /\[([\w-]+)\]/.exec(text)?.[1] ?? "";
    };
    // a 1×1 PNG below the course
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    server.file = await mcp("attach", { name: "skizze.png", base64: png, parent: "Kurs Datenbanken", description: "Eine Skizze" });
    server.trashed = "ex-i-bike";
    await mcp("delete", { ref: server.trashed });
  }
  return server;
}

/** A browser context that holds the server's first account, as after signing in on the page. */
async function signedIn(browser: import("playwright-core").Browser, server: Awaited<ReturnType<typeof startServer>>, opts: import("playwright-core").BrowserContextOptions) {
  const context = await browser.newContext({ baseURL: server.url, ...opts });
  const account = { token: server.token, user: server.me.user };
  const spaces = server.me.workspaces;
  await context.addInitScript(
    ({ account, spaces }) => {
      if (localStorage.getItem("obtion.account")) return;
      localStorage.setItem("obtion.account", JSON.stringify(account));
      localStorage.setItem("obtion.spaces", JSON.stringify(spaces));
      localStorage.setItem("obtion.active", spaces[0]!.id);
    },
    { account, spaces },
  );
  return context;
}

async function settle(page: Page) {
  await page.waitForSelector("#root > *", { timeout: 10000 });
  await page.waitForFunction(() => !document.body.innerText.includes("Syncing") && !document.body.innerText.includes("Synchronisiere"), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(350);
}

async function check(page: Page, label: string, path: string, errors: string[], extra?: (p: Page) => Promise<void>, opts: { phone?: boolean; page?: boolean } = {}) {
  checks++;
  errors.length = 0;
  try {
    await page.goto(path, { waitUntil: "load" });
    await settle(page);
    if (extra) await extra(page);
    if (path.includes("graph")) await page.waitForTimeout(700);
    const boundary = page.locator("[data-error-boundary]");
    if (await boundary.count()) failures.push(`${label} ${path}: error boundary: ${(await boundary.first().innerText()).replace(/\s+/g, " ")}`);
    const main = page.locator("main");
    const text = (await main.count()) ? (await main.innerText()).trim() : (await page.locator("#root").innerText()).trim();
    if (path.includes("graph")) {
      if (!(await page.locator("canvas").count()) && text.length < 5) failures.push(`${label} ${path}: graph rendered nothing`);
    } else if (text.length < 5) failures.push(`${label} ${path}: blank page`);
    // design rules § 8: nothing sticks out sideways on a phone
    if (opts.phone && !path.includes("graph")) {
      const wide = await page.evaluate(() => {
        const m = document.querySelector("main");
        return Math.max(document.documentElement.scrollWidth - innerWidth, m ? m.scrollWidth - m.clientWidth : 0);
      });
      if (wide > 1) failures.push(`${label} ${path}: ${wide}px wider than the screen`);
    }
    // an information page: one column (no right column), at most one primary button
    if (opts.page) {
      if (await page.locator("main aside").count()) failures.push(`${label} ${path}: has a right column`);
      const primary = await page.locator("main button.bg-ink:visible, main a.bg-ink:visible").count();
      if (primary > 1) failures.push(`${label} ${path}: ${primary} primary buttons`);
    }
  } catch (err) {
    failures.push(`${label} ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const e of errors) failures.push(`${label} ${path}: ${e}`);
}

const ROUTES = ["/", "/#/inbox", "/#/search", "/#/search?q=relaunch", "/#/types", "/#/graph", "/#/activity", "/#/trash", "/#/settings", "/#/workspace", "/#/nope", "/#/i/sys%3Aproject", "/#/i/sys%3Atask", "/#/i/sys%3Acard", "/#/i/ex-type-book", "/#/files", "/#/files?kind=bild", "/#/c/sys%3Ac-project"];
// one page per kind: overview, article with translation, project, sub-project, task, card, note,
// inbox item, inbox bundle, course with free properties, book, image, PDF, query page, welcome note
const ITEMS = ["ex-work", "ex-art-de", "ex-relaunch", "ex-design", "ex-t-pages", "ex-k-nf", "ex-n-lecture", "ex-i-podcast", "ex-i-trip", "ex-course", "ex-b-moor", "ex-f-diagram", "ex-f-sheet", "ex-week", "ex-welcome"];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const server = await startServer(false);
  try { await deleteAccountOnSettings(browser, server); }
  finally { await browser.close(); server.proc.kill(); await server.proc.exited; rmSync(server.dir, { recursive: true, force: true }); }
  if (failures.length) throw new Error(failures.join("\n"));
  console.log("Account deletion browser checks passed");
}

async function signInPage(browser: import("playwright-core").Browser, server: { url: string }) {
  const context = await browser.newContext({ baseURL: server.url, viewport: { width: 1440, height: 900 }, locale: "de-DE" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  await check(page, "sign-in", "/", errors, async (p) => {
    await p.getByLabel("E-Mail").fill("e2e@example.org");
    await p.getByLabel("Passwort").fill("geheim12345");
    await p.getByRole("button", { name: "Anmelden" }).click();
    // the account's workspace is not set up yet: its setup page
    if (!(await p.getByRole("button", { name: /Einrichten/ }).waitFor({ timeout: 8000 }).then(() => true, () => false))) failures.push("sign-in: the workspace did not open after signing in");
  });
  await context.close();
}

/** Set up on the page with the examples (the default), then remove them in the settings and undo that. */
async function examplesOnSetup(browser: import("playwright-core").Browser, server: Awaited<ReturnType<typeof startServer>>) {
  const context = await signedIn(browser, server, { viewport: { width: 1440, height: 900 }, locale: "de-DE" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console error: ${m.text()}`);
  });
  const label = "fresh light";
  const welcome = (p: Page) => p.locator("aside section[aria-label='Persönlich']").getByText("So funktioniert Obtion");
  await check(page, label, "/", errors, async (p) => {
    if (!(await p.getByRole("checkbox", { name: /Mit Beispielen starten/ }).isChecked())) failures.push(`${label}: "Mit Beispielen starten" is not preset`);
    await p.getByRole("button", { name: /Einrichten/ }).click();
    if (!(await welcome(p).waitFor({ timeout: 8000 }).then(() => true, () => false))) failures.push(`${label}: no welcome note after the setup`);
  });
  // the image is embedded in the lecture note (made on this device, then uploaded)
  await check(page, label, "/#/i/ex-n-lecture", errors, async (p) => {
    const shown = await p.waitForFunction(() => [...document.querySelectorAll("main img")].some((i) => (i as HTMLImageElement).naturalWidth >= 600), null, { timeout: 5000 }).then(() => true, () => false);
    if (!shown) failures.push(`${label}: the diagram does not show`);
  });
  // the global settings list the workspaces; the examples are a workspace's own
  await check(page, label, "/#/settings", errors, async (p) => {
    if (await p.getByRole("button", { name: "Beispiele entfernen …" }).count()) failures.push(`${label}: workspace settings in the global settings`);
    await p.locator("main").getByRole("link", { name: /Persönlich/ }).click();
    if (!(await p.getByRole("heading", { name: "Persönlich" }).waitFor({ timeout: 3000 }).then(() => true, () => false))) failures.push(`${label}: the workspace's settings do not open from the list`);
  });
  await check(page, label, "/#/workspace", errors, async (p) => {
    await p.getByRole("button", { name: "Beispiele entfernen …" }).click();
    const dialog = p.getByRole("dialog");
    // nothing was changed yet: every example is chosen
    const unchosen = await dialog.getByRole("checkbox", { checked: false }).count();
    if (unchosen) failures.push(`${label}: ${unchosen} untouched examples count as changed`);
    await dialog.getByRole("button", { name: /Einträge entfernen/ }).click();
    const toast = p.locator("[data-sonner-toast]").filter({ hasText: "Beispiele entfernt" }).first();
    if (!(await toast.waitFor({ timeout: 3000 }).then(() => true, () => false))) failures.push(`${label}: no notice "Beispiele entfernt"`);
    if (await welcome(p).count()) failures.push(`${label}: the welcome note is still pinned`);
    await toast.getByRole("button", { name: /Rückgängig/ }).click();
    if (!(await welcome(p).waitFor({ timeout: 3000 }).then(() => true, () => false))) failures.push(`${label}: "Rückgängig" did not bring the examples back`);
  });
  await context.close();
}

/**
 * A second workspace next to the first: it shows in the sidebar and is set up from there; the
 * inbox is one list of both and shows one when chosen (remembered over a reload, the sidebar
 * follows); a type page can be pinned; a pinned area moves into the other workspace.
 */
async function twoWorkspaces(browser: import("playwright-core").Browser, server: Awaited<ReturnType<typeof startServer>>) {
  const personal = server.me.workspaces[0]!.id;
  await fetch(server.url + "/api/workspaces", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` }, body: JSON.stringify({ name: "Firma" }) });
  const context = await signedIn(browser, server, { viewport: { width: 1440, height: 900 }, locale: "de-DE" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console error: ${m.text()}`);
  });
  const label = "two workspaces";
  const firma = (p: Page) => p.locator("aside section[aria-label='Firma']");
  await check(page, label, `/#/w/${personal}/`, errors, async (p) => {
    await firma(p).getByText("Einrichten").click();
    await p.getByRole("checkbox", { name: /Mit Beispielen starten/ }).uncheck();
    await p.getByRole("button", { name: /^Einrichten$/ }).click();
    if (!(await firma(p).getByRole("button", { name: "Typen" }).waitFor({ timeout: 8000 }).then(() => true, () => false))) failures.push(`${label}: "Firma" not set up from the sidebar`);
    if (!(await p.locator("aside section[aria-label='Persönlich'] a[href='#/i/ex-work']").count())) failures.push(`${label}: the first workspace's block lost its pinned items`);
  });
  await check(page, label, "/#/inbox", errors, async (p) => {
    const chips = p.locator("main [role=group] button");
    if ((await chips.allInnerTexts()).map((x) => x.replace(/\s*\d+$/, "")).join(",") !== "Alle,Persönlich,Firma") failures.push(`${label}: inbox filter is ${(await chips.allInnerTexts()).join(", ")}`);
    await chips.filter({ hasText: "Firma" }).click();
    await p.reload();
    await settle(p);
    if ((await p.locator("main [aria-pressed=true]").innerText()).replace(/\s*\d+$/, "") !== "Firma") failures.push(`${label}: the inbox filter is not remembered`);
    if (await p.locator("aside section[aria-label='Persönlich']").count()) failures.push(`${label}: the sidebar still shows the workspace left out`);
    await p.locator("main").getByRole("button", { name: /^Alle/ }).click();
  });
  await check(page, label, `/#/w/${personal}/i/sys%3Aproject`, errors, async (p) => {
    await p.locator("main").getByRole("button", { name: "Mehr" }).first().click();
    await p.getByText("Anheften", { exact: true }).click();
    if (!(await p.locator("aside section[aria-label='Persönlich']").getByText("Projekte", { exact: true }).first().waitFor({ timeout: 3000 }).then(() => true, () => false))) failures.push(`${label}: the pinned type page is not in the sidebar`);
  });
  await check(page, label, `/#/w/${personal}/i/ex-work`, errors, async (p) => {
    await p.locator("main").getByRole("button", { name: "Mehr" }).first().click();
    await p.getByText("In anderen Workspace verschieben").click();
    await p.getByRole("dialog").getByRole("button", { name: "Firma" }).click();
    const ask = p.getByRole("dialog").getByRole("button", { name: "Verschieben" });
    if (await ask.waitFor({ timeout: 3000 }).then(() => true, () => false)) await ask.click();
    if (!(await firma(p).getByText("Arbeit").waitFor({ timeout: 8000 }).then(() => true, () => false))) failures.push(`${label}: "Arbeit" did not move into "Firma"`);
    if (await p.locator("aside section[aria-label='Persönlich'] a[href='#/i/ex-work']").count()) failures.push(`${label}: "Arbeit" is still in "Persönlich"`);
  });
  await context.close();
}

async function deleteAccountOnSettings(browser: import("playwright-core").Browser, server: Awaited<ReturnType<typeof startServer>>) {
  const context = await signedIn(browser, server, { locale: "de-DE" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await check(page, "delete account", "/#/settings", errors, async (p) => {
    await p.getByRole("button", { name: "Konto endgültig löschen", exact: true }).click();
    const dialog = p.getByRole("dialog");
    await dialog.getByLabel("Passwort").fill("wrong");
    await dialog.getByRole("button", { name: "Konto endgültig löschen", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "Das Passwort stimmt nicht." }).waitFor();
    await dialog.getByLabel("Passwort").fill("geheim12345");
    await dialog.getByRole("button", { name: "Konto endgültig löschen", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "letzter Owner" }).waitFor();
    await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
    // Use the existing workspace API so the final confirmation also cleans an open local replica.
    const me = await fetch(server.url + "/api/account", { headers: { authorization: `Bearer ${server.token}` } }).then((r) => r.json());
    for (const w of me.workspaces) {
      const response = await fetch(`${server.url}/api/workspaces/${w.id}`, { method: "DELETE", headers: { authorization: `Bearer ${server.token}` } });
      if (!response.ok) throw new Error("could not delete test workspace");
    }
    await p.getByRole("button", { name: "Konto endgültig löschen", exact: true }).click();
    await dialog.getByLabel("Passwort").fill("geheim12345");
    await dialog.getByRole("button", { name: "Konto endgültig löschen", exact: true }).click();
    await p.getByRole("button", { name: "Anmelden", exact: true }).waitFor();
    const stored = await p.evaluate(() => ({ account: JSON.parse(localStorage.getItem("obtion.account") ?? "null"), spaces: JSON.parse(localStorage.getItem("obtion.spaces") ?? "[]") }));
    if (stored.account || stored.spaces.length) throw new Error("account or workspace metadata remained on this device");
    const databases = await p.evaluate(async () => (await indexedDB.databases()).map((db) => db.name));
    if (databases.some((name) => name === "obtion" || name === "obtion-files" || name?.startsWith("obtion-ws-")))
      throw new Error("workspace database remained on this device");
  });
  await context.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
