// "Regeln für Agenten": inheritance over all parents, delivery in the MCP answers and the
// instructions, writing through create/update, undo, activity, the mirror.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { removeTempDirs } from "../support/helpers";
import { rpc as storeRpc, setupStore, stepOf, tool as storeTool } from "../support/store";
import type { Store } from "@obtion/server/store";
import type { Ops } from "@obtion/server/ops";
import { RULE_CAP } from "@obtion/server/ops";
import { Mirror } from "@obtion/server/mirror";
import { undoStep } from "@obtion/server/undo";
import { SETTINGS_ID, setRules } from "@obtion/core/model";
import { rulesFor } from "@obtion/core/rules";

afterAll(removeTempDirs);

let dir: string;
let s: Store;
let ops: Ops;
const A = "agent:test";
beforeEach(() => ({ dir, s, ops } = setupStore("obtion-rules-")));

const tool = (name: string, args: unknown) => storeTool(s, name, args);
const count = (text: string, part: string) => text.split(part).length - 1;
const setWorkspaceRules = (text: string) => (s.change(SETTINGS_ID, "web:tim", (d) => setRules(d, text)), s.flush());

/** Root › (Land A, Land B) › Kunde (below both) › Aufgabe, with rules on all but the task. */
function tree() {
  const root = ops.create({ title: "Beratung", pin: true, agent_rules: "Regel Wurzel" }, A);
  const a = ops.create({ title: "Land A", parents: [root.id], agent_rules: "Regel Land A" }, A);
  const b = ops.create({ title: "Land B", parents: [root.id], agent_rules: "Regel Land B" }, A);
  const kunde = ops.create({ title: "Kunde", type: "Projekt", parents: [a.id, b.id], agent_rules: "Regel Kunde" }, A);
  const task = ops.create({ title: "Aufgabe", type: "Task", parents: [kunde.id] }, A);
  return { root, a, b, kunde, task };
}

test("rules apply from all ancestors over every parent, root first, each once; the workspace's first", () => {
  const { root, a, b, kunde, task } = tree();
  const ix = s.index();
  expect(ix.ancestors(task.id)).toEqual([root.id, a.id, b.id, kunde.id]);
  expect(rulesFor(ix, task.id).map((r) => r.text)).toEqual(["Regel Wurzel", "Regel Land A", "Regel Land B", "Regel Kunde"]);
  // a sibling sees only its own line
  expect(rulesFor(ix, b.id).map((r) => r.text)).toEqual(["Regel Wurzel", "Regel Land B"]);
  setWorkspaceRules("Regel Workspace");
  expect(rulesFor(s.index(), task.id).map((r) => [r.owner, r.text])).toEqual([[null, "Regel Workspace"], [root.id, "Regel Wurzel"], [a.id, "Regel Land A"], [b.id, "Regel Land B"], [kunde.id, "Regel Kunde"]]);
  // whitespace is no rule
  ops.update(kunde.id, { agent_rules: "  \n " }, A);
  expect(s.records.get(kunde.id)!.rules).toBe("");
});

test("tool answers end with the rules that apply, each rule once per answer", async () => {
  const { task, kunde } = tree();
  setWorkspaceRules("Regel Workspace");
  const g = await tool("get", { ref: task.id });
  expect(g.text).toContain("Rules for agents (binding");
  for (const r of ["Regel Workspace", "Regel Wurzel", "Regel Land A", "Regel Land B", "Regel Kunde"]) expect(count(g.text, r)).toBe(1);
  expect(g.text).toContain(`### Beratung › Land A › Kunde [${kunde.id}]\nRegel Kunde`);
  expect(g.text).toContain("### Workspace\nRegel Workspace");
  expect(g.text.indexOf("Regel Wurzel")).toBeLessThan(g.text.indexOf("Regel Kunde"));

  // the children a get lists bring their own rules
  const parent = await tool("get", { ref: "Land A" });
  expect(parent.text).toContain("Regel Kunde");

  // many results: each distinct rule still once
  for (let n = 0; n < 5; n++) ops.create({ title: `Aufgabe ${n}`, type: "Task", parents: [kunde.id] }, A);
  const q = await tool("query", { query: "under:[[Beratung]]" });
  expect(count(q.text, "Rules for agents (binding")).toBe(1);
  expect(count(q.text, "Regel Kunde")).toBe(1);
  const f = await tool("search", { query: "Aufgabe" });
  expect(count(f.text, "Regel Land B")).toBe(1);

  // writing tools: after the change, with the hints and the step before
  const u = await tool("set_status", { refs: [task.id], status: "erledigt" });
  expect(u.text).toMatch(/\(step s\w+ – undo it with the undo tool\)\n\nRules for agents/);
  expect(count(u.text, "Regel Kunde")).toBe(1);
  const c = await tool("create", { items: [{ title: "Neu", parents: ["Land B"] }] });
  expect(c.text).toContain("Regel Land B");
  expect(c.text).not.toContain("Regel Land A");
  expect((await tool("add_update", { ref: "Kunde", text: "Läuft" })).text).toContain("Regel Kunde");
  // placing it elsewhere brings that place's rules
  const p = await tool("place", { ref: "Neu", add: ["Land A"] });
  expect(p.text).toContain("Regel Land A");
  const d = await tool("delete", { ref: "Neu" });
  expect(d.text).toContain("Regel Land B");
  expect((await tool("restore", { ref: "Neu" })).text).toContain("Regel Land A");
  expect((await tool("focus", {})).text).toContain("Regel Workspace");

  // an item no rule reaches: the workspace's only; none at all: no block
  const lose = await tool("get", { ref: "Neu" });
  expect(lose.text).toContain("Regel Wurzel");
  setWorkspaceRules("");
  ops.create({ title: "Draußen", pin: true }, A);
  expect((await tool("get", { ref: "Draußen" })).text).not.toContain("Rules for agents");
});

