// Stored data must stay readable by every later version. The fixture is format 4 as written then:
// never regenerate it, add one per new format instead. Formats 1 to 3 were dropped with the
// English stored names, before there was data to keep.
import { expect, test } from "bun:test";
import { Index } from "@obtion/core/graph";
import { FORMAT, type Item, PERSONAL, readItem, SETTINGS_ID } from "@obtion/core/model";
import { fromB64 } from "@obtion/core/protocol";
import * as Y from "yjs";
import fixture from "../support/format-4.json";

test("data of format 4 (6.11.2026) are read by this version", () => {
	expect(fixture.format).toBe(4);
	expect(FORMAT).toBeGreaterThanOrEqual(fixture.format);
	const records = new Map<string, Item>();
	for (const [id, u] of Object.entries(fixture.docs as Record<string, string>)) {
		const d = new Y.Doc();
		Y.applyUpdate(d, fromB64(u));
		const r = readItem(id, d);
		if (r) records.set(id, r);
	}
	const ix = new Index(records);
	expect(records.get(SETTINGS_ID)!.settings!.format).toBe(4);
	expect(ix.live.length).toBeGreaterThanOrEqual(40);
	expect(ix.get("ex-relaunch")!.title).toBe("Website relaunch");
	expect(ix.get("ex-relaunch")!.area).toBe(PERSONAL);
	expect(ix.parentsOf("ex-relaunch")).toEqual(["ex-work", "ex-nordlicht"]);
	expect(ix.types.get("ex-type-book")!.schema.plural).toBe("Books");
	expect(ix.get("ex-f-diagram")!.file!.filetype).toBe("image");
	expect(ix.get("ex-f-sheet")!.kind).toBe("file");
	expect(ix.get("ex-week")!.body).toContain("```query\n");
});
