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
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ contextOptions: { locale: "de-DE" } }),
      commands: { mouse, keys },
      instances: [{ browser: "chromium", viewport: { width: 1280, height: 900 } }],
    },
  },
});
