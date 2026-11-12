/** The release channel of a build version: dev, 0.0.2-nightly.20261030.41 or 0.0.2 (stable). */
export function channelOf(version: string): "dev" | "nightly" | "stable" {
	if (version === "dev") return "dev";
	return version.includes("-nightly") ? "nightly" : "stable";
}

const ICONS = new Set([
	"/icon.svg",
	"/icon-dark.svg",
	"/icon-192.png",
	"/icon-512.png",
	"/apple-touch-icon.png",
]);

/** Each channel has its icon colour (scripts/generate-icons.ts); the app asks for /icon.svg & co. */
export function iconPath(path: string, version: string): string {
	return ICONS.has(path) ? `/icons/${channelOf(version)}${path}` : path;
}
