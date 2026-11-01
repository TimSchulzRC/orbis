// Single-file programs of the CLI for every system (no Bun needed to run them):
//   bun apps/cli/build.ts [target …]   → dist/cli/obtion-<target>[.exe]
// Targets: Bun's names, e.g. bun-linux-x64, bun-darwin-arm64, bun-windows-x64. Without any: all below.
import { join } from "node:path";

const TARGETS = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64", "bun-windows-x64"];
const root = join(import.meta.dir, "../..");
const targets = process.argv.slice(2).length ? process.argv.slice(2) : TARGETS;
for (const t of targets) {
  const out = join(root, "dist/cli", `obtion-${t.replace(/^bun-/, "")}${t.includes("windows") ? ".exe" : ""}`);
  const p = Bun.spawnSync(["bun", "build", "--compile", "--minify", `--target=${t}`, join(import.meta.dir, "src/index.ts"), "--outfile", out], { stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
  console.log(`built ${out}`);
}
