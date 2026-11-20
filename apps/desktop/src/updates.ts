// Updates of the desktop app: the newest GitHub release of this build's channel with an installer
// for this system (release.yml attaches them). A nightly looks for nightlies, a stable build for
// stable releases, a dev build (unpackaged, or from the Desktop workflow) for none. Without
// electron, so the tests can load it.
import { channelOf } from "../../server/src/icons";

export const RELEASES = "https://api.github.com/repos/TimSchulzRC/orbis/releases?per_page=50";

/** What the GitHub API says about a release (only what is used here). */
export interface Release {
	tag_name: string;
	draft: boolean;
	assets: { name: string; browser_download_url: string }[];
}

/** A newer version and its installer for this system. */
export interface Update {
	version: string;
	url: string;
}

/** This system, the way release.yml names the installers (electron-builder: artifactName). */
export interface System {
	platform: string;
	arch: string;
	/** started as an AppImage (Linux): an AppImage again, otherwise the .deb */
	appImage: boolean;
}

const parts = (v: string) => {
	const dash = v.indexOf("-");
	const main = (dash < 0 ? v : v.slice(0, dash)).split(".").map(Number);
	return { main, pre: dash < 0 ? [] : v.slice(dash + 1).split(".") };
};

/**
 * Semver order: 0.0.2-nightly.20261030.2 < 0.0.2-nightly.20261031.1 < 0.0.2 < 0.0.3-nightly.….
 * Negative when `a` is older than `b`.
 */
export function compareVersions(a: string, b: string): number {
	const x = parts(a);
	const y = parts(b);
	for (let i = 0; i < 3; i++) {
		const d = (x.main[i] ?? 0) - (y.main[i] ?? 0);
		if (d) return d;
	}
	// a release is newer than its pre-releases
	if (!(x.pre.length && y.pre.length)) return y.pre.length - x.pre.length;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
		if (pn !== qn) return pn ? -1 : 1;
		if (!pn && p !== q) return p < q ? -1 : 1;
	}
	return 0;
}

const OS: Record<string, string> = { darwin: "mac", win32: "win", linux: "linux" };
// electron-builder names an architecture differently per format (AppImage x86_64, deb amd64)
const ARCH: Record<string, string[]> = {
	x64: ["x64", "x86_64", "amd64"],
	arm64: ["arm64", "aarch64"],
};

/** Whether `name` is the installer for `sys`: Orbis-<version>-<os>-<arch>.<ext>. */
export function isInstallerFor(name: string, sys: System): boolean {
	const os = OS[sys.platform];
	if (!os) return false;
	const ext =
		sys.platform === "darwin"
			? "dmg"
			: sys.platform === "win32"
				? "exe"
				: sys.appImage
					? "AppImage"
					: "deb";
	return (ARCH[sys.arch] ?? [sys.arch]).some((arch) => name.endsWith(`-${os}-${arch}.${ext}`));
}

/** The newest release of the channel of `current` that is newer and has an installer for `sys`. */
export function pickUpdate(releases: Release[], current: string, sys: System): Update | null {
	const channel = channelOf(current);
	if (channel === "dev") return null;
	let best: Update | null = null;
	for (const r of releases) {
		const version = r.tag_name.replace(/^v/, "");
		if (r.draft || channelOf(version) !== channel || compareVersions(version, current) <= 0)
			continue;
		const installer = r.assets.find((a) => isInstallerFor(a.name, sys));
		if (installer && (!best || compareVersions(version, best.version) > 0))
			best = { version, url: installer.browser_download_url };
	}
	return best;
}
