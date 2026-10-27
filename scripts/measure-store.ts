// Memory and start time of the server store, for a data dir that no server uses.
//   bun scripts/measure-store.ts seed <dir> [notes=5000]   → set up + notes with typing history
//   bun scripts/measure-store.ts measure <dir>             → start, a first sync, some edits
// Prints JSON. Never point it at a live data dir: "seed" writes, "measure" writes a few changes.
import { join, resolve } from "node:path";
import { heapStats } from "bun:jsc";
import { Store } from "@obtion/server/store";
import { Blobs } from "@obtion/server/blobs";
import { setUp } from "@obtion/server/importers";
import { PERSONAL } from "@obtion/core/model";
import { SYS } from "@obtion/core/setup";
import { searchIds } from "@obtion/core/search";

const [mode, dirArg, nArg] = process.argv.slice(2);
if (!dirArg || (mode !== "seed" && mode !== "measure")) {
  console.error("usage: measure-store.ts seed|measure <dir> [notes]");
  process.exit(1);
}
const DIR = resolve(dirArg);
const MB = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
function mem() {
  Bun.gc(true);
  return { heapMB: MB(heapStats().heapSize), rssMB: MB(process.memoryUsage().rss) };
}

const WORDS = "Haus Garten Projekt Idee Termin Notiz Aufgabe Kunde Rechnung Angebot Reise Buch Film Rezept Liste Plan Ziel Frage Antwort Treffen".split(" ");
const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => WORDS[(seed * 7 + i * 13) % WORDS.length]).join(" ");

if (mode === "seed") {
  const n = Number(nArg ?? 5000);
  const store = new Store(DIR);
  await setUp(store, new Blobs(join(DIR, "blobs"), store), "de", { quiet: true });
  const projects: string[] = [];
  for (let i = 0; i < 50; i++) projects.push(store.create({ title: `Projekt ${i}`, type: SYS.project }, "seed", { quiet: true }));
  for (let i = 0; i < n; i++) {
    const id = store.create({ title: `Notiz ${i} ${words(3, i)}`, parents: [projects[i % projects.length]!], tags: [WORDS[i % WORDS.length]!] }, "seed", { quiet: true });
    // typing: many small inserts and some deletes, as the editor sends them
    for (let k = 0; k < 30; k++)
      store.change(id, "seed", (d) => {
        const t = d.getText("body");
        t.insert(t.length, words(6, i + k) + (k % 5 === 4 ? "\n\n" : " "));
        if (k % 7 === 6) t.delete(Math.max(0, t.length - 10), 5);
      }, { quiet: true });
    if (i % 200 === 0) store.flush();
  }
  store.flush();
  console.log(JSON.stringify({ seeded: DIR, live: store.live().length, seq: store.seq }));
  process.exit(0);
}

const t0 = performance.now();
const store = new Store(DIR);
const startMs = Math.round(performance.now() - t0);
const afterStart = mem();
// a device syncing from scratch: every document of the area as a full state
const t1 = performance.now();
let bytes = 0;
for (const id of store.docsSince(PERSONAL, 0)) bytes += store.stateOf(id).length;
const syncMs = Math.round(performance.now() - t1);
const afterSync = mem();
// some use: search, read and edit a few documents
const hits = searchIds(store.searchIndex, "Garten Projekt", 50);
for (const id of hits.slice(0, 20)) store.change(id, "measure", (d) => d.getText("body").insert(0, "x"), { quiet: true });
store.flush();
const afterUse = mem();
console.log(
  JSON.stringify({
    dir: DIR,
    records: store.records.size,
    loadedDocs: store.loaded.size,
    startMs,
    afterStart,
    firstSync: { ms: syncMs, MB: MB(bytes) },
    afterSync,
    afterUse,
  }),
);
process.exit(0);
