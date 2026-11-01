// The dark mark is the app's primary icon (PWA, home screen, Apple touch icon).
import { chromium } from "playwright";
import { readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const light = resolve(root, "docs/design/obtion-logo.svg");
const dark = resolve(root, "docs/design/obtion-logo-dark.svg");
const svg = readFileSync(dark, "utf8");
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]] as const) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0}svg{display:block;width:100%;height:100%}</style>${svg}`);
    await page.screenshot({ path: resolve(root, "apps/web/public", name), omitBackground: true });
    await page.close();
  }
  copyFileSync(light, resolve(root, "apps/web/public/icon.svg"));
  copyFileSync(dark, resolve(root, "apps/web/public/icon-dark.svg"));
} finally {
  await browser.close();
}
