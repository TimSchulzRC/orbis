// Admin CLI. Run while the server is stopped (it keeps all documents in memory):
//   bun apps/server/src/cli.ts setup [de|en] [--examples]
//   bun apps/server/src/cli.ts import-obsidian <vault> [--no-moc-parents]
//   bun apps/server/src/cli.ts import-notion <json> [--project-type Projekt] [--task-type Task]
//   bun apps/server/src/cli.ts stats
import { join, resolve } from "node:path";
import { Store } from "./store";
import { Blobs } from "./blobs";
import { runSetup, SYS } from "@obtion/core/setup";
import { META_TYPE } from "@obtion/core/model";
import type { Lang } from "@obtion/core/i18n";
import { importNotion, importObsidian, setUp, storeWriter } from "./importers";

const DATA = resolve(process.env.OBTION_DATA ?? "data");
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const positional = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1]!.startsWith("--") && !["--no-moc-parents", "--force", "--examples"].includes(all[i - 1]!)));

const port = process.env.PORT ?? 8480;
const running = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(800) }).then(
  () => true,
  () => false,
);
if (running && cmd !== "stats" && !flag("force")) {
  console.error(`A server is running on :${port}. Stop it first, then run this again.`);
  process.exit(1);
}

const store = new Store(DATA);
const blobs = new Blobs(join(DATA, "blobs"), store);
const lang = (opt("lang", store.records.get("sys:settings")?.settings?.setupLang ?? "de") as Lang) ?? "de";
const log = (m: string) => console.log(m);

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
  await setUp(store, blobs, (positional[0] as Lang) ?? lang, { examples: flag("examples"), quiet: false });
  log(flag("examples") ? "Set up, with the examples." : "Set up.");
} else if (cmd === "import-obsidian") {
  runSetup(storeWriter(store, "system:setup"), lang, "system:setup");
  await importObsidian(store, blobs, resolve(positional[0] ?? `${process.env.HOME}/second_brain`), { lang, mocParents: !flag("no-moc-parents") }, log);
} else if (cmd === "import-notion") {
  runSetup(storeWriter(store, "system:setup"), lang, "system:setup");
  importNotion(store, resolve(positional[0] ?? "seed/notion.json"), { lang, projectType: opt("project-type", SYS.project)!, taskType: opt("task-type", SYS.task)! }, log);
} else {
  console.log("usage: cli.ts setup [de|en] [--examples] | import-obsidian <vault> | import-notion <json> [--project-type X] [--task-type Y] | stats");
  process.exit(1);
}
store.flush();
