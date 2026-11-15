// The built app against real servers: every route and one page per kind opens without errors or a
// blank page on desktop and phone, plus the flows that need a server. Accounts come from the API
// and the browser holds them as if signed in; the sign-in page is checked once.
// It runs in German (locale de-DE, German examples): the UI labels and example titles below are
// German on purpose.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { bootServer, firstAccount, mcpTool, post, ROOT, seedExamples } from "../support/server";

const failures: string[] = [];
let checks = 0;

async function startServer(seeded: boolean, noTypes = false, workspace = true) {
	const dir = mkdtempSync(join(tmpdir(), "obtion-e2e-"));
	const env = { ...process.env, OBTION_DATA: dir };
	let { url, proc } = await bootServer({ OBTION_DATA: dir });
	// the first account (the admin) with a workspace made through the API (the app sets it up) – or
	// none, to create it on the page
	const { token: session, me } = await firstAccount(url, workspace);
	if (seeded) {
		// the examples go into that workspace while no server runs
		proc.kill();
		await proc.exited;
		await seedExamples(dir);
		if (noTypes) {
			const del = Bun.spawnSync(["bun", "tests/support/no-types.ts"], { cwd: ROOT, env });
			if (!del.stdout.toString().includes("types left: 0"))
				throw new Error(`deleting types failed: ${del.stderr.toString()}`);
		}
		({ url, proc } = await bootServer({ OBTION_DATA: dir }));
	}
	const server = { dir, url, proc, file: "", trashed: "", token: session, me };
	if (seeded && !noTypes) {
		const ws = me.workspaces[0]!.id;
		const { token } = (await post(url, `/api/workspaces/${ws}/mcp-token`, {}, session).then((r) =>
			r.json(),
		)) as { token: string };
		const mcp = async (name: string, args: unknown) =>
			/\[([\w-]+)\]/.exec(await mcpTool(url, token, name, args, `/w/${ws}/mcp`))?.[1] ?? "";
		// a 1×1 PNG below the course
		const png =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		server.file = await mcp("attach", {
			name: "sketch.png",
			base64: png,
			parent: "Kurs Datenbanken",
			description: "A sketch",
		});
		server.trashed = "ex-i-bike";
		await mcp("delete", { ref: server.trashed });
	}
	return server;
}

/** A browser context that holds the server's first account, as after signing in on the page. */
async function signedIn(
	browser: import("playwright").Browser,
	server: Awaited<ReturnType<typeof startServer>>,
	opts: import("playwright").BrowserContextOptions,
) {
	const context = await browser.newContext({ baseURL: server.url, ...opts });
	const account = { token: server.token, user: server.me.user };
	const spaces = server.me.workspaces;
	await context.addInitScript(
		({ account, spaces }) => {
			if (localStorage.getItem("obtion.account")) return;
			localStorage.setItem("obtion.account", JSON.stringify(account));
			localStorage.setItem("obtion.spaces", JSON.stringify(spaces));
			if (spaces[0]) localStorage.setItem("obtion.active", spaces[0].id);
		},
		{ account, spaces },
	);
	return context;
}

async function settle(page: Page) {
	await page.waitForSelector("#root > *", { timeout: 10000 });
	await page
		.waitForFunction(
			() =>
				!document.body.textContent.includes("Syncing") &&
				!document.body.textContent.includes("Synchronisiere"),
			null,
			{ timeout: 10000 },
		)
		.catch(() => {
			// still syncing after 10 s: check the page as it is
		});
	await page.waitForTimeout(350); // errors that come a moment after the first render count too
}

