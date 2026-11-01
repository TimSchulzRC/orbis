// The desktop app: the web app's interface (apps/web, built with --mode desktop) in a window of
// its own, served from obtion://app, and the server on this device for local workspaces
// (local.ts). Further servers are connected in the app itself, like on the web.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme, net, protocol, shell } from "electron";
import { LocalServer } from "./local";

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
const exe = process.platform === "win32" ? "obtion-server.exe" : "obtion-server";
const server = new LocalServer(
	join(userData, "server"),
	app.isPackaged
		? { cmd: join(process.resourcesPath, "server", exe), args: [] }
		: { cmd: process.env.BUN ?? "bun", args: [join(app.getAppPath(), "../server/src/index.ts")] },
	{
		OBTION_BUILD_VERSION: app.isPackaged ? app.getVersion() : "dev",
		...(DEV_URL ? { OBTION_APP_ORIGINS: new URL(DEV_URL).origin } : {}),
	},
);

/** The app's files for obtion://app/<path>; every other path is the app itself (index.html). */
function serve(req: Request): Promise<Response> {
	const path = normalize(join(renderer, decodeURIComponent(new URL(req.url).pathname)));
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

function createWindow() {
	const bounds = readBounds();
	win = new BrowserWindow({
		...bounds,
		minWidth: 360,
		minHeight: 480,
		show: false,
		title: "Obtion",
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#191919" : "#f7f6f3",
		...(process.platform === "linux" ? { icon: join(here, "icon.png") } : {}),
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
