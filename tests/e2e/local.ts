// Browser test of workspaces in a folder: without an account a workspace is made in a folder and
// set up, survives a reload, is synced with the server after signing in (another device then sees
// it), gets cut off again; a workspace of the server gets a full copy in a folder. The folder
// picker hands out folders of the browser's private file system (they are real directory handles).
// A phone sees nothing of all this, another desktop browser a hint.
//   bun run build && bun tests/e2e/local.ts
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BrowserContext, type Page, chromium, devices } from "playwright-core";

const ROOT = resolve(import.meta.dir, "../..");
const failures: string[] = [];
const expect = (ok: unknown, what: string) => void (ok || failures.push(what));

const port = await new Promise<number>((res) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => res(p));
  });
});
const dir = mkdtempSync(join(tmpdir(), "obtion-e2e-local-"));
const proc = Bun.spawn(["bun", "apps/server/src/index.ts"], { cwd: ROOT, env: { ...process.env, OBTION_DATA: dir, PORT: String(port), HOST: "127.0.0.1", OBTION_SIGNUP: "open" }, stdout: "ignore", stderr: "pipe" });
const url = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100 && !(await fetch(url + "/api/info").then((r) => r.ok, () => false)); i++) await Bun.sleep(100);

const browser = await chromium.launch({ headless: true });

/** A context whose folder picker returns the private folder named in localStorage "e2e.folder". */
async function desktop(): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: url, locale: "de-DE" });
  await context.addInitScript(() => {
    (window as any).showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(localStorage.getItem("e2e.folder") ?? "one", { create: true });
  });
  return context;
}

