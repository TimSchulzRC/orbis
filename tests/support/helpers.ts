import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index } from "@obtion/core/graph";
import {
	type Item,
	type ItemInit,
	initItem,
	initSchema,
	META_TYPE,
	newId,
	readItem,
} from "@obtion/core/model";
import type { Writer } from "@obtion/core/setup";
import { resolveCascade } from "@obtion/core/trash";
import * as Y from "yjs";

const temps: string[] = [];
/** A fresh data directory for a server store; removed again by `removeTempDirs` (call it in afterAll). */
export function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}
export function removeTempDirs() {
	for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** An in-memory set of documents with the Writer interface – enough for shared logic tests. */
export class MemRepo {
	docs = new Map<string, Y.Doc>();
	writer: Writer = {
		change: (id, fn) => this.change(id, fn),
		get: (id) => this.get(id),
	};
	doc(id: string) {
		let d = this.docs.get(id);
		if (!d) {
			d = new Y.Doc({ guid: id });
			this.docs.set(id, d);
		}
		return d;
	}
	change(id: string, fn: (doc: Y.Doc) => void) {
		const d = this.doc(id);
		d.transact(() => fn(d));
	}
	get(id: string): Item | undefined {
		const d = this.docs.get(id);
		return d ? (readItem(id, d) ?? undefined) : undefined;
	}
	add(init: ItemInit & { id?: string }): string {
		const id = init.id ?? newId();
		this.change(id, (d) => initItem(d, init));
		return id;
	}
	/** A type page: the item and its schema, titled after the schema's name. */
	addType(id: string, schema: Parameters<typeof initSchema>[1]): string {
		this.change(id, (d) => {
			initItem(d, { type: META_TYPE, title: schema.name });
			initSchema(d, schema);
		});
		return id;
	}
	records(): Map<string, Item> {
		const m = new Map<string, Item>();
		for (const id of this.docs.keys()) {
			const r = this.get(id);
			if (r) m.set(id, r);
		}
		resolveCascade(m);
		return m;
	}
	index() {
		return new Index(this.records());
	}
}

/** A second device: a full copy of the documents, merged back with sync(). */
export function fork(m: MemRepo): MemRepo {
	const c = new MemRepo();
	for (const [id, d] of m.docs) Y.applyUpdate(c.doc(id), Y.encodeStateAsUpdate(d));
	return c;
}
export function sync(a: MemRepo, b: MemRepo) {
	for (const [id, d] of a.docs) Y.applyUpdate(b.doc(id), Y.encodeStateAsUpdate(d));
	for (const [id, d] of b.docs) Y.applyUpdate(a.doc(id), Y.encodeStateAsUpdate(d));
}

/** A new item's whole state as one update, as a device sends it; with an id the document has it as guid. */
export function docUpdate({
	id,
	title,
	area,
}: {
	id?: string;
	title: string;
	area?: string;
}): Uint8Array {
	const d = new Y.Doc(id ? { guid: id } : undefined);
	d.transact(() => initItem(d, { title, area }));
	return Y.encodeStateAsUpdate(d);
}
