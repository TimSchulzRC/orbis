// The examples of the setup page ("Mit Beispielen starten", packages/core/src/examples.ts), for a test server.
// Writes only to a separate data dir (default data-demo/, never data/). Run while no server uses that dir:
//   bun run seed:demo [de|en]             → data-demo/
//   OBTION_DATA=/tmp/obtion-demo bun run seed:demo
// Then: OBTION_DATA=data-demo PORT=8481 bun apps/server/src/index.ts
// Fixed ids (ex-*): running it again only adds what is missing.
import { join, resolve } from "node:path";
import { Store } from "@obtion/server/store";
import { Blobs } from "@obtion/server/blobs";
import { setUp } from "@obtion/server/importers";
import { EXAMPLE } from "@obtion/core/examples";
import type { Lang } from "@obtion/core/i18n";

const DATA = resolve(process.env.OBTION_DATA ?? "data-demo");
if (DATA === resolve("data")) {
  console.error("seed:demo never writes to data/. Set OBTION_DATA to a separate directory.");
  process.exit(1);
}
const port = process.env.PORT ?? 8481;
const running = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(800) }).then(
  () => true,
  () => false,
);
if (running) {
  console.error(`A server is running on :${port}. Stop it first, then run this again.`);
  process.exit(1);
}

const store = new Store(DATA);
await setUp(store, new Blobs(join(DATA, "blobs"), store), (process.argv[2] as Lang) ?? "de", { examples: true });
const n = store.live().filter((i) => i.source === EXAMPLE).length;
console.log(`${DATA}: ${n} examples, ${store.live().length} in total, seq ${store.seq}`);
