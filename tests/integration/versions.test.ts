// Protection against lost updates: an agent that replaces a body it read earlier must not wipe
// out what someone else wrote in between (base_version on update).
import { test, expect, beforeEach, afterAll } from "bun:test";
import { removeTempDirs } from "../support/helpers";
import { setupStore, tool as storeTool } from "../support/store";
import type { Store } from "@obtion/server/store";
import { type Ops, versionOf } from "@obtion/server/ops";
import * as Y from "yjs";
import { replaceBody, touch } from "@obtion/core/model";
import { personOrigin } from "@obtion/core/origin";

afterAll(removeTempDirs);

let s: Store;
let ops: Ops;
beforeEach(() => ({ s, ops } = setupStore("obtion-versions-")));

const tool = (name: string, args: unknown) => storeTool(s, name, args);
const body = (title: string) => s.records.get(s.index().resolveTitle(title)!)!.body;
const versionIn = (text: string) => /version ([0-9a-f]{12})/.exec(text)![1]!;
const getVersion = async (ref: string) => JSON.parse((await tool("get", { ref })).text).version as string;

async function note() {
  await tool("create", { items: [{ title: "Lieferantenliste", body: "Erste Zeile.\n\nZweite Zeile." }] });
}

test("lost update: a stale full replace no longer wipes out what another agent appended", async () => {
  await note();
  const read = await getVersion("Lieferantenliste"); // agent B reads
  // agent A appends in between
  expect((await tool("update", { ref: "Lieferantenliste", body: "WICHTIG von A", body_mode: "append" })).error).toBe(false);
  // agent B writes its stale copy back
  const r = await tool("update", { ref: "Lieferantenliste", body: "Erste Zeile.\n\nZweite Zeile, von B überarbeitet.", base_version: read });
  expect(r.error).toBe(true);
  expect(r.text).toMatch(/^Nothing changed\. "Lieferantenliste" \[\w+\] changed since you read it/);
  expect(r.text).toMatch(/Only in the current body \(your replace would drop it\):\n(  .*\n)*  WICHTIG von A\n/);
  expect(r.text).toMatch(/Only in your body:\n {2}Zweite Zeile, von B überarbeitet\./);
  expect(r.text).toMatch(/Last changes:\n- \S+ by mcp for Kai: text: /);
  expect(body("Lieferantenliste")).toContain("WICHTIG von A");
  expect(body("Lieferantenliste")).not.toContain("von B");
  // B reads again, merges, and passes the new version
  const now = await getVersion("Lieferantenliste");
  const ok = await tool("update", { ref: "Lieferantenliste", body: "Erste Zeile.\n\nZweite Zeile, von B überarbeitet.\n\nWICHTIG von A", base_version: now });
  expect(ok.error).toBe(false);
  expect(body("Lieferantenliste")).toBe("Erste Zeile.\n\nZweite Zeile, von B überarbeitet.\n\nWICHTIG von A");
  expect(versionIn(ok.text)).toBe(await getVersion("Lieferantenliste"));
});

test("an edit in the app makes the agent's copy stale and the answer names who changed it", async () => {
  await note();
  const id = s.index().resolveTitle("Lieferantenliste")!;
  const read = await getVersion(id);
  // the browser edits its replica and sends the Yjs update, as the sync does
  const replica = new Y.Doc({ guid: id });
  Y.applyUpdate(replica, s.stateOf(id));
  const sv = Y.encodeStateVector(replica);
  replica.transact(() => (replaceBody(replica, "Erste Zeile.\n\nZweite Zeile.\n\nNachtrag aus dem Browser"), touch(replica)));
  s.applyRemote(id, Y.encodeStateAsUpdate(replica, sv), personOrigin({ id: "u-tim", name: "tim" }, "laptop"));
  const r = await tool("update", { ref: id, body: "Ganz neu.", base_version: read });
  expect(r.error).toBe(true);
  expect(r.text).toMatch(/Last changes:\n- \d{4}-\d\d-\d\dT\d\d:\d\d by tim: text: /);
  expect(r.text).toContain("Nachtrag aus dem Browser");
  expect(r.text).toMatch(/Get it again, merge/);
  expect(body("Lieferantenliste")).toContain("Nachtrag aus dem Browser");
});

