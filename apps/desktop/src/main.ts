// The desktop app: the web app's interface (apps/web, built with --mode desktop) in a window of
// its own, served from obtion://app, and the server on this device for local workspaces
// (local.ts). Further servers are connected in the app itself, like on the web.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme, net, protocol, shell } from "electron";
import { iconPath } from "../../server/src/icons";
import { LocalServer } from "./local";
import { pickUpdate, RELEASES, type Release } from "./updates";

const SCHEME = "obtion";
/** The app's pages: their origin is obtion://app, which every Obtion server lets call its API. */
const APP_URL = `${SCHEME}://app/`;
/** In development the pages come from Vite (`bun run dev` in apps/desktop) instead. */
const DEV_URL = process.env.OBTION_RENDERER_URL;

// standard and secure: storage, IndexedDB and the origin private file system work as on https
protocol.registerSchemesAsPrivileged([
	{
		scheme: SCHEME,
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
			stream: true,
		},
	},
]);

if (!app.requestSingleInstanceLock()) app.quit();

const userData = app.getPath("userData");
/** The language of the first workspace's name (the app's own is chosen in its settings). */
const lang = () => (app.getLocale().startsWith("de") ? "de" : "en");
/** dist/ of apps/desktop, inside the packaged app's archive or not. */
const here = join(app.getAppPath(), "dist");
const renderer = join(here, "renderer");
/**
 * The icon in the colour of this version's channel (scripts/build.ts). A package has it from
 * electron-builder; outside one, Electron would show its own, so the window and the Dock get it.
 */
const icon = join(here, "icon.png");
/**
 * The build version, the way the server takes it (OBTION_BUILD_VERSION): a release's
 * (release.yml), or "dev" outside a package and in builds of the Desktop workflow
 * (package.json: 0.0.0-dev).
 */
const version = app.isPackaged && !app.getVersion().endsWith("-dev") ? app.getVersion() : "dev";
const exe = process.platform === "win32" ? "obtion-server.exe" : "obtion-server";
const server = new LocalServer(
	join(userData, "server"),
	app.isPackaged
		? { cmd: join(process.resourcesPath, "server", exe), args: [] }
		: { cmd: process.env.BUN ?? "bun", args: [join(app.getAppPath(), "../server/src/index.ts")] },
	{
		OBTION_BUILD_VERSION: version,
		...(DEV_URL ? { OBTION_APP_ORIGINS: new URL(DEV_URL).origin } : {}),
	},
);

/**
 * The app's files for obtion://app/<path>; every other path is the app itself (index.html).
 * /icon.svg & co. in the colour of this version's channel, like the server answers them.
 */
function serve(req: Request): Promise<Response> {
	const asked = iconPath(decodeURIComponent(new URL(req.url).pathname), version);
	const path = normalize(join(renderer, asked));
	const inside = path.startsWith(renderer + sep) && existsSync(path) && statSync(path).isFile();
	return net.fetch(pathToFileURL(inside ? path : join(renderer, "index.html")).toString());
}

// ---------- the window ----------

const stateFile = join(userData, "window.json");
type Bounds = { x?: number; y?: number; width: number; height: number; maximized?: boolean };
const readBounds = (): Bounds => {
	try {
		return JSON.parse(readFileSync(stateFile, "utf8"));
	} catch {
		return { width: 1280, height: 840 };
	}
};

let win: BrowserWindow | null = null;

// no title bar: the app's top row is the window's (packages/ui: titlebar in styles.css). On a Mac
// the traffic lights sit in it; elsewhere the window's buttons are drawn over its right end
const TOP_ROW = 44;
const mac = process.platform === "darwin";
/** The page's background (packages/ui/src/theme.css) under the window's buttons, and their colour. */
const overlay = () =>
	nativeTheme.shouldUseDarkColors
		? { color: "#121212", symbolColor: "#a3a3a3", height: TOP_ROW }
		: { color: "#f7f6f3", symbolColor: "#6b6b6b", height: TOP_ROW };
nativeTheme.on("updated", () => {
	if (win && !mac) win.setTitleBarOverlay(overlay());
});

function createWindow() {
	const bounds = readBounds();
	win = new BrowserWindow({
		...bounds,
		minWidth: 360,
		minHeight: 480,
		show: false,
		title: "Obtion",
		titleBarStyle: "hidden",
		...(mac ? { trafficLightPosition: { x: 16, y: 15 } } : { titleBarOverlay: overlay() }),
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#191919" : "#f7f6f3",
		...(process.platform === "linux" || !app.isPackaged ? { icon } : {}),
		webPreferences: {
			preload: join(here, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
			// servers in the LAN often speak plain http (http://nas:8480); the app's pages are secure
			allowRunningInsecureContent: true,
		},
	});
	if (bounds.maximized) win.maximize();
	win.once("ready-to-show", () => win?.show());
	win.on("close", () => {
		if (!win) return;
		writeFileSync(
			stateFile,
			JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }),
		);
	});
	win.on("closed", () => (win = null));
	// in full screen a Mac shows no traffic lights: the row needs no room for them
	const fullScreen = (on: boolean) =>
		void win?.webContents.executeJavaScript(
			`document.documentElement.toggleAttribute("data-fullscreen", ${on})`,
		);
	win.on("enter-full-screen", () => fullScreen(true));
	win.on("leave-full-screen", () => fullScreen(false));

	// links to elsewhere open in the browser; the window stays the app
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (e, url) => {
		if (url.startsWith(APP_URL) || (DEV_URL && url.startsWith(DEV_URL))) return;
		e.preventDefault();
		if (/^(https?|mailto):/.test(url)) void shell.openExternal(url);
	});
	void win.loadURL(DEV_URL ?? APP_URL);
}

// what the page asks for (preload.ts)
ipcMain.on("obtion:local", (e) => (e.returnValue = server.local));
ipcMain.handle("obtion:renew", () => server.signIn(lang(), true));
// a newer release of this version's channel with an installer for this system (updates.ts)
ipcMain.handle("obtion:update", async () => {
	if (version === "dev") return null;
	const res = await net.fetch(RELEASES, { headers: { accept: "application/vnd.github+json" } });
	if (!res.ok) throw new Error(`GitHub: ${res.status}`);
	return pickUpdate((await res.json()) as Release[], version, {
		platform: process.platform,
		arch: process.arch,
		appImage: !!process.env.APPIMAGE,
	});
});
// the theme chosen in the app (system, light, dark): the window's buttons and menus follow it
ipcMain.on("obtion:theme", (_e, choice: unknown) => {
	if (choice === "system" || choice === "light" || choice === "dark")
		nativeTheme.themeSource = choice;
});

app.on("second-instance", () => {
	if (!win) return createWindow();
	if (win.isMinimized()) win.restore();
	win.focus();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
	if (!win && server.local) createWindow();
});
app.on("will-quit", () => server.stop());

app.whenReady().then(async () => {
	if (mac && !app.isPackaged) app.dock?.setIcon(icon);
	protocol.handle(SCHEME, serve);
	try {
		await server.start(lang());
	} catch (e) {
		const { dialog } = await import("electron");
		dialog.showErrorBox("Obtion", (e as Error).message);
		app.exit(1);
		return;
	}
	createWindow();
});
