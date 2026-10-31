// Component tests in a real Chromium (Vitest browser mode): a part of the interface rendered on its
// own, against a workspace in memory, no server. tests/browser/*.browser.tsx – the name keeps them
// out of `bun test`.
//   bun run test:browser   (Chromium from ~/.cache/ms-playwright: bunx playwright install chromium)
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { keys, mouse } from "./tests/browser/commands.ts";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // found up front, not while the first test loads: Vite would reload it (a fresh checkout in CI)
  optimizeDeps: { entries: ["tests/browser/**/*.browser.tsx", "packages/ui/src/**/*.{ts,tsx}"] },
  test: {
    include: ["tests/browser/**/*.browser.tsx"],
    setupFiles: ["tests/browser/setup.ts"],
    // in CI a failed test gets one more try: the self-hosted machine runs other things beside it
    // (a load spike is no bug); Vitest still reports the test as flaky
    retry: process.env.CI ? 1 : 0,
    // how long the first test file may take to load: with an empty Vite cache (every CI run) and
    // other jobs on the machine, loading the interface took up to a minute, Vitest's default limit
    env: { VITEST_BROWSER_IFRAME_TIMEOUT: process.env.VITEST_BROWSER_IFRAME_TIMEOUT ?? (process.env.CI ? "180000" : "60000") },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ contextOptions: { locale: "de-DE" } }),
      commands: { mouse, keys },
      instances: [{ browser: "chromium", viewport: { width: 1280, height: 900 } }],
    },
  },
});