test("replacing the whole body without base_version is refused, explicit replace too", async () => {
  await note();
  for (const args of [{ body: "Weg damit" }, { body: "Weg damit", body_mode: "replace" }, { body: "" }]) {
    const r = await tool("update", { ref: "Lieferantenliste", ...args });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/^Nothing changed\. Replacing the whole body of "Lieferantenliste" needs base_version.*get shows its version.*old_text\/new_text.*append/);
  }
  // nothing else in the call is applied either
  const r = await tool("update", { ref: "Lieferantenliste", title: "Neu", body: "Weg damit" });
  expect(r.error).toBe(true);
  expect(s.index().resolveTitle("Lieferantenliste")).toBeDefined();
  expect(body("Lieferantenliste")).toBe("Erste Zeile.\n\nZweite Zeile.");
});

test("append, prepend and old_text/new_text work without base_version", async () => {
  await note();
  expect((await tool("update", { ref: "Lieferantenliste", body: "Unten", body_mode: "append" })).error).toBe(false);
  expect((await tool("update", { ref: "Lieferantenliste", body: "Oben", body_mode: "prepend" })).error).toBe(false);
  expect((await tool("update", { ref: "Lieferantenliste", old_text: "Zweite", new_text: "2." })).error).toBe(false);
  expect(body("Lieferantenliste")).toBe("Oben\n\nErste Zeile.\n\n2. Zeile.\n\nUnten");
  // properties, title and tags need none either (last writer wins)
  expect((await tool("update", { ref: "Lieferantenliste", title: "Lieferanten", tags_add: ["liste"] })).error).toBe(false);
});

test("base_version is checked with any change when given", async () => {
  await note();
  const read = await getVersion("Lieferantenliste");
  await tool("update", { ref: "Lieferantenliste", tags_add: ["neu"] });
  const r = await tool("update", { ref: "Lieferantenliste", title: "Umbenannt", base_version: read });
  expect(r.error).toBe(true);
  expect(r.text).toMatch(/changed since you read it[\s\S]*: tags/);
  expect(r.text).not.toMatch(/Only in/); // no body diff when the body is not replaced
  const a = await tool("update", { ref: "Lieferantenliste", body: "Nachtrag", body_mode: "append", base_version: read });
  expect(a.error).toBe(true);
  // the right version passes
  expect((await tool("update", { ref: "Lieferantenliste", title: "Umbenannt", base_version: await getVersion("Lieferantenliste") })).error).toBe(false);
});

test("the version covers the content update can overwrite, not places or progress notes", async () => {
  await tool("create", { items: [{ title: "Ordner", pin: true }, { title: "Website", type: "Projekt", properties: { Status: "Planung" } }] });
  const v0 = await getVersion("Website");
  await tool("place", { ref: "Website", add: ["Ordner"] });
  await tool("add_update", { ref: "Website", text: "Kickoff war gut" });
  expect(await getVersion("Website")).toBe(v0);
  const st = await tool("update", { ref: "Website", properties: { Status: "aktiv" } });
  const v1 = versionIn(st.text);
  expect(v1).not.toBe(v0);
  expect(await getVersion("Website")).toBe(v1);
  const r = await tool("update", { ref: "Website", body: "Neu", base_version: v0 });
  expect(r.text).toMatch(/: Status/); // the property by its name, not its id
  expect((await tool("update", { ref: "Website", body: "Neu", base_version: v1 })).error).toBe(false);
});

test("versions do not depend on the order keys were written in", () => {
  const a = ops.create({ title: "X", type: "Projekt", properties: { Status: "Planung" }, tags: ["a"] }, "agent:test");
  const v = versionOf(a);
  const copy = { ...a, props: Object.fromEntries(Object.entries(a.props).reverse()) };
  expect(versionOf(copy)).toBe(v);
  expect(versionOf({ ...a, body: "anders" })).not.toBe(v);
});

test("concurrent replaces with the same base_version: exactly one wins", async () => {
  await note();
  const read = await getVersion("Lieferantenliste");
  const results = await Promise.all(["Fassung A", "Fassung B", "Fassung C"].map((b) => tool("update", { ref: "Lieferantenliste", body: b, base_version: read })));
  expect(results.filter((r) => !r.error).length).toBe(1);
  expect(results.filter((r) => r.error).every((r) => /changed since you read it/.test(r.text))).toBe(true);
  const winner = ["Fassung A", "Fassung B", "Fassung C"][results.findIndex((r) => !r.error)]!;
  expect(body("Lieferantenliste")).toBe(winner);
});

test("concurrent appends all arrive", async () => {
  await note();
  await Promise.all(["A1", "B1", "C1"].map((b) => tool("update", { ref: "Lieferantenliste", body: b, body_mode: "append" })));
  for (const b of ["A1", "B1", "C1"]) expect(body("Lieferantenliste")).toContain(b);
});
