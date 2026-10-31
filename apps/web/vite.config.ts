import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin, ProxyOptions } from "vite";
import type { ClientRequest } from "node:http";

/** pdf.js (used by @obtion/ui) decodes JBIG2 and JPEG 2000 images with WebAssembly it loads from a folder. */
const pdfjs = dirname(createRequire(createRequire(import.meta.url).resolve("@obtion/ui")).resolve("pdfjs-dist/package.json"));
const pdfWasm = {
  name: "pdfjs-wasm",
  writeBundle() {
    mkdirSync("dist/pdfjs/wasm", { recursive: true });
    for (const f of ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"]) copyFileSync(join(pdfjs, "wasm", f), `dist/pdfjs/wasm/${f}`);
  },
};

/**
 * `bun run dev:build` (vite build --watch, for a server in development): a page loaded during a rebuild never
 * gets an index.html whose assets are not written yet or already gone. The old hashed assets stay;
 * the new index.html is written under another name and takes over in one rename once everything
 * is on disk. Assets of the build before the previous one go then.
 */
let lastBuild: Set<string> | null = null;
const atomicWatch: Plugin = {
  name: "atomic-watch",
  enforce: "post",
  apply: (config) => !!config.build?.watch,
  config: () => ({ build: { emptyOutDir: false } }),
  generateBundle(_, bundle) {
    const html = bundle["index.html"];
    if (html?.type !== "asset") return;
    delete bundle["index.html"];
    this.emitFile({ type: "asset", fileName: "index.next.html", source: html.source });
  },
  writeBundle(_, bundle) {
    renameSync("dist/index.next.html", "dist/index.html");
    const now = new Set(Object.keys(bundle));
    for (const f of readdirSync("dist/assets")) if (lastBuild && !now.has(`assets/${f}`) && !lastBuild.has(`assets/${f}`)) rmSync(`dist/assets/${f}`);
    lastBuild = now;
  },
};

const server = `http://127.0.0.1:${process.env.PORT ?? 8480}`;
/** The dev server's own public address, if it is reached through `tailscale serve` (e.g. https://<host>.<tailnet>.ts.net:8472). */
const devPublic = process.env.OBTION_DEV_PUBLIC_URL ? new URL(process.env.OBTION_DEV_PUBLIC_URL) : undefined;

/**
 * Requests to the server go out as the server's own: Host and Origin are the server's address. The server
 * only answers to the hosts it serves under (DNS rebinding guard) and checks Origin against Host
 * (CSRF, cross-site WebSocket); the dev server may run on any port or tailnet name.
 */
function toServer(ws = false): ProxyOptions {
  return {
    target: server,
    ws,
    changeOrigin: true,
    configure: (proxy) => {
      const own = (req: ClientRequest) => req.getHeader("origin") !== undefined && req.setHeader("origin", server);
      proxy.on("proxyReq", own);
      proxy.on("proxyReqWs", own);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    pdfWasm,
    atomicWatch,
    VitePWA({
      // the app shows "Neue Version – neu laden" instead of silently serving the old cache
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["icon-dark.svg", "icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Obtion",
        short_name: "Obtion",
        description: "Knowledge and projects in one linked system",
        theme_color: "#191919",
        background_color: "#191919",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        // app routes live in the hash (#/w/<id>/…): every /w/ path is the server's (files, sync, MCP)
        navigateFallbackDenylist: [/^\/api/, /^\/mcp/, /^\/w\//],
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  build: { outDir: "dist", chunkSizeWarningLimit: 2000 },
  server: {
    port: 5180,
    // 127.0.0.1, not only ::1: `tailscale serve` forwards to 127.0.0.1
    host: "127.0.0.1",
    // the tailnet name (https://<host>.<tailnet>.ts.net:<port> via `tailscale serve`)
    allowedHosts: [".ts.net", ...(devPublic ? [devPublic.hostname] : [])],
    // behind `tailscale serve` (HTTPS): the browser reaches HMR over wss on the public port
    hmr: devPublic ? { protocol: "wss", host: devPublic.hostname, clientPort: Number(devPublic.port || 443) } : undefined,
    proxy: {
      "/api": toServer(),
      "/mcp": toServer(),
      // a workspace's sync, files and activity
      "/w/": toServer(true),
    },
  },
});
