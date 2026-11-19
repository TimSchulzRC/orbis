// Builds what the desktop app is made of: its pages (the web app, `vite build --mode desktop`, into
// dist/renderer), main and preload (dist/), and the server as one program per platform and
// architecture (build/server/<os>-<arch>/, the names electron-builder uses), and the icon.
//
//   bun scripts/build.ts                  for this machine
//   bun scripts/build.ts mac win linux    for these platforms (each x64 and arm64; win x64 only)

import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { iconPath } from "../../server/src/icons";

const here = join(import.meta.dir, "..");
const root = join(here, "../..");
const OS = { mac: "darwin", win: "windows", linux: "linux" } as const;
type Os = keyof typeof OS;
const own: Os =
	process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";
const wanted = process.argv.slice(2).filter((a): a is Os => a in OS);
const targets = wanted.length
	? wanted.flatMap((os) =>
			(os === "win" ? ["x64"] : ["x64", "arm64"]).map((arch) => ({ os, arch })),
		)
	: [{ os: own, arch: process.arch }];

rmSync(join(here, "dist"), { recursive: true, force: true });
await $`bun run --cwd ${join(root, "apps/web")} build --mode desktop`;
await $`bun build ${join(here, "src/main.ts")} --outfile ${join(here, "dist/main.cjs")} --target node --format cjs --external electron`;
await $`bun build ${join(here, "src/preload.ts")} --outfile ${join(here, "dist/preload.cjs")} --target node --format cjs --external electron`;
// the app icon is the web app's in the channel of this version (scripts/generate-icons.ts):
// electron-builder takes it from build/, the Linux window from dist/. The version is a release's
// (release.yml sets it, and electron-builder gets it as extraMetadata.version), otherwise dev
const version = process.env.OBTION_BUILD_VERSION || "dev";
mkdirSync(join(here, "build"), { recursive: true });
for (const to of ["build/icon.png", "dist/icon.png"])
	copyFileSync(join(root, "apps/web/public", iconPath("/icon-512.png", version)), join(here, to));

const servers = join(here, "build/server");
rmSync(servers, { recursive: true, force: true });
mkdirSync(servers, { recursive: true });
for (const { os, arch } of targets) {
	const out = join(servers, `${os}-${arch}`, os === "win" ? "obtion-server.exe" : "obtion-server");
	mkdirSync(join(out, ".."), { recursive: true });
	// in build/server (ignored by git): compiling for its own platform, Bun can leave a copy of itself
	// in the working directory (".<hex>-00000000.bun-build"), which then goes too
	await $`bun build --compile --target=bun-${OS[os]}-${arch} ${join(root, "apps/server/src/index.ts")} --outfile ${out}`.cwd(
		servers,
	);
}
for (const name of readdirSync(servers))
	if (name.endsWith(".bun-build")) rmSync(join(servers, name), { force: true });
