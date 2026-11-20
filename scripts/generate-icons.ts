// One icon set per release channel from the logos in docs/design, the same mark on its own tile:
// the ring black or white as drawn, the square and the tile behind in the channel's colour: stable
// yellow, nightly violet under a night sky, dev blue on a blueprint. The server
// answers /icon.svg & co. from apps/web/public/icons/<its channel>/ (apps/server/src/icons.ts).
// The dark mark is the app's primary icon (PWA, home screen, Apple touch icon).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dir, "..");
const light = readFileSync(resolve(root, "docs/design/orbis-logo.svg"), "utf8");
const dark = readFileSync(resolve(root, "docs/design/orbis-logo-dark.svg"), "utf8");

type Colours = {
	tile: [string, string];
	object: [string, string];
	shadow: string;
	decor: string;
};
type Palette = { light: Colours; dark: Colours };

/** Drafting lines around the mark: a grid, its two circles, centre lines and a dimension line. */
const blueprint = (line: string, grid: number, draft: number) => {
	const minor = Array.from({ length: 15 }, (_, i) => (i + 1) * 32).filter((v) => v % 128 !== 0);
	const lines = (at: number[]) => at.map((v) => `M${v} 0V512M0 ${v}H512`).join("");
	return `<g stroke="${line}" fill="none">
    <path d="${lines(minor)}" stroke-width="1.5" stroke-opacity="${grid}"/>
    <path d="${lines([128, 256, 384])}" stroke-width="2" stroke-opacity="${grid * 2}"/>
    <g stroke-width="3" stroke-opacity="${draft}">
      <circle cx="256" cy="256" r="153" stroke-dasharray="10 9"/>
      <circle cx="256" cy="256" r="89" stroke-dasharray="10 9"/>
      <path d="M68 256H444M256 68V444" stroke-dasharray="22 8 4 8"/>
      <path d="M103 462H409M103 450V474M409 450V474M50 103V409M38 103H62M38 409H62"/>
      <path d="M426 52V76M414 64H438M64 430 80 446M80 430 64 446"/>
    </g>
  </g>`;
};

/** A night sky: stars above, clouds below. */
const night = (star: string, stars: number, back: string, front: string) => `
    <g fill="${star}" fill-opacity="${stars}">
      <circle cx="74" cy="92" r="5"/><circle cx="212" cy="54" r="4"/><circle cx="452" cy="250" r="4"/><circle cx="52" cy="268" r="4"/><circle cx="296" cy="88" r="3"/><circle cx="462" cy="96" r="3"/>
      <path d="M134 44l5 15 15 5-15 5-5 15-5-15-15-5 15-5zM440 152l4 11 11 4-11 4-4 11-4-11-11-4 11-4z"/>
    </g>
    <path d="M250 512V402a62 62 0 0 1 110-36 78 78 0 0 1 134 22 60 60 0 0 1 18 6V512z" fill="${back}"/>
    <path d="M0 512V392a66 66 0 0 1 92-28 88 88 0 0 1 152 34 62 62 0 0 1 96 44 50 50 0 0 1 60 70z" fill="${front}"/>`;

// stable is the logo as drawn; the others colour its square and draw on the tile behind the mark
const palettes: Record<string, Palette | null> = {
	stable: null,
	nightly: {
		light: {
			tile: ["#F6F2FF", "#DDD2F7"],
			object: ["#A983FF", "#7A45E8"],
			shadow: "#3F1A8F",
			decor: night("#8452F0", 0.55, "#CDBDF3", "#BBA6EE"),
		},
		dark: {
			tile: ["#241E55", "#0D0B26"],
			object: ["#C3A6FF", "#9466F5"],
			shadow: "#000000",
			decor: night("#FFFFFF", 0.9, "#3A2D85", "#4C3BA6"),
		},
	},
	dev: {
		light: {
			tile: ["#F7FAFF", "#DCE7F8"],
			object: ["#5B9AFF", "#2466DD"],
			shadow: "#1A4B9B",
			decor: blueprint("#2773ED", 0.13, 0.45),
		},
		dark: {
			tile: ["#3F86F2", "#1749B5"],
			object: ["#BFE0FF", "#7DB8FF"],
			shadow: "#0B2A6B",
			decor: blueprint("#FFFFFF", 0.14, 0.55),
		},
	},
};

function stops(svg: string, id: string, colours: string[]): string {
	const re = new RegExp(`(<linearGradient[^>]*\\bid="${id}"[\\s\\S]*?</linearGradient>)`);
	const gradient = svg.match(re)?.[1];
	if (!gradient) throw new Error(`no gradient ${id}`);
	let i = 0;
	const next = gradient.replace(
		/stop-color="#[0-9A-Fa-f]{6}"/g,
		() => `stop-color="${colours[i++]}"`,
	);
	if (i !== colours.length) throw new Error(`gradient ${id} has ${i} stops, not ${colours.length}`);
	return svg.replace(gradient, next);
}

function replaceOnce(svg: string, find: string | RegExp, by: string): string {
	const out = svg.replace(find, by);
	if (out === svg) throw new Error(`nothing to replace: ${find}`);
	return out;
}

function recolour(svg: string, c: Colours | undefined): string {
	if (!c) return svg;
	let out = stops(stops(svg, "tile", c.tile), "object", c.object);
	out = out.replace(/flood-color="#[0-9A-Fa-f]{6}"/, `flood-color="${c.shadow}"`);
	out = replaceOnce(
		out,
		"</defs>",
		`  <clipPath id="clip"><rect width="512" height="512" rx="114"/></clipPath>\n  </defs>`,
	);
	// above the tile, below its border and the mark
	return replaceOnce(
		out,
		/(<rect[^>]*fill="url\(#tile\)"[^>]*\/>)/,
		`$1\n  <g clip-path="url(#clip)">${c.decor}\n  </g>`,
	);
}

const browser = await chromium.launch({ headless: true });
try {
	for (const [channel, palette] of Object.entries(palettes)) {
		const dir = resolve(root, "apps/web/public/icons", channel);
		mkdirSync(dir, { recursive: true });
		const lightSvg = recolour(light, palette?.light);
		const darkSvg = recolour(dark, palette?.dark);
		writeFileSync(resolve(dir, "icon.svg"), lightSvg);
		writeFileSync(resolve(dir, "icon-dark.svg"), darkSvg);
		for (const [name, size] of [
			["icon-192.png", 192],
			["icon-512.png", 512],
			["apple-touch-icon.png", 180],
		] as const) {
			const page = await browser.newPage({
				viewport: { width: size, height: size },
				deviceScaleFactor: 1,
			});
			await page.setContent(
				`<style>html,body{margin:0}svg{display:block;width:100%;height:100%}</style>${darkSvg}`,
			);
			await page.screenshot({ path: resolve(dir, name), omitBackground: true });
			await page.close();
		}
	}
} finally {
	await browser.close();
}
// the SVGs as Biome formats them, so `bun run check` passes
const format = Bun.spawnSync(["bunx", "biome", "check", "--write", "apps/web/public/icons"], {
	cwd: root,
});
if (format.exitCode !== 0) throw new Error(format.stderr.toString());
