// The app icons from the logos in docs/design: the tile without its rounded corners and border,
// because iOS cuts the corners itself. Light and dark like the system appearance, plus the splash
// mark. Needs Playwright's Chromium, as scripts/generate-icons.ts does:
//   bun scripts/generate-mobile-icons.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dir, "..");
const assets = resolve(root, "apps/mobile/assets");
const logo = (name: string) => readFileSync(resolve(root, "docs/design", name), "utf8");

/** Full-bleed tile: square corners, no border line. */
const square = (svg: string) =>
	svg
		.replace(/(<rect fill="url\(#tile\)"[^>]*?) rx="114"/, "$1")
		.replace(/<rect height="510" rx="113"[^>]*\/>/, "");
/** The mark alone on a transparent ground, for the splash screen. */
const mark = (svg: string) => square(svg).replace(/<rect fill="url\(#tile\)"[^>]*\/>/, "");

const browser = await chromium.launch({ headless: true });
try {
	for (const [file, svg, size] of [
		["icon.png", square(logo("orbis-logo.svg")), 1024],
		["icon-dark.png", square(logo("orbis-logo-dark.svg")), 1024],
		["splash.png", mark(logo("orbis-logo.svg")), 512],
		["splash-dark.png", mark(logo("orbis-logo-dark.svg")), 512],
	] as const) {
		const page = await browser.newPage({ viewport: { width: size, height: size } });
		await page.setContent(
			`<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`,
		);
		await page.screenshot({
			path: resolve(assets, file),
			omitBackground: file.startsWith("splash"),
		});
		await page.close();
	}
} finally {
	await browser.close();
}
