// Admin CLI. Run while the server is stopped (it keeps all documents in memory). Works on one
// workspace: --workspace <id>, or the only one there is (or the data from before accounts):
//   bun apps/server/src/cli.ts setup [de|en] [--examples]
//   bun apps/server/src/cli.ts import-obsidian <vault> [--no-moc-parents]
//   bun apps/server/src/cli.ts import-notion <json> [--project-type Projekt] [--task-type Task]
//   bun apps/server/src/cli.ts gc [--force]
//   bun apps/server/src/cli.ts stats
// One works on the accounts, also while the server runs:
//   bun apps/server/src/cli.ts set-password <email>   (the new password on stdin)
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "./store";
import { setPassword, workspaceDirs } from "./accounts";
import { Blobs } from "./blobs";
import { SYS } from "@obtion/core/setup";
import { META_TYPE } from "@obtion/core/model";
import { type Lang, LANGS } from "@obtion/core/i18n";
import { importNotion, importObsidian, setUp } from "./importers";
import { DATA, PORT } from "./config";

const USAGE = `usage: cli.ts <command> [--workspace <id>] [--lang de|en]
  setup [de|en] [--examples]
  import-obsidian <vault> [--no-moc-parents]
  import-notion <json> [--project-type X] [--task-type Y]
  gc [--force]      files no item points to: lists them, --force removes them
  stats
  set-password <email>   a new password for an account (read from stdin); also while the server runs
--force on other commands: run although a server answers on :${PORT}`;

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      workspace: { type: "string" },
      lang: { type: "string" },
      examples: { type: "boolean" },
      force: { type: "boolean" },
      "no-moc-parents": { type: "boolean" },
      "project-type": { type: "string" },
      "task-type": { type: "string" },
    },
  });
} catch (e) {
  console.error((e as Error).message);
  usage();
}
const { values: opts, positionals } = parsed;
const [cmd, arg] = positionals;
const isLang = (l: string | undefined): l is Lang => LANGS.includes(l as Lang);
if (opts.lang !== undefined && !isLang(opts.lang)) usage();
if (!["setup", "import-obsidian", "import-notion", "gc", "stats", "set-password"].includes(cmd ?? "")) usage();
if (cmd === "set-password") {
  if (!arg) usage();
  const password = (process.stdin.isTTY ? prompt("New password:") : (await Bun.stdin.text()).split("\n")[0])?.trim() ?? "";
  try {
    await setPassword(DATA, arg, password);
    console.log(`Set a new password for ${arg}.`);
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
if ((cmd === "import-obsidian" || cmd === "import-notion") && !arg) usage();
if (cmd === "setup" && arg !== undefined && !isLang(arg)) usage();

const running = await fetch(`http://127.0.0.1:${PORT}/api/info`, { signal: AbortSignal.timeout(800) }).then(
  () => true,
  () => false,
);
// gc never runs beside a server: a device may be uploading a file whose item has not arrived yet
if (running && cmd !== "stats" && (cmd === "gc" || !opts.force)) {
  console.error(`A server is running on :${PORT}. Stop it first, then run this again.`);
  process.exit(1);
}

/** The folder of the workspace to work on (see the top). */
function workspaceDir(): string {
  const id = opts.workspace;
  const dirs = workspaceDirs(DATA);
  if (id) {
    const dir = dirs.find((d) => basename(d) === id);
    if (!dir) (console.error(`No workspace ${id} in ${DATA}.`), process.exit(1));
    return dir;
  }
  if (existsSync(join(DATA, "obtion.db")) || dirs.length === 0) return DATA; // before accounts: the folder itself
  if (dirs.length === 1) return dirs[0]!;
  console.error(`Several workspaces – name one with --workspace:\n  ${dirs.map((d) => basename(d)).join("\n  ")}`);
  process.exit(1);
}

const DIR = workspaceDir();
const store = new Store(DIR);
const blobs = new Blobs(join(DIR, "blobs"), store);
const lang = (opts.lang as Lang | undefined) ?? store.lang();

if (cmd === "stats") {
  const by = new Map<string, number>();
  for (const r of store.records.values()) {
    if (r.deleted) continue;
    const k = r.kind !== "info" ? r.kind : r.type === META_TYPE ? "typ" : (store.index().typeName(r.type) ?? (r.type ? "?" : "ohne Typ"));
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  // files whose content (or preview) the server does not have: shown as "Datei fehlt" in the app
  const missing = store.live().filter((r) => r.file && [r.file.hash, r.file.display, r.file.thumb].some((h) => h && !blobs.has(h)));
  console.log(Object.fromEntries(by), { seq: store.seq, server: store.serverId, filesMissingContent: missing.length });
  for (const r of missing.slice(0, 20)) console.log("  missing:", r.title, r.id);
} else if (cmd === "setup") {
  await setUp(store, blobs, (arg as Lang | undefined) ?? lang, { examples: opts.examples, quiet: false });
  console.log(opts.examples ? "Set up, with the examples." : "Set up.");
} else if (cmd === "import-obsidian") {
  await setUp(store, blobs, lang);
  await importObsidian(store, blobs, resolve(arg!), { lang, mocParents: !opts["no-moc-parents"] }, console.log);
} else if (cmd === "import-notion") {
  await setUp(store, blobs, lang);
  importNotion(store, resolve(arg!), { lang, projectType: opts["project-type"] ?? SYS.project, taskType: opts["task-type"] ?? SYS.task }, console.log);
} else if (cmd === "gc") {
  const sizes = new Map<string, number>();
  for (const hash of blobs.collect(true)) sizes.set(hash, blobs.size(hash));
  const total = [...sizes.values()].reduce((a, b) => a + b, 0);
  for (const [hash, size] of sizes) console.log(`  ${hash}  ${size} bytes`);
  const summary = `${sizes.size} file(s) no item points to, ${(total / 1024 / 1024).toFixed(1)} MB`;
  if (!opts.force) console.log(`${summary}. Nothing removed; run with --force to remove them.`);
  else console.log(`${summary}: removed ${blobs.collect().length}.`);
}
store.flush();
