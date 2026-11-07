import { test, expect, afterAll } from "bun:test";
import * as Y from "yjs";
import { docUpdate, tempDir, removeTempDirs } from "../support/helpers";
import { PERSONAL, initItem, readItem } from "@obtion/core/model";
import { AreaError, Store } from "@obtion/server/store";

afterAll(removeTempDirs);

test("new documents belong to the personal area; documents from before are read as personal", () => {
  const d = new Y.Doc();
  d.transact(() => initItem(d, { title: "New" }));
  expect(d.getMap("meta").get("area")).toBe(PERSONAL);
  const old = new Y.Doc();
  old.transact(() => (initItem(old, { title: "Old" }), old.getMap("meta").delete("area")));
  expect(readItem("x", old)!.area).toBe(PERSONAL);
});

test("server log: every row has its area; cursors and catch-up per area; areas never mix", () => {
  const s = new Store(tempDir("obtion-area-"));
  s.applyRemote("p1", docUpdate({ id: "p1", title: "p1" }), "web:x");
  s.applyRemote("t1", docUpdate({ id: "t1", title: "t1", area: "team-a" }), "web:x", undefined, undefined, "team-a");
  const rows = s.db.query("SELECT doc, area FROM updates ORDER BY seq").all() as { doc: string; area: string }[];
  expect(rows).toEqual([
    { doc: "p1", area: PERSONAL },
    { doc: "t1", area: "team-a" },
  ]);
  expect(s.docsSince(PERSONAL, 0)).toEqual(["p1"]);
  expect(s.docsSince("team-a", 0)).toEqual(["t1"]);
  expect(s.last(PERSONAL).seq).toBe(1);
  // the personal cursor at seq 1 is valid; the team's row is no personal cursor
  expect(s.knowsCursor(PERSONAL, 1, s.last(PERSONAL).uid)).toBe(true);
  expect(s.knowsCursor(PERSONAL, 2, s.last("team-a").uid)).toBe(false);
  // a change for a personal document sent as the team's is refused
  expect(() => s.applyRemote("p1", docUpdate({ id: "p1", title: "p1" }), "web:x", undefined, undefined, "team-a")).toThrow(AreaError);
});