async function check(
	page: Page,
	label: string,
	path: string,
	errors: string[],
	extra?: (p: Page) => Promise<void>,
	opts: { phone?: boolean; page?: boolean } = {},
) {
	checks++;
	errors.length = 0;
	try {
		await page.goto(path, { waitUntil: "load" });
		await settle(page);
		if (extra) await extra(page);
		if (path.includes("graph"))
			await page.waitForSelector("canvas", { timeout: 3000 }).catch(() => {
				// no canvas: the check below reports a graph that rendered nothing
			});
		const boundary = page.locator("[data-error-boundary]");
		if (await boundary.count())
			failures.push(
				`${label} ${path}: error boundary: ${(await boundary.first().textContent())?.replace(/\s+/g, " ")}`,
			);
		const main = page.locator("main");
		const shown = (await main.count()) ? main : page.locator("#root");
		// biome-ignore lint/performance/useDomNodeTextContent: a blank page is about what shows; textContent would count hidden text
		const text = (await shown.innerText()).trim();
		if (path.includes("graph")) {
			if (!(await page.locator("canvas").count()) && text.length < 5)
				failures.push(`${label} ${path}: graph rendered nothing`);
		} else if (text.length < 5) failures.push(`${label} ${path}: blank page`);
		// design rules § 8: nothing sticks out sideways on a phone
		if (opts.phone && !path.includes("graph")) {
			const wide = await page.evaluate(() => {
				const m = document.querySelector("main");
				return Math.max(
					document.documentElement.scrollWidth - innerWidth,
					m ? m.scrollWidth - m.clientWidth : 0,
				);
			});
			if (wide > 1) failures.push(`${label} ${path}: ${wide}px wider than the screen`);
		}
		// a note page: one column (no right column), at most one primary button
		if (opts.page) {
			if (await page.locator("main aside").count())
				failures.push(`${label} ${path}: has a right column`);
			const primary = await page
				.locator("main button.bg-ink:visible, main a.bg-ink:visible")
				.count();
			if (primary > 1) failures.push(`${label} ${path}: ${primary} primary buttons`);
		}
	} catch (err) {
		failures.push(
			`${label} ${path}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
		);
	}
	for (const e of errors) failures.push(`${label} ${path}: ${e}`);
}

// Excalidraw 0.18.1 (the newest) listens for "unload" on the window. Chromium 158 no longer allows
// that event by default and logs the registration as an error; the handler only resets held keys.
const KNOWN_ERRORS = ["Permissions policy violation: unload is not allowed in this document."];

/** Collects the page's uncaught errors and console errors, except the known ones. */
function watch(page: Page, errors: string[]) {
	page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
	page.on("console", (m) => {
		if (m.type() === "error" && !KNOWN_ERRORS.includes(m.text()))
			errors.push(`console error: ${m.text()}`);
	});
}

const ROUTES = [
	"/",
	"/#/inbox",
	"/#/review",
	"/#/graph",
	"/#/activity",
	"/#/trash",
	"/#/settings",
	"/#/nope",
	"/#/i/sys%3Aproject",
	"/#/i/sys%3Atask",
	"/#/i/sys%3Acard",
	"/#/i/ex-type-book",
	"/#/files",
	"/#/files?kind=image",
];
// one page per kind: note with entries below, article with translation, project, sub-project, task, card, note,
// inbox item, inbox bundle, course, book, image, PDF, query page, welcome note
const ITEMS = [
	"ex-work",
	"ex-art-de",
	"ex-relaunch",
	"ex-design",
	"ex-t-pages",
	"ex-k-nf",
	"ex-n-lecture",
	"ex-i-podcast",
	"ex-i-trip",
	"ex-course",
	"ex-b-moor",
	"ex-f-diagram",
	"ex-f-sheet",
	"ex-week",
	"ex-welcome",
];

async function run() {
	const browser = await chromium.launch({ headless: true });
	const [empty, seeded, typeless, fresh] = await Promise.all([
		startServer(false),
		startServer(true),
		startServer(true, true),
		startServer(false, false, false),
	]);
	const desktop = { name: "desktop", viewport: { width: 1440, height: 900 } };
	const phone = { name: "phone", viewport: { width: 390, height: 844 }, mobile: true };
	try {
		await Promise.all([
			// the empty server: signing in finds the workspace not set up; the app sets it up
			(async () => {
				await signInPage(browser, empty);
				await pages(browser, "empty", empty, desktop);
				await pages(browser, "empty", empty, phone);
			})(),
			pages(browser, "seeded", seeded, desktop),
			pages(browser, "seeded", seeded, phone),
			sidebarOnTablet(browser, seeded),
			pages(browser, "no types", typeless, desktop),
			pages(browser, "no types", typeless, phone),
			(async () => {
				await firstWorkspace(browser, fresh);
				await twoWorkspaces(browser, fresh);
				await membersOnSettings(browser, fresh);
				await deleteAccountOnSettings(browser, fresh);
			})(),
		]);
	} finally {
		await browser.close();
		for (const h of [empty, seeded, typeless, fresh]) {
			h.proc.kill();
			await h.proc.exited;
			rmSync(h.dir, { recursive: true, force: true });
		}
	}
	if (failures.length) {
		console.error(
			`E2E smoke: ${failures.length} failure(s) in ${checks} checks:\n- ${failures.join("\n- ")}`,
		);
		process.exit(1);
	}
	console.log(
		`E2E smoke: ${checks} checks passed (empty, seeded, typeless and fresh server; desktop, phone).`,
	);
}

type Server = Awaited<ReturnType<typeof startServer>>;

/** Every route and, with data, one page per kind of item, in one browser window of the variant. */
async function pages(
	browser: import("playwright").Browser,
	serverName: string,
	server: Server,
	v: { name: string; viewport: { width: number; height: number }; mobile?: boolean },
) {
	const context = await signedIn(browser, server, {
		viewport: v.viewport,
		isMobile: !!v.mobile,
		hasTouch: !!v.mobile,
		locale: "de-DE",
	});
	const page = await context.newPage();
	const errors: string[] = [];
	watch(page, errors);
	const label = `${serverName} ${v.name}`;
	const phone = !!v.mobile;
	if (serverName === "empty" && !phone) {
		// the app has set the workspace up (made through the API: without the examples)
		await check(page, label, "/", errors, async (p) => {
			await p
				.locator("aside section[aria-label='Persönlich']")
				.getByRole("button", { name: "Typen", exact: true })
				.waitFor({ timeout: 8000 });
			if (await p.locator("aside a[href$='/i/ex-welcome']").count())
				failures.push(`${label}: the examples came along`);
		});
	}
	for (const r of ROUTES) await check(page, label, r, errors, undefined, { phone });
	if (serverName !== "empty")
		for (const id of [...ITEMS, server.file, server.trashed].filter(Boolean))
			await check(page, label, `/#/i/${encodeURIComponent(id)}`, errors, undefined, {
				phone,
				page: true,
			});
	if (phone)
		await check(
			page,
			label,
			"/#/files",
			errors,
			async (p) => {
				await p.getByRole("button", { name: "Menü", exact: true }).click();
				const menu = p.getByRole("dialog", { name: "Menü", exact: true });
				await menu.waitFor({ state: "visible" });
				// a moment to settle: a blurred backdrop just before makes headless Chromium (no GPU) slow
				const reachable = await menu
					.evaluate((el) => {
						const box = el.getBoundingClientRect();
						return el.contains(document.elementFromPoint(box.left + box.width / 2, box.top + 20));
					})
					.then(
						(ok) =>
							ok ||
							p
								.waitForFunction(
									() => {
										const el = document.querySelector("[role=dialog][aria-label='Menü']");
										if (!el) return false;
										const box = el.getBoundingClientRect();
										return el.contains(
											document.elementFromPoint(box.left + box.width / 2, box.top + 20),
										);
									},
									null,
									{ timeout: 3000 },
								)
								.then(
									() => true,
									() => false,
								),
					);
				if (!reachable) failures.push(`${label}: mobile menu is behind its backdrop`);
				await p.keyboard.press("Escape");
				await menu.waitFor({ state: "detached" });
			},
			{ phone },
		);
	if (serverName === "seeded" && !phone)
		// a diagram made with "/" in a note: a block of the text, drawn on full screen after a click on it
		await check(page, label, "/#/i/ex-course", errors, async (p) => {
			await p.locator(".cm-line").first().click();
			await p.keyboard.press("Control+End");
			await p.keyboard.press("Enter");
			await p.keyboard.type("/diagramm");
			await p.locator(".cm-slash-name", { hasText: "Diagramm" }).first().click({ timeout: 3000 });
			// a block in the text, opened by a click on it, not at once
			const block = p.locator(".cm-embed .embed-drawing-svg");
			if (
				!(await block.waitFor({ timeout: 5000 }).then(
					() => true,
					() => false,
				))
			)
				return void failures.push(`${label}: no drawing block in the text`);
			if (await p.locator(".drawing-full").count())
				failures.push(`${label}: "/diagramm" opens the diagram at once`);
			await block.click();
			const canvas = p.locator(".drawing-full canvas.interactive");
			if (
				!(await canvas.waitFor({ timeout: 20000 }).then(
					() => true,
					() => false,
				))
			)
				return void failures.push(`${label}: a click on the block does not open the drawing`);
			const box = (await canvas.boundingBox())!;
			await p.keyboard.press("r");
			await p.mouse.move(box.x + 400, box.y + 300);
			await p.mouse.down();
			await p.mouse.move(box.x + 600, box.y + 420, { steps: 5 });
			await p.mouse.up();
			// a step in the history: Back closes it, Forward opens it again, closing goes back to the note
			await p.goBack();
			if (
				!(await p
					.locator(".cm-embed .embed-drawing svg")
					.waitFor({ timeout: 10000 })
					.then(
						() => true,
						() => false,
					))
			)
				return void failures.push(
					`${label}: Back does not close the drawing, or it does not show in the note`,
				);
			await p.goForward();
			if (
				!(await canvas.waitFor({ timeout: 10000 }).then(
					() => true,
					() => false,
				))
			)
				return void failures.push(`${label}: Forward does not open the drawing again`);
			const note = p.url().split("?")[0];
			await p.locator(".drawing-close").click();
			await p
				.locator(".drawing-full")
				.waitFor({ state: "detached", timeout: 5000 })
				.catch(() => failures.push(`${label}: closing does not close the drawing`));
			if (p.url() !== note)
				failures.push(`${label}: closing does not go back to the note (${p.url()})`);
			if (await p.getByText("Diagramme", { exact: true }).count())
				failures.push(`${label}: the drawing is listed below the note`);
		});
	if (serverName === "seeded") {
		// the open panel is a step in the history: Back closes it and stays on the page
		await check(
			page,
			label,
			"/#/i/ex-relaunch",
			errors,
			async (p) => {
				await p
					.getByRole("region", { name: "Eingang" })
					.getByRole("button", { expanded: false })
					.first()
					.click();
				const panel = p.locator("[data-shelf-panel=open]");
				if (
					!(await panel.waitFor({ timeout: 3000 }).then(
						() => true,
						() => false,
					))
				)
					return void failures.push(`${label}: the tray does not open its panel`);
				// another page and Back: the panel as it was
				await p.evaluate(() => (location.hash = "#/activity"));
				await panel.waitFor({ state: "detached", timeout: 3000 }).catch(() => {
					// still there: Back below checks the panel either way
				});
				await p.goBack();
				if (
					!(await panel.waitFor({ timeout: 3000 }).then(
						() => true,
						() => false,
					))
				)
					failures.push(`${label}: Back to the page does not bring the open panel back`);
				await p.goBack();
				if (
					!(await panel.waitFor({ state: "detached", timeout: 3000 }).then(
						() => true,
						() => false,
					))
				)
					failures.push(`${label}: Back does not close the panel`);
				if (!p.url().includes("/i/ex-relaunch"))
					failures.push(`${label}: Back with the panel open leaves the page (${p.url()})`);
			},
			{ phone },
		);
	}
	await context.close();
}

