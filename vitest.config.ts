// Component tests in real Chromium against an in-memory workspace. The .browser.tsx suffix keeps them
// out of `bun test`. Needs `bunx playwright install chromium`.

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { keys, mouse } from "./tests/browser/commands.ts";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// Pre-bundle up front, otherwise Vite reloads mid-run on a fresh checkout (CI).
	optimizeDeps: { entries: ["tests/browser/**/*.browser.tsx", "packages/ui/src/**/*.{ts,tsx}"] },
	test: {
		include: ["tests/browser/**/*.browser.tsx"],
		setupFiles: ["tests/browser/setup.ts"],
		// The checks run side by side on the CI runner, so a load spike can fail a test. Vitest still reports it as flaky.
		retry: process.env.CI ? 1 : 0,
		// With an empty Vite cache (every CI run) loading the first test file took up to a minute, Vitest's default.
		env: {
			VITEST_BROWSER_IFRAME_TIMEOUT:
				process.env.VITEST_BROWSER_IFRAME_TIMEOUT ?? (process.env.CI ? "180000" : "60000"),
		},
		browser: {
			enabled: true,
			headless: true,
			provider: playwright({ contextOptions: { locale: "de-DE" } }),
			commands: { mouse, keys },
			instances: [{ browser: "chromium", viewport: { width: 1280, height: 900 } }],
		},
	},
});
