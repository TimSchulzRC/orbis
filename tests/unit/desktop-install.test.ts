// The desktop app installs an update itself on a Mac: it finds its .app, checks the download, and a
// script of its own swaps the app once it has quit and starts the new one.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appBundle, install, replaceableApp, SWAP } from "../../apps/desktop/src/install";
import { pickUpdate } from "../../apps/desktop/src/updates";

const dirs: string[] = [];
const tempDir = () => {
	const d = mkdtempSync(join(tmpdir(), "orbis-install-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("the .app of the running program", () => {
	expect(appBundle("/Applications/Orbis.app/Contents/MacOS/Orbis")).toBe("/Applications/Orbis.app");
	expect(appBundle("/Users/a/My Apps/Orbis.app/Contents/MacOS/Orbis")).toBe(
		"/Users/a/My Apps/Orbis.app",
	);
	expect(appBundle("/usr/lib/orbis/orbis")).toBeNull();
	expect(appBundle("C:\\Program Files\\Orbis\\Orbis.exe")).toBeNull();
});

test("only a Mac app in a writable folder replaces itself", () => {
	const dir = tempDir();
	const exe = join(dir, "Orbis.app/Contents/MacOS/Orbis");
	expect(replaceableApp("darwin", exe)).toBe(join(dir, "Orbis.app"));
	expect(replaceableApp("linux", exe)).toBeNull();
	expect(replaceableApp("win32", exe)).toBeNull();
	// like the DMG or App Translocation: read-only
	chmodSync(dir, 0o555);
	try {
		expect(replaceableApp("darwin", exe)).toBe(
			process.getuid?.() === 0 ? join(dir, "Orbis.app") : null,
		);
	} finally {
		chmodSync(dir, 0o755);
	}
});

test("the update carries the installer's SHA-256 from GitHub", () => {
	const hex = "a".repeat(64);
	const name = "Orbis-0.0.2-mac-arm64.dmg";
	const releases = [
		{
			tag_name: "v0.0.2",
			draft: false,
			assets: [{ name, browser_download_url: `https://dl/${name}`, digest: `sha256:${hex}` }],
		},
	];
	const mac = { platform: "darwin", arch: "arm64", appImage: false };
	expect(pickUpdate(releases, "0.0.1", mac)).toEqual({
		version: "0.0.2",
		url: `https://dl/${name}`,
		sha256: hex,
	});
	releases[0]!.assets[0]!.digest = null as unknown as string;
	expect(pickUpdate(releases, "0.0.1", mac)?.sha256).toBeUndefined();
});

test("a download with another SHA-256, or without one, is not installed", async () => {
	const dir = tempDir();
	const fetch = async () => new Response("not the DMG");
	await expect(
		install(
			{ version: "0.0.2", url: "https://dl/x.dmg", sha256: "0".repeat(64) },
			{ app: join(dir, "Orbis.app"), dir: join(dir, "update"), pid: 1, args: [], fetch },
		),
	).rejects.toThrow("SHA-256");
	await expect(
		install(
			{ version: "0.0.2", url: "https://dl/x.dmg" },
			{ app: join(dir, "Orbis.app"), dir: join(dir, "update"), pid: 1, args: [], fetch },
		),
	).rejects.toThrow("no SHA-256");
	expect(existsSync(join(dir, "update/Orbis.app"))).toBe(false);
});

/** SWAP with a stand-in for macOS's `open`, which writes down how it was called. */
function swap(pid: number, next: string, app: string, args: string[]) {
	const bin = tempDir();
	const log = join(bin, "open.log");
	writeFileSync(join(bin, "open"), `#!/bin/sh\nprintf "%s " "$@" > ${log}\n`, { mode: 0o755 });
	const r = spawnSync("/bin/sh", ["-c", SWAP, "orbis-update", String(pid), next, app, ...args], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
		encoding: "utf8",
	});
	return { status: r.status, opened: existsSync(log) ? readFileSync(log, "utf8").trim() : null };
}

const fakeApp = (path: string, version: string) => {
	mkdirSync(join(path, "Contents"), { recursive: true });
	writeFileSync(join(path, "Contents/version"), version);
};

test("the script puts the new app in place of the old one and starts it with its arguments", () => {
	const dir = tempDir();
	const app = join(dir, "Applications/Orbis.app");
	const next = join(dir, "update/Orbis.app");
	fakeApp(app, "old");
	fakeApp(next, "new");
	// a process that has already quit
	const gone = spawnSync("true").pid;
	const r = swap(gone, next, app, ["--user-data-dir=/x"]);
	expect(r.status).toBe(0);
	expect(readFileSync(join(app, "Contents/version"), "utf8")).toBe("new");
	expect(existsSync(next)).toBe(false);
	expect(existsSync(`${app}.old`)).toBe(false);
	expect(r.opened).toBe(`-n ${app} --args --user-data-dir=/x`);
});

test("the script keeps the old app when the new one is missing", () => {
	const dir = tempDir();
	const app = join(dir, "Orbis.app");
	fakeApp(app, "old");
	const r = swap(spawnSync("true").pid, join(dir, "missing.app"), app, []);
	expect(readFileSync(join(app, "Contents/version"), "utf8")).toBe("old");
	expect(existsSync(`${app}.old`)).toBe(false);
	expect(r.opened).toBe(`-n ${app} --args`);
});