/** A window as wide as a tablet or half a screen still gets the desktop layout, not the phone's. */
async function sidebarOnTablet(browser: import("playwright").Browser, server: Server) {
	const context = await signedIn(browser, server, {
		viewport: { width: 800, height: 900 },
		locale: "de-DE",
	});
	const page = await context.newPage();
	const errors: string[] = [];
	watch(page, errors);
	await check(page, "seeded tablet", "/", errors, async (p) => {
		if (!(await p.locator("aside").first().isVisible()))
			failures.push("seeded tablet: no sidebar at 800 px");
		// its button closes it, a reload keeps it closed, the button opens it again
		await p.getByRole("button", { name: "Seitenleiste schließen" }).click();
		if (await p.locator("aside").count()) failures.push("seeded tablet: sidebar did not close");
		await p.reload();
		await settle(p);
		if (await p.locator("aside").count())
			failures.push("seeded tablet: sidebar open again after a reload");
		await p.getByRole("button", { name: "Seitenleiste öffnen" }).click();
		if (!(await p.locator("aside").first().isVisible()))
			failures.push("seeded tablet: sidebar did not open");
	});
	await context.close();
}

/** Without an account the app asks to sign in; signing in on the page opens the workspace. */
async function signInPage(browser: import("playwright").Browser, server: { url: string }) {
	const context = await browser.newContext({
		baseURL: server.url,
		viewport: { width: 1440, height: 900 },
		locale: "de-DE",
	});
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
	await check(page, "sign-in", "/", errors, async (p) => {
		await p.getByLabel("E-Mail").fill("e2e@example.org");
		await p.getByLabel("Passwort").fill("secret12345");
		await p.getByRole("button", { name: "Anmelden" }).click();
		// the account's workspace was not set up yet: the app does it, without asking
		if (
			!(await p
				.locator("aside section[aria-label='Persönlich']")
				.getByRole("button", { name: "Typen", exact: true })
				.waitFor({ timeout: 8000 })
				.then(
					() => true,
					() => false,
				))
		)
			failures.push("sign-in: the workspace was not set up after signing in");
	});
	await context.close();
}

