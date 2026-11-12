// The device's IndexedDB storage keeps the record that compaction stores with a row, so the next
// start can skip decoding that document.

import { RECORD_VERSION } from "@obtion/core/model";
import { Repo } from "@obtion/sync";
import { expect, test } from "vitest";
import * as Y from "yjs";
import { browserHost } from "../../packages/ui/src/browser";

// a new database each run: the browser profile is thrown away afterwards (destroy() would reload the page)
const link = (replica: string) => ({
	base: location.origin,
	token: "t",
	person: { id: "u1", name: "Tim" },
	storage: { replica, files: `${replica}-files`, blobs: `blobs-${replica}` },
});

test("a compacted row keeps its record in IndexedDB", async () => {
	const host = browserHost(link(`obtion-test-${Date.now()}`));
	const storage = host.storage;
	await storage.open();
	const doc = new Y.Doc();
	doc.getMap("meta").set("kind", "note");
	doc.getText("body").insert(0, "Text");
	await storage.write({ rows: [{ d: "a", u: Y.encodeStateAsUpdate(doc) }] });

	const repo = new Repo({
		...host,
		connect: () => ({
			readyState: 0,
			send() {},
			close() {},
			onopen: null,
			onmessage: null,
			onclose: null,
			onerror: null,
		}),
	});
	await repo.init();
	await new Promise((r) => setTimeout(r, 50)); // compaction
	const { rows } = await storage.load();
	expect(rows).toHaveLength(1);
	expect(rows[0]!.r?.v).toBe(RECORD_VERSION);
	expect(rows[0]!.r?.item?.body).toBe("Text");

	const again = new Repo({
		...host,
		connect: () => ({
			readyState: 0,
			send() {},
			close() {},
			onopen: null,
			onmessage: null,
			onclose: null,
			onerror: null,
		}),
	});
	await again.init();
	expect(again.docs.size).toBe(0);
	expect(again.get("a")?.body).toBe("Text");
});
