// The desktop app's updates: the newest release of its own channel with an installer for this system.
import { expect, test } from "bun:test";
import {
	compareVersions,
	isInstallerFor,
	pickUpdate,
	type Release,
} from "../../apps/desktop/src/updates";

test("versions in semver order, a release after its nightlies", () => {
	const sorted = [
		"0.0.2-nightly.20261030.2",
		"0.0.2-nightly.20261030.10",
		"0.0.2-nightly.20261031.1",
		"0.0.2",
		"0.0.3-nightly.20261101.1",
		"0.1.0",
	];
	for (let i = 1; i < sorted.length; i++) {
		expect(compareVersions(sorted[i - 1]!, sorted[i]!)).toBeLessThan(0);
		expect(compareVersions(sorted[i]!, sorted[i - 1]!)).toBeGreaterThan(0);
	}
	expect(compareVersions("0.0.2", "0.0.2")).toBe(0);
});

const mac = { platform: "darwin", arch: "arm64", appImage: false };
const assets = (v: string) =>
	[
		`Orbis-${v}-mac-arm64.dmg`,
		`Orbis-${v}-mac-x64.dmg`,
		`Orbis-${v}-win-x64.exe`,
		`Orbis-${v}-linux-x86_64.AppImage`,
		`Orbis-${v}-linux-amd64.deb`,
	].map((name) => ({ name, browser_download_url: `https://dl/${name}` }));
const release = (v: string, withAssets = true): Release => ({
	tag_name: `v${v}`,
	draft: false,
	assets: withAssets ? assets(v) : [],
});

test("the installer for this system", () => {
	const names = assets("0.0.2").map((a) => a.name);
	const pick = (sys: typeof mac) => names.filter((n) => isInstallerFor(n, sys));
	expect(pick(mac)).toEqual(["Orbis-0.0.2-mac-arm64.dmg"]);
	expect(pick({ ...mac, arch: "x64" })).toEqual(["Orbis-0.0.2-mac-x64.dmg"]);
	expect(pick({ platform: "win32", arch: "x64", appImage: false })).toEqual([
		"Orbis-0.0.2-win-x64.exe",
	]);
	expect(pick({ platform: "linux", arch: "x64", appImage: true })).toEqual([
		"Orbis-0.0.2-linux-x86_64.AppImage",
	]);
	expect(pick({ platform: "linux", arch: "x64", appImage: false })).toEqual([
		"Orbis-0.0.2-linux-amd64.deb",
	]);
});

test("a nightly looks for the newest nightly, a stable build for the newest stable one", () => {
	const releases = [
		release("0.0.3-nightly.20261102.1", false), // its installers are still being built
		release("0.0.3-nightly.20261101.2"),
		release("0.0.2"),
		release("0.0.3-nightly.20261101.1"),
		{ ...release("0.0.4"), draft: true },
	];
	expect(pickUpdate(releases, "0.0.3-nightly.20261101.1", mac)).toEqual({
		version: "0.0.3-nightly.20261101.2",
		url: "https://dl/Orbis-0.0.3-nightly.20261101.2-mac-arm64.dmg",
	});
	expect(pickUpdate(releases, "0.0.3-nightly.20261101.2", mac)).toBeNull();
	expect(pickUpdate(releases, "0.0.1", mac)?.version).toBe("0.0.2");
	expect(pickUpdate(releases, "0.0.2", mac)).toBeNull();
	expect(pickUpdate(releases, "dev", mac)).toBeNull();
});
