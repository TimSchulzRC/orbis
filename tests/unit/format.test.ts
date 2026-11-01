// Stored data must stay readable by every later version. The fixture is format 1 as written then:
// never regenerate it, add one per new format instead.
import { test, expect } from "bun:test";
import * as Y from "yjs";
import { FORMAT, PERSONAL, SETTINGS_ID, type Item, readItem } from "@obtion/core/model";
import { Index } from "@obtion/core/graph";
import { fromB64 } from "@obtion/core/protocol";
import fixture from "../support/format-1.json";

test("data of format 1 (27.10.2026) are read by this version", () => {
  expect(fixture.format).toBe(1);
  expect(FORMAT).toBeGreaterThanOrEqual(fixture.format);
  const records = new Map<string, Item>();
  for (const [id, u] of Object.entries(fixture.docs as Record<string, string>)) {
    const d = new Y.Doc();
    Y.applyUpdate(d, fromB64(u));
    const r = readItem(id, d);
    if (r) records.set(id, r);
  }
  const ix = new Index(records);
  expect(records.get(SETTINGS_ID)!.settings!.format).toBe(1);
  expect(ix.live.length).toBeGreaterThanOrEqual(40);
  expect(ix.get("ex-relaunch")!.title).toBe("Website-Relaunch");
  expect(ix.get("ex-relaunch")!.area).toBe(PERSONAL);
  expect(ix.parentsOf("ex-relaunch")).toEqual(["ex-work", "ex-nordlicht"]);
  expect(ix.types.get("ex-type-book")!.schema.plural).toBe("Bücher");
  expect(ix.get("ex-f-diagram")!.file!.filetype).toBe("bild");
});
