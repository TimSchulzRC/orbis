// Rasterize the editable SVG with the same browser used by the UI smoke tests.
// Run: bun scripts/generate-icons.ts
import { chromium } from "playwright-core";
import { readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const master = resolve(root, "docs/design/obtion-logo.svg");
const svg = readFileSync(master, "utf8");
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]] as const) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0}svg{display:block;width:100%;height:100%}</style>${svg}`);
    await page.screenshot({ path: resolve(root, "apps/web/public", name), omitBackground: true });
    await page.close();
  }
  copyFileSync(master, resolve(root, "apps/web/public/icon.svg"));
  copyFileSync(resolve(root, "docs/design/obtion-logo-dark.svg"), resolve(root, "apps/web/public/icon-dark.svg"));
} finally {
  await browser.close();
}