/**
 * An account without a workspace creates its first on the page, with the examples (the default),
 * then removes them in the settings and undoes that.
 */
async function firstWorkspace(browser: import("playwright").Browser, server: Server) {
	const context = await signedIn(browser, server, {
		viewport: { width: 1440, height: 900 },
		locale: "de-DE",
	});
	const page = await context.newPage();
	const errors: string[] = [];
	watch(page, errors);
	const label = "fresh light";
	const welcome = (p: Page) =>
		p.locator("aside section[aria-label='Persönlich']").getByText("So funktioniert Obtion");
	await check(page, label, "/", errors, async (p) => {
		if ((await p.getByLabel("Name").inputValue()) !== "Persönlich")
			failures.push(`${label}: the first workspace's name is not preset`);
		if (!(await p.getByRole("checkbox", { name: /Mit Beispielen starten/ }).isChecked()))
			failures.push(`${label}: "Mit Beispielen starten" is not preset`);
		await p.getByRole("button", { name: "Workspace anlegen" }).click();
		if (
			!(await welcome(p)
				.waitFor({ timeout: 8000 })
				.then(
					() => true,
					() => false,
				))
		)
			failures.push(`${label}: no welcome note after creating the workspace`);
	});
	server.me = (await fetch(`${server.url}/api/account`, {
		headers: { authorization: `Bearer ${server.token}` },
	}).then((r) => r.json())) as typeof server.me;
	// the image is embedded in the lecture note (made on this device, then uploaded)
	await check(page, label, "/#/i/ex-n-lecture", errors, async (p) => {
		const shown = await p
			.waitForFunction(
				() =>
					[...document.querySelectorAll("main img")].some(
						(i) => (i as HTMLImageElement).naturalWidth >= 600,
					),
				null,
				{ timeout: 5000 },
			)
			.then(
				() => true,
				() => false,
			);
		if (!shown) failures.push(`${label}: the diagram does not show`);
	});
	// the global settings list the workspaces; the examples are a workspace's own
	await check(page, label, "/#/settings", errors, async (p) => {
		if (await p.getByRole("button", { name: "Beispiele entfernen …" }).count())
			failures.push(`${label}: workspace settings in the global settings`);
		// a workspace's settings open in the same dialog, with the way back
		await p
			.getByRole("dialog", { name: "Einstellungen" })
			.getByRole("button", { name: /Persönlich/ })
			.click();
		const own = p.getByRole("dialog", { name: "Workspace-Einstellungen · Persönlich" });
		if (
			!(await own.waitFor({ timeout: 3000 }).then(
				() => true,
				() => false,
			))
		)
			failures.push(`${label}: the workspace's settings do not open from the list`);
		else if (!(await own.getByRole("button", { name: "Beispiele entfernen …" }).count()))
			failures.push(`${label}: the workspace's settings miss its examples`);
		await own.getByRole("button", { name: "Einstellungen" }).click();
		if (
			!(await p
				.getByRole("dialog", { name: "Einstellungen" })
				.waitFor({ timeout: 3000 })
				.then(
					() => true,
					() => false,
				))
		)
			failures.push(`${label}: no way back from a workspace's settings`);
	});
	await check(page, label, "/", errors, async (p) => {
		await p.evaluate(
			() => (location.hash = `#/w/${localStorage.getItem("obtion.active")}/settings`),
		);
		await p.getByRole("button", { name: "Beispiele entfernen …" }).click();
		const dialog = p.getByRole("dialog");
		// nothing was changed yet: every example is chosen
		const unchosen = await dialog.getByRole("checkbox", { checked: false }).count();
		if (unchosen) failures.push(`${label}: ${unchosen} untouched examples count as changed`);
		await dialog.getByRole("button", { name: /Einträge entfernen/ }).click();
		const toast = p
			.locator("[data-sonner-toast]")
			.filter({ hasText: "Beispiele entfernt" })
			.first();
		if (
			!(await toast.waitFor({ timeout: 3000 }).then(
				() => true,
				() => false,
			))
		)
			failures.push(`${label}: no notice "Beispiele entfernt"`);
		if (await welcome(p).count()) failures.push(`${label}: the welcome note is still pinned`);
		await toast.getByRole("button", { name: /Rückgängig/ }).click();
		if (
			!(await welcome(p)
				.waitFor({ timeout: 3000 })
				.then(
					() => true,
					() => false,
				))
		)
			failures.push(`${label}: "Rückgängig" did not bring the examples back`);
	});
	await context.close();
}

