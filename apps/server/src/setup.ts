// The first setup of a workspace on the server, and the writer the server's own changes go through.
import type { Lang } from "@obtion/core/i18n";
import { runSetup, type Writer } from "@obtion/core/setup";
import { EXAMPLE_ORIGIN, addExamples, fileFacts } from "@obtion/core/examples";
import type { Store } from "./store";
import { type Blobs, sha256 } from "./blobs";

export const SETUP_ORIGIN = "system:setup";

export function storeWriter(store: Store, origin: string, quiet = true): Writer {
  return {
    change: (id, fn) => store.change(id, origin, fn, { quiet }),
    get: (id) => store.records.get(id),
  };
}

/** Same code the setup page runs. */
export async function setUp(store: Store, blobs: Blobs, lang: Lang, opts: { examples?: boolean; quiet?: boolean } = {}) {
  runSetup(storeWriter(store, SETUP_ORIGIN, opts.quiet), lang, SETUP_ORIGIN);
  if (opts.examples)
    await addExamples(storeWriter(store, EXAMPLE_ORIGIN, opts.quiet), lang, async (f) => {
      const hash = sha256(f.bytes);
      await blobs.put(hash, f.bytes);
      return fileFacts(f, hash);
    });
  store.flush();
}
