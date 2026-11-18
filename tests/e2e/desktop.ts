// Desktop app test: starts the real Electron app (apps/desktop, unpackaged, its server from
// source) with an empty folder of its own and checks what makes it the desktop app:
//   - the first start asks where the first workspace goes; a local one right away (the server on
//     this device, its account made by the app);
//   - a new workspace on a server: connected on the first time (address over the LAN, plain
//     http, a headless server), then synced there; a second one on the same server without asking;
//   - with that server gone the local workspace keeps working; after a restart the same account
//     and workspaces are there; signing out of the server removes its workspaces' copies;
//     another account of the same server replaces the one before, also the workspace open.
// Screenshots go to $OBTION_SHOTS (default ~/tmp/obtion-desktop-shots).
//   bun run test:e2e:desktop   (builds first; on Linux without a display: xvfb-run -a bun …)
//   OBTION_DESKTOP_APP=apps/desktop/release/linux-unpacked/obtion bun tests/e2e/desktop.ts   (a packaged app)
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright";
import { bootServer, get, ROOT } from "../support/server";

const shots = process.env.OBTION_SHOTS ?? join(homedir(), "tmp/obtion-desktop-shots");
mkdirSync(shots, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), "obtion-desktop-"));
const packaged = process.env.OBTION_DESKTOP_APP;
const electron =
	packaged ?? (createRequire(join(ROOT, "apps/desktop/package.json"))("electron") as string);
const failures: string[] = [];
const errors: string[] = [];
const expect = (ok: boolean, what: string) => ok || failures.push(what);

// a server elsewhere: headless, reached by this machine's LAN address (not localhost: plain http from the app's secure pages)
const lan =
	Object.values(networkInterfaces())
		.flat()
		.find((i) => i && i.family === "IPv4" && !i.internal)?.address ?? "127.0.0.1";
const remoteData = mkdtempSync(join(tmpdir(), "obtion-remote-"));
const remote = await bootServer({
	OBTION_DATA: remoteData,
	HOST: "0.0.0.0",
	OBTION_WEB_APP: "off",
});
const remoteUrl = remote.url.replace("127.0.0.1", lan);

async function launch(dir = userData): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await _electron.launch({
		executablePath: electron,
		args: [
			...(packaged ? [] : [join(ROOT, "apps/desktop")]),
			`--user-data-dir=${dir}`,
			"--lang=de",
		],
		env: { ...process.env, LANGUAGE: "de", LC_ALL: "de_DE.UTF-8", LANG: "de_DE.UTF-8" },
	});
	const page = await app.firstWindow();
	page.on("pageerror", (e) => errors.push(`page error: ${e.stack ?? e.message}`));
	page.on("console", (m) => m.type() === "error" && errors.push(`console error: ${m.text()}`));
	await page.setViewportSize({ width: 1280, height: 820 }).catch(() => {
		// the window keeps its size
	});
	return { app, page };
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });
/** A new workspace is created (its dialog gone) and open. */
const opened = async (page: Page, name: string) => {
	await page
		.getByRole("dialog")
		.waitFor({ state: "hidden", timeout: 30000 })
		.catch(() => {
			// no dialog (the first workspace): the page below decides
		});
	return page
		.waitForFunction(
			(n) => {
				const spaces: { id: string; name: string }[] = JSON.parse(
					localStorage.getItem("obtion.spaces") ?? "[]",
				);
				return spaces.find((w) => w.name === n)?.id === localStorage.getItem("obtion.active");
			},
			name,
			{ timeout: 30000 },
		)
		.then(
			() => true,
			() => false,
		);
};
const visible = (page: Page | Locator, text: string | RegExp, timeout = 15000) =>
	page
		.getByText(text)
		.first()
		.waitFor({ timeout })
		.then(
			() => true,
			() => false,
		);
/** The settings dialog: what it lists, not the page behind it. */
const settings = (page: Page) => page.getByRole("dialog", { name: "Einstellungen" });

