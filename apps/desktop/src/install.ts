// Installing an update in the app (macOS): the new app comes out of the release's DMG, replaces
// this one once it has quit, and starts. Squirrel (electron-updater) would need a Developer ID
// signature, and this app is only signed ad hoc (electron-builder.yml). Without electron, so the
// tests can load it.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { Update } from "./updates";

const run = promisify(execFile);
/** Electron's net.fetch: the system's proxies and certificates, like the browser */
type Fetch = (url: string) => Promise<Response>;

/** The .app the program `execPath` belongs to, or null outside one. */
export function appBundle(execPath: string): string | null {
	return /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1] ?? null;
}

/**
 * The app this program can replace: its .app, when the folder holding it is writable. Not when it
 * runs from the DMG or from where macOS moved it to start it (App Translocation): both are
 * read-only, and the installer has to be opened by hand there.
 */
export function replaceableApp(platform: string, execPath: string): string | null {
	if (platform !== "darwin") return null;
	const app = appBundle(execPath);
	if (!app) return null;
	try {
		accessSync(dirname(app), constants.W_OK);
		return app;
	} catch {
		return null;
	}
}

/**
 * Waits until the running app (`$1`) has quit, puts the new app (`$2`) where the old one (`$3`) was,
 * and starts it with the old one's arguments. Keeps the old app when the new one cannot take its
 * place, and does nothing when the app is still running after a minute.
 */
export const SWAP = `pid=$1 new=$2 app=$3; shift 3
i=0
while kill -0 "$pid" 2>/dev/null; do
	i=$((i + 1)); [ "$i" -gt 600 ] && exit 1
	sleep 0.1
done
rm -rf "$app.old"
if mv "$app" "$app.old"; then
	if mv "$new" "$app"; then rm -rf "$app.old"; else mv "$app.old" "$app"; fi
fi
open -n "$app" --args "$@"`;

/** Downloads `url` to `file`; throws when its SHA-256 is not `sha256`, or there is none to check. */
async function download(fetch: Fetch, url: string, file: string, sha256?: string) {
	if (!sha256) throw new Error("download: no SHA-256 to check it against");
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new Error(`download: ${res.status}`);
	const hash = createHash("sha256");
	const body = Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream);
	body.on("data", (chunk: Buffer) => hash.update(chunk));
	await pipeline(body, createWriteStream(file));
	const got = hash.digest("hex");
	if (got !== sha256) throw new Error(`download: SHA-256 ${got}, expected ${sha256}`);
}

/**
 * Gets `update` ready in `dir` and hands it to a process of its own (SWAP), which replaces `app`
 * once this app (`pid`) has quit: the caller quits right after. Throws, with nothing changed, when
 * the download or the DMG is not what it should be.
 */
export async function install(
	update: Update,
	opts: { app: string; dir: string; pid: number; args: string[]; fetch: Fetch },
): Promise<void> {
	const { dir } = opts;
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const dmg = join(dir, "update.dmg");
	const mount = join(dir, "dmg");
	const next = join(dir, "Orbis.app");
	await download(opts.fetch, update.url, dmg, update.sha256);
	await run("hdiutil", [
		"attach",
		dmg,
		"-nobrowse",
		"-readonly",
		"-noautoopen",
		"-mountpoint",
		mount,
	]);
	try {
		const found = readdirSync(mount).find((n) => n.endsWith(".app"));
		if (!found) throw new Error("no app in the DMG");
		// ditto keeps the signature, the symlinks and the attributes of the bundle
		await run("ditto", [join(mount, found), next]);
	} finally {
		await run("hdiutil", ["detach", mount, "-force"]).catch(() => {
			// a mount that stays is gone with the next restart; the copy is complete either way
		});
	}
	const { stdout } = await run("plutil", [
		"-extract",
		"CFBundleShortVersionString",
		"raw",
		join(next, "Contents/Info.plist"),
	]);
	if (stdout.trim() !== update.version)
		throw new Error(`the DMG holds ${stdout.trim()}, not ${update.version}`);
	spawn("/bin/sh", ["-c", SWAP, "orbis-update", String(opts.pid), next, opts.app, ...opts.args], {
		detached: true,
		stdio: "ignore",
	}).unref();
}