test("suggest brings the rules of the places it proposes", async () => {
  tree();
  ops.create({ title: "Notiz im Eingang" }, A);
  const r = await tool("suggest", { ref: "Notiz im Eingang", parents: ["Land A"] });
  expect(r.text).toContain("Regel Land A");
});

test("update and create take agent_rules; null clears; activity names the field; undo brings them back", async () => {
  const c = await tool("create", { items: [{ title: "Projektraum", pin: true, agent_rules: "Nie in Produktion schreiben." }] });
  expect(c.error).toBe(false);
  const id = s.index().resolveTitle("Projektraum")!;
  expect(s.records.get(id)!.rules).toBe("Nie in Produktion schreiben.");
  const u = await tool("update", { ref: id, agent_rules: "Erst fragen, dann senden." });
  expect(u.text).toContain("Erst fragen, dann senden.");
  expect(u.text).not.toContain("Nie in Produktion");
  expect((await tool("activity", { ref: id })).text).toContain("agent_rules");
  const cleared = await tool("update", { ref: id, agent_rules: null });
  expect(s.records.get(id)!.rules).toBe("");
  expect(cleared.text).not.toContain("Rules for agents");
  undoStep(s, stepOf(cleared.text), A);
  s.flush();
  expect(s.records.get(id)!.rules).toBe("Erst fragen, dann senden.");
  const ev = s.events({ doc: id, limit: 10 });
  expect(ev.some((e) => e.changes.some((x) => x.field === "rules"))).toBe(true);
});

test("the workspace's rules: in the instructions of every connection, in schema, in activity", async () => {
  const before = (await storeRpc(s, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).result.instructions as string;
  expect(before).toContain("Rules for agents:");
  expect(before).not.toContain("Rules for agents of this workspace");
  setWorkspaceRules("Keine E-Mails ohne Freigabe.");
  const after = (await storeRpc(s, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).result.instructions as string;
  expect(after).toContain("Rules for agents of this workspace (binding everywhere, as of now):\nKeine E-Mails ohne Freigabe.");
  const { kunde } = tree();
  const sc = JSON.parse((await tool("schema", {})).text);
  expect(sc.rules_for_agents.workspace).toBe("Keine E-Mails ohne Freigabe.");
  expect(sc.rules_for_agents.owners).toContainEqual({ id: kunde.id, title: "Kunde", path: "Beratung › Land A", first_line: "Regel Kunde" });
  // a change of the settings doc shows in activity only for its rules
  expect(s.events({ doc: SETTINGS_ID, limit: 10 }).map((e) => e.changes.map((c) => c.field))).toEqual([["rules"]]);
});

test("a very long rule is cut in answers about other items, whole in get of its owner", async () => {
  const long = "Regel. ".repeat(Math.ceil(RULE_CAP / 7) * 2);
  const root = ops.create({ title: "Lang", pin: true, agent_rules: long }, A);
  ops.create({ title: "Darunter", parents: [root.id] }, A);
  const below = await tool("get", { ref: "Darunter" });
  expect(below.text).toContain(`… (shortened – read it in full with get "${root.id}")`);
  expect(below.text.length).toBeLessThan(long.length);
  const own = await tool("get", { ref: root.id });
  expect(own.text).toContain(long.trim());
  expect(own.text).not.toContain("shortened");
});

test("the mirror keeps the rules: a section on the page, the workspace's in the README", () => {
  const m = new Mirror(s, join(dir, "vault"));
  tree();
  setWorkspaceRules("Regel Workspace");
  m.sync();
  expect(readFileSync(join(dir, "vault", "Beratung", "Land A", "Kunde.md"), "utf8")).toContain("## Regeln für Agenten\n\nRegel Kunde\n");
  expect(readFileSync(join(dir, "vault", "README.md"), "utf8")).toContain("Regel Workspace");
});
