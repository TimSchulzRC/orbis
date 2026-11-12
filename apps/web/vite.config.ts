import {
	copyFileSync,
	cpSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import type { ClientRequest } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin, ProxyOptions } from "vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { iconPath } from "../server/src/icons";

// pdf.js loads its JBIG2/JPEG 2000 decoders as WebAssembly from a folder at runtime.
const pdfjs = dirname(
	createRequire(createRequire(import.meta.url).resolve("@obtion/ui")).resolve(
		"pdfjs-dist/package.json",
	),
);
const pdfWasm = {
	name: "pdfjs-wasm",
	writeBundle() {
		mkdirSync("dist/pdfjs/wasm", { recursive: true });
		for (const f of ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"])
			copyFileSync(join(pdfjs, "wasm", f), `dist/pdfjs/wasm/${f}`);
	},
};

// Excalidraw loads its fonts from EXCALIDRAW_ASSET_PATH ("/excalidraw/"), so drawings work offline.
const excalidraw = join(
	dirname(
		createRequire(createRequire(import.meta.url).resolve("@obtion/ui")).resolve(
			"@excalidraw/excalidraw",
		),
	),
	"fonts",
);
const excalidrawFonts: Plugin = {
	name: "excalidraw-fonts",
	configureServer(server) {
		server.middlewares.use("/excalidraw/fonts/", (req, res, next) => {
			const file = join(
				excalidraw,
				decodeURIComponent((req.url ?? "").split("?")[0]!).replace(/\.\.+/g, ""),
			);
			if (!existsSync(file) || !statSync(file).isFile()) return next();
			res.setHeader("content-type", "font/woff2");
			createReadStream(file).pipe(res);
		});
	},
	writeBundle() {
		cpSync(excalidraw, "dist/excalidraw/fonts", { recursive: true });
	},
};

/**
 * For `vite build --watch`: a page loaded mid-rebuild must never get an index.html whose assets are
 * missing. index.html is renamed into place once all assets are written, and assets are only removed
 * two builds later.
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
		for (const f of readdirSync("dist/assets"))
			if (lastBuild && !now.has(`assets/${f}`) && !lastBuild.has(`assets/${f}`))
				rmSync(`dist/assets/${f}`);
		lastBuild = now;
	},
};

// The server answers /icon.svg & co. with its channel's colour (apps/server/src/icons.ts); the dev
// server is the dev channel.
const devIcons: Plugin = {
	name: "dev-icons",
	configureServer(server) {
		server.middlewares.use((req, _res, next) => {
			if (req.url) req.url = iconPath(req.url, "dev");
			next();
		});
	},
};

const server = `http://127.0.0.1:${process.env.PORT ?? 8480}`;
/** Set when the dev server is reached through `tailscale serve`. */
const devPublic = process.env.OBTION_DEV_PUBLIC_URL
	? new URL(process.env.OBTION_DEV_PUBLIC_URL)
	: undefined;

// Rewrite Host and Origin to the server's address: it rejects unknown hosts (DNS rebinding) and
// Origin != Host (CSRF), and the dev server may run on any port or tailnet name.
function toServer(ws = false): ProxyOptions {
	return {
		target: server,
		ws,
		changeOrigin: true,
		configure: (proxy) => {
			const own = (req: ClientRequest) =>
				req.getHeader("origin") !== undefined && req.setHeader("origin", server);
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
		excalidrawFonts,
		atomicWatch,
		devIcons,
		VitePWA({
			// the app asks before switching versions instead of silently serving the old cache
			registerType: "prompt",
			injectRegister: false,
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
				navigateFallbackDenylist: [/^\/api/, /^\/w\//],
				globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
				// the Chinese handwriting font is 200 parts (13 MB): kept once a drawing needed them
				// the icons of all channels stay out; the server's own are kept once loaded (also offline)
				globIgnores: ["excalidraw/fonts/Xiaolai/**", "icons/**"],
				runtimeCaching: [
					{
						urlPattern: /\/(icon(-dark)?\.svg|icon-\d+\.png|apple-touch-icon\.png)$/,
						handler: "StaleWhileRevalidate",
						options: { cacheName: "icons" },
					},
					{
						urlPattern: /\/excalidraw\/fonts\//,
						handler: "CacheFirst",
						options: { cacheName: "excalidraw-fonts", expiration: { maxEntries: 300 } },
					},
				],
				maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
			},
		}),
	],
	build: { outDir: "dist", chunkSizeWarningLimit: 2000 },
	server: {
		port: 5180,
		// 127.0.0.1, not only ::1: `tailscale serve` forwards to 127.0.0.1
		host: "127.0.0.1",
		allowedHosts: [".ts.net", ...(devPublic ? [devPublic.hostname] : [])],
		// behind `tailscale serve` (HTTPS): the browser reaches HMR over wss on the public port
		hmr: devPublic
			? { protocol: "wss", host: devPublic.hostname, clientPort: Number(devPublic.port || 443) }
			: undefined,
		proxy: {
			"/api": toServer(),
			"/w/": toServer(true),
		},
	},
});