/**
 * A second workspace next to the first: created from the sidebar, without the examples; the
 * inbox is one list of both and shows one when chosen (remembered over a reload, the sidebar
 * follows); a type page can be pinned; a pinned area moves into the other workspace; the new
 * workspace comes first, and the blocks change places from their menu and by dragging (also into
 * the empty space below them).
 */
async function twoWorkspaces(browser: import("playwright").Browser, server: Server) {
	const personal = server.me.workspaces[0]!.id;
	const context = await signedIn(browser, server, {
		viewport: { width: 1440, height: 900 },
		locale: "de-DE",
	});
	const page = await context.newPage();
	const errors: string[] = [];
	watch(page, errors);
	const label = "two workspaces";
	const firma = (p: Page) => p.locator("aside section[aria-label='Firma']");
	await check(page, label, `/#/w/${personal}/`, errors, async (p) => {
		await p.getByRole("button", { name: "Workspaces auswählen" }).click();
		await p.getByText("Neuer Workspace").click();
		const dialog = p.getByRole("dialog");
		await dialog.getByLabel("Name").fill("Firma");
		await dialog.getByRole("checkbox", { name: /Mit Beispielen starten/ }).uncheck();
		await dialog.getByRole("button", { name: "Workspace anlegen" }).click();
		if (
			!(await firma(p)
				.getByRole("button", { name: "Typen", exact: true })
				.waitFor({ timeout: 8000 })
				.then(
					() => true,
					() => false,
				))
		)
			failures.push(`${label}: "Firma" not created and set up from the sidebar`);
		if (await firma(p).locator("a[href$='/i/ex-welcome']").count())
			failures.push(`${label}: "Firma" got the examples`);
		if (!(await p.locator("aside section[aria-label='Persönlich'] a[href$='/i/ex-work']").count()))
			failures.push(`${label}: the first workspace's block lost its pinned items`);
	});
	await check(page, label, "/#/inbox", errors, async (p) => {
		const panel = p.locator("[data-shelf-panel]");
		const chips = panel.getByRole("group").getByRole("button");
		if (
			(await chips.allInnerTexts()).map((x) => x.replace(/\s*\d+$/, "")).join(",") !==
			"Alle,Firma,Persönlich"
		)
			failures.push(`${label}: inbox filter is ${(await chips.allInnerTexts()).join(", ")}`);
		await chips.filter({ hasText: "Firma" }).click();
		await p.reload();
		await settle(p);
		await p.evaluate(() => (location.hash = "#/inbox"));
		await panel.waitFor({ timeout: 3000 });
		if (
			(await panel.locator("[aria-pressed=true]").textContent())?.replace(/\s*\d+$/, "") !== "Firma"
		)
			failures.push(`${label}: the inbox filter is not remembered`);
		if (await p.locator("aside section[aria-label='Persönlich']").count())
			failures.push(`${label}: the sidebar still shows the workspace left out`);
		await panel.getByRole("button", { name: /^Alle/ }).click();
	});
	await check(page, label, `/#/w/${personal}/i/sys%3Aproject`, errors, async (p) => {
		await p.locator("main").getByRole("button", { name: "Mehr" }).first().click();
		await p.getByText("Anheften", { exact: true }).click();
		if (
			!(await p
				.locator("aside section[aria-label='Persönlich']")
				.getByText("Projekte", { exact: true })
				.first()
				.waitFor({ timeout: 3000 })
				.then(
					() => true,
					() => false,
				))
		)
			failures.push(`${label}: the pinned type page is not in the sidebar`);
	});
	await check(page, label, `/#/w/${personal}/i/ex-work`, errors, async (p) => {
		await p.locator("main").getByRole("button", { name: "Mehr" }).first().click();
		await p.getByText("In anderen Workspace verschieben").click();
		await p.getByRole("dialog").getByRole("button", { name: "Firma" }).click();
		const ask = p.getByRole("dialog").getByRole("button", { name: "Verschieben" });
		if (
			await ask.waitFor({ timeout: 3000 }).then(
				() => true,
				() => false,
			)
		)
			await ask.click();
		if (
			!(await firma(p)
				.getByText("Arbeit")
				.waitFor({ timeout: 8000 })
				.then(
					() => true,
					() => false,
				))
		)
			failures.push(`${label}: "Arbeit" did not move into "Firma"`);
		if (await p.locator("aside section[aria-label='Persönlich'] a[href$='/i/ex-work']").count())
			failures.push(`${label}: "Arbeit" is still in "Persönlich"`);
	});
	// the blocks in the sidebar change places: from the "…" menu, then by dragging a name; the server keeps the order
	await check(page, label, `/#/w/${personal}/`, errors, async (p) => {
		const blocks = () =>
			p
				.locator("aside section[aria-label]")
				.evaluateAll((s) => s.map((x) => x.getAttribute("aria-label")).join(","));
		const order = async () =>
			(
				(
					await (
						await fetch(`${server.url}/api/account`, {
							headers: { authorization: `Bearer ${server.token}` },
						})
					).json()
				).workspaces as { name: string }[]
			)
				.map((w) => w.name)
				.join(",");
		if ((await blocks()) !== "Firma,Persönlich")
			failures.push(`${label}: the new workspace is not on top: ${await blocks()}`);
		await firma(p).getByRole("button", { name: "Aktionen für Firma" }).click();
		await p.locator("[data-popover]").getByRole("button", { name: "Nach unten" }).click();
		await p
			.waitForFunction(
				() =>
					[...document.querySelectorAll("aside section[aria-label]")]
						.map((x) => x.getAttribute("aria-label"))
						.join() === "Persönlich,Firma",
				undefined,
				{ timeout: 3000 },
			)
			.catch(() => {
				// not in that order in time: the check below reports it
			});
		if ((await blocks()) !== "Persönlich,Firma")
			failures.push(`${label}: "Nach unten" did not move "Firma" down: ${await blocks()}`);
		if ((await order()) !== "Persönlich,Firma")
			failures.push(`${label}: the server did not keep the order: ${await order()}`);
		await firma(p)
			.locator("[draggable=true]")
			.first()
			.dragTo(p.locator("aside section[aria-label='Persönlich'] a[href$='/i/ex-welcome']"), {
				targetPosition: { x: 10, y: 2 },
			});
		await p
			.waitForFunction(
				() =>
					[...document.querySelectorAll("aside section[aria-label]")]
						.map((x) => x.getAttribute("aria-label"))
						.join() === "Firma,Persönlich",
				undefined,
				{ timeout: 3000 },
			)
			.catch(() => {
				// not in that order in time: the check below reports it
			});
		if ((await blocks()) !== "Firma,Persönlich")
			failures.push(`${label}: dragging "Firma" above did not move it: ${await blocks()}`);
		await p.reload();
		await settle(p);
		if ((await blocks()) !== "Firma,Persönlich")
			failures.push(`${label}: the order is lost after a reload: ${await blocks()}`);
		// let go anywhere: the top block dragged into the empty space at the bottom goes last
		const area = p.locator("aside div.overflow-y-auto").first();
		const h = (await area.boundingBox())!.height;
		await firma(p)
			.locator("[draggable=true]")
			.first()
			.dragTo(area, { targetPosition: { x: 100, y: h - 10 } });
		await p
			.waitForFunction(
				() =>
					[...document.querySelectorAll("aside section[aria-label]")]
						.map((x) => x.getAttribute("aria-label"))
						.join() === "Persönlich,Firma",
				undefined,
				{ timeout: 3000 },
			)
			.catch(() => {
				// not in that order in time: the check below reports it
			});
		if ((await blocks()) !== "Persönlich,Firma")
			failures.push(
				`${label}: dragged into the empty space below, "Firma" did not go last: ${await blocks()}`,
			);
	});
	await context.close();
}