function watch(page: Page, label: string) {
  page.on("pageerror", (e) => failures.push(`${label}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|WebSocket/.test(m.text()) && failures.push(`${label}: ${m.text()}`));
}

const files = (page: Page, folder: string) =>
  page.evaluate(async (folder) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(folder);
    const out: string[] = [];
    const walk = async (d: FileSystemDirectoryHandle, at: string) => {
      for await (const [name, h] of (d as any).entries()) h.kind === "file" ? out.push(at + name) : await walk(h, `${at}${name}/`);
    };
    await walk(root, "");
    return out;
  }, folder);

try {
  // ---------- a workspace in a folder, without an account ----------
  const ctx = await desktop();
  const page = await ctx.newPage();
  watch(page, "local");
  await page.goto("/");
  await page.getByRole("button", { name: "Ordner wählen …" }).click();
  await page.waitForURL(/#\/w\/[^/]+\/setup/);
  const id = /#\/w\/([^/]+)/.exec(page.url())![1]!;
  await page.getByRole("button", { name: "Einrichten" }).click();
  await page.waitForFunction(() => document.querySelector("main")?.textContent?.includes("Eingang"), null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const inFolder = await files(page, "one");
  expect(inFolder.includes("obtion.json"), "the folder has no obtion.json");
  expect(inFolder.some((f) => f.startsWith("updates/") && f.endsWith(".obu")), "the folder has no updates");
  expect(!(await page.getByText("offline", { exact: false }).count()), "a workspace without a server shows offline");

  await page.reload();
  await page.goto(`/#/w/${id}/i/ex-welcome`);
  await page.waitForTimeout(800);
  expect((await page.locator("main").innerText()).length > 20, "after a reload the welcome note is missing");

  // the server's features are not offered
  await page.goto(`/#/w/${id}/workspace`);
  await page.waitForTimeout(500);
  const settings = await page.locator("main").innerText();
  expect(settings.includes("Nur auf diesem Computer"), "the settings do not say where it is kept");
  expect(!settings.includes("Aktivität"), "a workspace without a server offers the activity");
  expect(settings.includes("bei 127.0.0.1"), "without an account the settings do not lead to signing in");

  // ---------- sync it with the server ----------
  const signup = (await fetch(url + "/api/account/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "E2E", email: "e2e@example.org", password: "geheim12345", lang: "de", none: true }) }).then((r) => r.json())) as { token: string };
  const me = (await fetch(url + "/api/account", { headers: { authorization: `Bearer ${signup.token}` } }).then((r) => r.json())) as { user: unknown; workspaces: unknown[] };
  expect(me.workspaces.length === 0, "a signup that brings its own workspace got one on the server");
  await page.evaluate((a) => localStorage.setItem("obtion.account", JSON.stringify(a)), { token: signup.token, user: me.user });
  await page.reload();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /synchronisieren/ }).click();
  await page.waitForTimeout(3000);
  const now = (await fetch(url + "/api/account", { headers: { authorization: `Bearer ${signup.token}` } }).then((r) => r.json())) as { workspaces: { id: string }[] };
  expect(now.workspaces.length === 1, "syncing did not create the workspace on the server");
  const remote = now.workspaces[0]?.id ?? "";

  // another device (only the server) sees it
  const other = await browser.newContext({ baseURL: url, locale: "de-DE" });
  await other.addInitScript(
    ({ account, spaces }) => {
      if (localStorage.getItem("obtion.account")) return;
      localStorage.setItem("obtion.account", JSON.stringify(account));
      localStorage.setItem("obtion.spaces", JSON.stringify(spaces));
    },
    { account: { token: signup.token, user: me.user }, spaces: now.workspaces },
  );
  const page2 = await other.newPage();
  watch(page2, "other device");
  await page2.goto(`/#/w/${remote}/i/ex-welcome`);
  await page2.waitForTimeout(3000);
  expect(!(await page2.locator("main").innerText()).includes("Synchronisiere"), "the other device does not get the workspace");
  expect((await page2.locator("main").innerText()).length > 20, "the other device does not see the welcome note");

  // ---------- the server's workspace gets a copy in a folder ----------
  await page2.evaluate(() => localStorage.setItem("e2e.folder", "copy"));
  await other.addInitScript(() => {
    (window as any).showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("copy", { create: true });
  });
  await page2.reload();
  await page2.goto(`/#/w/${remote}/workspace`);
  await page2.waitForTimeout(800);
  await page2.getByRole("button", { name: "Vollständige Kopie in einem Ordner" }).click();
  await page2.waitForTimeout(2500);
  expect((await files(page2, "copy")).includes("obtion.json"), "the copy has no obtion.json");
  await page2.goto(`/#/w/${remote}/workspace`);
  await page2.waitForTimeout(800);
  const copySettings = await page2.locator("main").innerText();
  expect(copySettings.includes("In einem Ordner") && copySettings.includes("Auf dem Server"), "the copy is not both in the folder and on the server");

  // ---------- cut the first one off again ----------
  await page.goto(`/#/w/${id}/workspace`);
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Vom Server trennen" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Vom Server trennen" }).click();
  await page.waitForTimeout(1500);
  await page.goto(`/#/w/${id}/workspace`);
  await page.waitForTimeout(800);
  expect((await page.locator("main").innerText()).includes("Nur auf diesem Computer"), "cut off, it still syncs");
  const info = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("one");
    return (await (await root.getFileHandle("obtion.json")).getFile()).text();
  });
  expect(!info.includes("server"), "cut off, the folder still names the server");

  // ---------- a phone sees nothing, another browser a hint ----------
  const phone = await browser.newContext({ baseURL: url, locale: "de-DE", ...devices["iPhone 13"] });
  const p3 = await phone.newPage();
  await p3.goto("/");
  await p3.waitForTimeout(800);
  expect(!(await p3.getByText("Ordner").count()), "a phone is offered folders");
  const firefoxLike = await browser.newContext({ baseURL: url, locale: "de-DE" });
  await firefoxLike.addInitScript(() => Object.defineProperty(window, "showDirectoryPicker", { value: undefined }));
  const p4 = await firefoxLike.newPage();
  await p4.goto("/");
  await p4.waitForTimeout(800);
  expect(await p4.getByText("Chromium-Browser").count(), "another desktop browser gets no hint");
  expect(!(await p4.getByRole("button", { name: "Ordner wählen …" }).count()), "another desktop browser is offered a folder");
} catch (e) {
  failures.push(String(e instanceof Error ? e.message.split("\n")[0] : e));
} finally {
  await browser.close();
  proc.kill();
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(failures.map((f) => "✗ " + f).join("\n"));
  process.exit(1);
}
console.log("✓ workspaces in a folder");
