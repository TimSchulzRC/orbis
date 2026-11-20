// The first setup of a workspace on the server, and the writer the server's own changes go through.

import { addExamples, EXAMPLE_ORIGIN, fileFacts } from "@orbis/core/examples";
import type { Lang } from "@orbis/core/i18n";
import { runSetup, type Writer } from "@orbis/core/setup";
import { type Blobs, sha256 } from "./blobs";
import type { Store } from "./store";

export const SETUP_ORIGIN = "system:setup";

export function storeWriter(store: Store, origin: string, quiet = true): Writer {
	return {
		change: (id, fn) => store.change(id, origin, fn, { quiet }),
		get: (id) => store.records.get(id),
	};
}

/** Same code the setup page runs. */
export async function setUp(
	store: Store,
	blobs: Blobs,
	lang: Lang,
	opts: { examples?: boolean; quiet?: boolean } = {},
) {
	runSetup(storeWriter(store, SETUP_ORIGIN, opts.quiet), lang, SETUP_ORIGIN);
	if (opts.examples)
		await addExamples(storeWriter(store, EXAMPLE_ORIGIN, opts.quiet), lang, async (f) => {
			const hash = sha256(f.bytes);
			await blobs.put(hash, f.bytes);
			return fileFacts(f, hash);
		});
	store.flush();
}