/**
 * An owner manages a workspace's people in its settings: a new invite link shows in the list of
 * open links (who made it, until when) and one is revoked; a member is made owner and member
 * again, then removed – each confirmed first.
 */
async function membersOnSettings(browser: import("playwright").Browser, server: Server) {
	const api = (path: string, init: RequestInit = {}, token = server.token) =>
		fetch(server.url + path, {
			...init,
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		}).then((r) => r.json());
	// the first workspace, not "Firma" from before
	const ws = ((await api("/api/account")).workspaces as { id: string; name: string }[]).find(
		(w) => w.name === "Persönlich",
	)!.id;
	const invite = async () =>
		(await api(`/api/workspaces/${ws}/invites`, { method: "POST", body: "{}" })).code as string;
	const { token: bea } = await api("/api/account/signup", {
		method: "POST",
		body: JSON.stringify({
			name: "Bea",
			email: "bea@example.org",
			password: "secret12345",
			invite: await invite(),
		}),
	});
	const old = await invite();
	// a link Bea made while an owner: it goes when Bea is removed
	const setBea = async (r: string) => {
		const id = (await api(`/api/workspaces/${ws}/members`)).find(
			(m: { name: string }) => m.name === "Bea",
		).id;
		await api(`/api/workspaces/${ws}/members/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ role: r }),
		});
	};
	await setBea("owner");
	const { code: beas } = await api(
		`/api/workspaces/${ws}/invites`,
		{ method: "POST", body: "{}" },
		bea,
	);
	await setBea("member");
	const role = async (name = "Bea") =>
		(await api(`/api/workspaces/${ws}/members`)).find((m: { name: string }) => m.name === name)
			?.role as string | undefined;
	let cem = "";
	const context = await signedIn(browser, server, {
		viewport: { width: 1440, height: 900 },
		locale: "de-DE",
	});
	const page = await context.newPage();
	const errors: string[] = [];
	watch(page, errors);
	const label = "members";
	await check(page, label, `/#/w/${ws}/settings`, errors, async (p) => {
		const links = p.getByRole("list", { name: "Einladungslinks" }).getByRole("listitem");
		await links.first().waitFor({ timeout: 5000 });
		if ((await links.count()) !== 2)
			failures.push(
				`${label}: ${await links.count()} open links instead of the two made by the API`,
			);
		const member = (await links.filter({ hasText: old }).textContent()) ?? "";
		if (!member.includes("Mitglied · Von E2E am"))
			failures.push(`${label}: the link for a member does not say so: ${member}`);
		// a link for an owner, from the menu: whoever joins with it is one, and only one person can
		await p.getByRole("button", { name: "Neuer Link" }).click();
		await p.locator("[data-popover]").getByRole("button", { name: "Für einen Besitzer" }).click();
		await links.nth(2).waitFor({ timeout: 3000 });
		const made = (await links.first().textContent()) ?? "";
		if (!made.includes("Besitzer · Von E2E am"))
			failures.push(`${label}: the new link does not say its role and who made it: ${made}`);
		const code = ((await links.first().locator("code").textContent()) ?? "").split("/join/")[1]!;
		const signup = (email: string) =>
			api("/api/account/signup", {
				method: "POST",
				body: JSON.stringify({
					name: email.split("@")[0],
					email,
					password: "secret12345",
					invite: code,
				}),
			});
		cem = (await signup("cem@example.org")).token;
		if ((await role("cem")) !== "owner")
			failures.push(`${label}: who joined with the owner link is no owner`);
		if ((await fetch(`${server.url}/api/invites/${code}`)).status !== 404)
			failures.push(`${label}: the single-use link still works after its first use`);
		// revoking asks first: cancelled, the link stays; confirmed, it goes
		await links.filter({ hasText: old }).getByRole("button", { name: "Widerrufen" }).click();
		await p
			.getByRole("dialog", { name: "Link widerrufen?" })
			.getByRole("button", { name: "Abbrechen" })
			.click();
		await p
			.getByRole("dialog", { name: "Link widerrufen?" })
			.waitFor({ state: "detached", timeout: 3000 });
		if ((await fetch(`${server.url}/api/invites/${old}`)).status !== 200)
			failures.push(`${label}: a cancelled revoke took the link back`);
		await links.filter({ hasText: old }).getByRole("button", { name: "Widerrufen" }).click();
		await p
			.getByRole("dialog", { name: "Link widerrufen?" })
			.getByRole("button", { name: "Widerrufen", exact: true })
			.click();
		await links.filter({ hasText: old }).waitFor({ state: "detached", timeout: 3000 });
		if ((await fetch(`${server.url}/api/invites/${old}`)).status !== 404)
			failures.push(`${label}: the revoked link still works`);

		const beaRow = p
			.getByRole("list", { name: "Mitglieder" })
			.getByRole("listitem")
			.filter({ hasText: "Bea" });
		const choose = async (item: string) => {
			await beaRow.getByRole("button", { name: "Aktionen für Bea" }).click();
			await p.locator("[data-popover]").getByRole("button", { name: item, exact: true }).click();
			await p.getByRole("dialog").getByRole("button", { name: item, exact: true }).click();
		};
		await choose("Zum Besitzer machen");
		await beaRow.getByText("Besitzer").waitFor({ timeout: 3000 });
		if ((await role()) !== "owner") failures.push(`${label}: Bea is no owner on the server`);
		await choose("Zum Mitglied machen");
		await beaRow.getByText("Mitglied", { exact: true }).waitFor({ timeout: 3000 });
		if ((await role()) !== "member") failures.push(`${label}: Bea is no member on the server`);
		await choose("Entfernen");
		await beaRow.waitFor({ state: "detached", timeout: 3000 });
		if (
			!(await links
				.filter({ hasText: beas })
				.waitFor({ state: "detached", timeout: 3000 })
				.then(
					() => true,
					() => false,
				))
		)
			failures.push(`${label}: the removed member's link is still listed`);
		if (await role()) failures.push(`${label}: Bea is still in the workspace on the server`);
	});
	await context.close();
	// the server's only account again: deleting it later leaves the server as new
	for (const token of [bea, cem])
		if (token)
			await api(
				"/api/account",
				{ method: "DELETE", body: JSON.stringify({ password: "secret12345" }) },
				token,
			);
}