try {
	// 1. the first start: where the first workspace goes; on this device, set up as it is created
	let { app, page } = await launch();
	expect(
		await visible(page, "Wo soll er liegen?"),
		"first start: no choice where the first workspace goes",
	);
	await shot(page, "1-first-start");
	expect(await visible(page, "Mit Beispielen starten"), "first start: no choice of the examples");
	await page.getByRole("button", { name: /^Workspace anlegen/ }).click();
	expect(await visible(page, "So funktioniert Obtion"), "local workspace: not set up");
	await shot(page, "2-local-workspace");

	// 2. a new workspace on a server: connect it first
	await page.evaluate(() => (location.hash = "#/settings"));
	await page.getByRole("button", { name: "Neuer Workspace" }).click();
	const dialog = page.getByRole("dialog");
	const card = (name: RegExp) => dialog.getByRole("button", { name });
	await card(/^Auf einem Server/).click();
	expect(
		await dialog.getByLabel("Adresse des Servers").isVisible(),
		"new workspace: no server address",
	);
	// and back again: on this device it needs no address
	await card(/^Auf diesem Gerät/).click();
	expect(
		await dialog.getByRole("button", { name: "Workspace anlegen" }).isVisible(),
		"new workspace: back to this device does not work",
	);
	expect(
		!(await dialog.getByLabel("Adresse des Servers").isVisible()),
		"new workspace: the server address stays after going back",
	);
	await card(/^Auf einem Server/).click();
	// a server that answers but does not let the app in (no CORS for it, like one older than the
	// desktop app), and one that is not there: each says so
	const closed = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ name: "old" }),
	});
	const closedUrl = `http://127.0.0.1:${closed.port}`;
	await dialog.getByLabel("Adresse des Servers").fill(closedUrl);
	await dialog.getByRole("button", { name: "Weiter" }).click();
	expect(
		await visible(dialog, /lässt diese App aber nicht zu/),
		"server without CORS for the app: not told so",
	);
	closed.stop(true);
	await dialog.getByLabel("Adresse des Servers").fill(closedUrl);
	await dialog.getByRole("button", { name: "Weiter" }).click();
	expect(await visible(dialog, /ist gerade nicht erreichbar/), "server gone: not told so");
	await dialog.getByLabel(/Name eines neuen Workspaces/).fill("Team");
	await dialog.getByLabel("Adresse des Servers").fill(remoteUrl.replace(/^http:\/\//, ""));
	await shot(page, "3-connect-server");
	await dialog.getByRole("button", { name: "Weiter" }).click();
	// address, e-mail and password one below the other; another address asks to continue again
	await dialog.getByLabel("E-Mail").waitFor();
	expect(
		await dialog.getByLabel("Adresse des Servers").isVisible(),
		"sign-in on the server: the address is gone",
	);
	await dialog.getByLabel("Adresse des Servers").fill(remoteUrl);
	expect(
		!(await dialog.getByLabel("E-Mail").isVisible()) &&
			(await dialog.getByRole("button", { name: "Weiter" }).isVisible()),
		"sign-in on the server: a changed address keeps the sign-in",
	);
	await dialog.getByRole("button", { name: "Weiter" }).click();
	await dialog.getByLabel("Name", { exact: true }).fill("Tim");
	await dialog.getByLabel("E-Mail").fill("tim@example.org");
	await dialog.getByLabel("Passwort").fill("geheim12345");
	await shot(page, "4-sign-up-on-server");
	await dialog.getByRole("button", { name: "Konto anlegen" }).click();
	expect(await opened(page, "Team"), "server workspace: not opened");

	// it is on the server: its account and workspaces, the setup synced there
	const signIn = await fetch(`${remote.url}/api/auth/sign-in/email`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: "tim@example.org", password: "geheim12345" }),
	}).then((r) => r.json());
	const me = await get(remote.url, "/api/account", signIn.token).then((r) => r.json());
	const team = me.workspaces.find((w: { name: string }) => w.name === "Team");
	expect(!!team, `server: no workspace "Team" (${JSON.stringify(me.workspaces)})`);
	// more of them, so that removing their copies takes a while (sign-out, below)
	for (let i = 0; i < 17; i++)
		await fetch(`${remote.url}/api/workspaces`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${signIn.token}` },
			body: JSON.stringify({ name: `Extra ${i}` }),
		});
	// a second account there, a member of "Team" only
	const { code } = await fetch(`${remote.url}/api/workspaces/${team?.id}/invites`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${signIn.token}` },
		body: "{}",
	}).then((r) => r.json());
	await fetch(`${remote.url}/api/account/signup`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "Ada",
			email: "ada@example.org",
			password: "geheim12345",
			invite: code,
		}),
	});
	let synced = false;
	for (let i = 0; i < 50 && team && !synced; i++) {
		const events = await get(remote.url, `/w/${team.id}/api/activity?limit=5`, signIn.token).then(
			(r) => r.json(),
		);
		synced = Array.isArray(events) && events.length > 0;
		if (!synced) await Bun.sleep(200);
	}
	expect(synced, "server workspace: the setup did not reach the server");

	// a second one on the same server: no sign-in again
	await page.evaluate(() => (location.hash = "#/settings"));
	await page.getByRole("button", { name: "Neuer Workspace" }).click();
	await card(/^Auf einem Server/).click();
	expect(
		(await dialog.locator("select").inputValue()) === new URL(remoteUrl).origin,
		"second server workspace: the connected server is not preset",
	);
	await dialog.getByLabel("Name", { exact: true }).fill("Projekte");
	await dialog.getByRole("button", { name: "Workspace anlegen" }).click();
	expect(await opened(page, "Projekte"), "second server workspace: not opened");
	await page.evaluate(() => (location.hash = "#/settings"));
	expect(
		await visible(settings(page), "Projekte"),
		"settings: the second server workspace is missing",
	);
	await shot(page, "5-settings-with-server");

	// the password changed on the server, from here: the server takes the new one, this device stays signed in
	await page.getByRole("button", { name: "Passwort ändern" }).click();
	const pw = page.getByRole("dialog");
	await pw.getByLabel("Aktuelles Passwort", { exact: true }).fill("geheim12345");
	await pw.getByLabel("Neues Passwort", { exact: true }).fill("anders12345");
	await pw.getByLabel("Neues Passwort wiederholen").fill("anders12345");
	await pw.getByRole("button", { name: "Passwort ändern" }).click();
	expect(await visible(page, "Dein Passwort ist geändert"), "password: not changed");
	await pw.getByText("Schließen", { exact: true }).click();
	const fresh = await fetch(`${remote.url}/api/auth/sign-in/email`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: "tim@example.org", password: "anders12345" }),
	});
	expect(fresh.ok, `password: the server does not take the new one (${fresh.status})`);
	await page.reload();
	await page.evaluate(() => (location.hash = "#/settings"));
	expect(
		(await visible(settings(page), "Projekte")) &&
			!(await visible(settings(page), /· abgemeldet/, 2000)),
		"password: this device was signed out",
	);

	// 3. the server gone: the local workspace still works
	remote.proc.kill();
	await remote.proc.exited;
	await page.reload();
	await page.evaluate(() => (location.hash = "#/"));
	await page.getByRole("button", { name: "Workspaces auswählen" }).first().click();
	expect(await visible(page, "Auf diesem Gerät"), "selector: no local group");
	expect(
		await visible(
			page,
			new RegExp(`tim@example.org auf ${new URL(remoteUrl).host.replace(/\./g, "\\.")}`),
		),
		"selector: no group of the server",
	);
	await shot(page, "6-offline-selector");
	await page.keyboard.press("Escape");
	await app.close();

	// 4. a restart: the same account on this device, the same workspaces
	({ app, page } = await launch());
	await page.evaluate(() => (location.hash = "#/settings"));
	expect(await visible(settings(page), "Persönlich"), "restart: the local workspace is missing");
	expect(await visible(settings(page), "Team"), "restart: the server workspace is missing");
	await shot(page, "7-after-restart");

	// 5. signing out of the server: its workspaces and every copy of them leave this device
	const remoteIds: string[] = (
		await page.evaluate(() => JSON.parse(localStorage.getItem("obtion.spaces") ?? "[]"))
	)
		.filter((w: { server?: string }) => w.server)
		.map((w: { id: string }) => w.id);
	expect(remoteIds.length === 19, `sign-out: ${remoteIds.length} server workspaces instead of 19`);
	const copies = () =>
		page.evaluate(
			async (ids) =>
				(await indexedDB.databases())
					.map((d) => d.name ?? "")
					.filter((n) => ids.some((id) => n.includes(id))),
			remoteIds,
		);
	for (const id of remoteIds) await page.evaluate((id) => (location.hash = `#/w/${id}/`), id);
	await page.evaluate(() => (location.hash = "#/settings"));
	expect(
		(await copies()).length > 0,
		"sign-out: no copies of the server's workspaces to begin with",
	);
	await Promise.all([
		page.waitForEvent("load"),
		page.getByRole("button", { name: "Abmelden" }).click(),
	]);
	await page.evaluate(() => (location.hash = "#/settings"));
	expect(
		!(await visible(settings(page), "Team", 3000)),
		"sign-out: the server workspace is still listed",
	);
	const left = await copies();
	expect(left.length === 0, `sign-out: copies left behind: ${left.join(", ")}`);

	// 6. the server back; signed in there again, then as another account while "Projekte" is open
	// on its port from before: the app knows it by its address
	const again = Bun.spawn(["bun", "apps/server/src/index.ts"], {
		cwd: ROOT,
		env: {
			...process.env,
			OBTION_DATA: remoteData,
			HOST: "0.0.0.0",
			OBTION_WEB_APP: "off",
			PORT: new URL(remote.url).port,
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	for (
		let i = 0;
		i < 200 &&
		!(await fetch(`${remote.url}/api/info`).then(
			(r) => r.ok,
			() => false,
		));
		i++
	)
		await Bun.sleep(50);
	const connect = async (email: string, password = "geheim12345") => {
		await page.evaluate(() => (location.hash = "#/settings"));
		await page.getByRole("button", { name: "Mit Server verbinden" }).click();
		const box = page.getByRole("dialog");
		await box.getByLabel("Adresse des Servers").fill(remoteUrl);
		await box.getByRole("button", { name: "Weiter" }).click();
		await box.getByLabel("E-Mail").fill(email);
		await box.getByLabel("Passwort").fill(password);
		await box.getByRole("button", { name: "Anmelden" }).click();
	};
	await connect("tim@example.org", "anders12345");
	expect(
		await visible(settings(page), "Projekte"),
		"connect again: the server's workspaces are missing",
	);
	const projekte = (
		await page.evaluate(() => JSON.parse(localStorage.getItem("obtion.spaces") ?? "[]"))
	).find((w: { name: string }) => w.name === "Projekte")?.id;
	await page.evaluate((id) => (location.hash = `#/w/${id}/`), projekte);
	await Promise.all([page.waitForEvent("load"), connect("ada@example.org")]);
	await page.evaluate(() => (location.hash = "#/settings"));
	expect(await visible(settings(page), "ada@example.org"), "switch: the new account is not shown");
	expect(await visible(settings(page), "Team"), "switch: the new account's workspace is missing");
	expect(
		!(await visible(settings(page), "Projekte", 3000)),
		"switch: a workspace of the account before is still listed",
	);
	expect(
		(await page.evaluate(() => localStorage.getItem("obtion.active"))) !== projekte,
		"switch: the workspace of the account before is still open",
	);
	await shot(page, "8-other-account");
	await app.close();

	// 7. another computer's first start: the account's existing workspace on the server, nothing on this device
	const other = mkdtempSync(join(tmpdir(), "obtion-desktop-"));
	({ app, page } = await launch(other));
	await page.getByRole("button", { name: /^Auf einem Server/ }).click();
	await page.getByLabel(/Name eines neuen Workspaces/).fill("");
	await page.getByLabel("Adresse des Servers").fill(remoteUrl);
	await page.getByRole("button", { name: "Weiter" }).click();
	await page.getByLabel("E-Mail").fill("ada@example.org");
	await page.getByLabel("Passwort").fill("geheim12345");
	await shot(page, "9-first-start-existing");
	await page.getByRole("button", { name: "Anmelden" }).click();
	await page.evaluate(() => (location.hash = "#/settings"));
	expect(
		await visible(page, "Team"),
		"first start with an existing account: its workspace is missing",
	);
	const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("obtion.spaces") ?? "[]"));
	expect(
		kept.length === 1 && !!kept[0].server,
		`first start with an existing account: ${JSON.stringify(kept.map((w: { name: string }) => w.name))} instead of only "Team" on the server`,
	);
	await shot(page, "10-first-start-existing-done");
	await app.close();
	rmSync(other, { recursive: true, force: true });
	again.kill();
} catch (e) {
	failures.push(`crashed: ${(e as Error).stack ?? e}`);
} finally {
	remote.proc.kill();
	rmSync(userData, { recursive: true, force: true });
	rmSync(remoteData, { recursive: true, force: true });
}

// the server gone is expected to fail requests, and copies being removed to fail a last write before the
// page reloads; anything else is not
// (the server without CORS for the app in step 2: the browser's own messages about it)
const unexpected = errors.filter(
	(e) =>
		!/ERR_CONNECTION_REFUSED|Failed to fetch|WebSocket|The database connection is closing|blocked by CORS policy|net::ERR_FAILED/.test(
			e,
		),
);
for (const e of unexpected) failures.push(e);
console.log(
	failures.length
		? `desktop: ${failures.length} failure(s)\n- ${failures.join("\n- ")}`
		: `desktop: ok (screenshots in ${shots})`,
);
process.exit(failures.length ? 1 : 0);
