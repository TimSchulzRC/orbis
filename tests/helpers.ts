import * as Y from "yjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Item, type ItemInit, initItem, readItem, newId } from "../src/shared/model";
import { Index } from "../src/shared/graph";
import { resolveCascade } from "../src/shared/trash";
import type { Writer } from "../src/shared/setup";

const temps: string[] = [];
/** A fresh data directory for a hub store; removed again by `removeTempDirs` (call it in afterAll). */
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
    if (!d) this.docs.set(id, (d = new Y.Doc({ guid: id })));
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