async function deleteAccountOnSettings(browser: import("playwright").Browser, server: Server) {
	const context = await signedIn(browser, server, { locale: "de-DE" });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/", { waitUntil: "load" });
	await settle(page);
	await check(page, "delete account", "/#/settings", errors, async (p) => {
		await p.getByRole("button", { name: "Konto endgültig löschen", exact: true }).click();
		const dialog = p.getByRole("dialog", { name: "Konto endgültig löschen" });
		await dialog.getByLabel("Passwort").fill("wrong");
		await dialog.getByRole("button", { name: "Konto endgültig löschen", exact: true }).click();
		await dialog.getByRole("alert").filter({ hasText: "Das Passwort stimmt nicht." }).waitFor();
		await dialog.getByLabel("Passwort").fill("secret12345");
		await dialog.getByRole("button", { name: "Konto endgültig löschen", exact: true }).click();
		await dialog.getByRole("alert").filter({ hasText: "letzter Owner" }).waitFor();
		await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
		// Use the existing workspace API so the final confirmation also cleans an open local replica.
		const me = await fetch(`${server.url}/api/account`, {
			headers: { authorization: `Bearer ${server.token}` },
		}).then((r) => r.json());
		for (const w of me.workspaces) {
			const response = await fetch(`${server.url}/api/workspaces/${w.id}`, {
				method: "DELETE",
				headers: { authorization: `Bearer ${server.token}` },
			});
			if (!response.ok) throw new Error("could not delete test workspace");
		}
		await p.getByRole("button", { name: "Konto endgültig löschen", exact: true }).click();
		await dialog.getByLabel("Passwort").fill("secret12345");
		await dialog.getByRole("button", { name: "Konto endgültig löschen", exact: true }).click();
		await p.getByRole("button", { name: "Konto anlegen", exact: true }).waitFor();
		const stored = await p.evaluate(() => ({
			account: JSON.parse(localStorage.getItem("obtion.account") ?? "null"),
			spaces: JSON.parse(localStorage.getItem("obtion.spaces") ?? "[]"),
		}));
		if (stored.account || stored.spaces.length)
			throw new Error("account or workspace metadata remained on this device");
		const databases = await p.evaluate(async () =>
			(await indexedDB.databases()).map((db) => db.name),
		);
		if (
			databases.some(
				(name) => name === "obtion" || name === "obtion-files" || name?.startsWith("obtion-ws-"),
			)
		)
			throw new Error("workspace database remained on this device");
	});
	await context.close();
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
