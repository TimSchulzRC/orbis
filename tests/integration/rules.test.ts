// "Rules for agents": inheritance over all parents, delivery in the MCP answers and the
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

/** Root › (Country A, Country B) › Client (below both) › Todo, with rules on all but the task. */
function tree() {
  const root = ops.create({ title: "Consulting", pin: true, agent_rules: "Rule root" }, A);
  const a = ops.create({ title: "Country A", parents: [root.id], agent_rules: "Rule country A" }, A);
  const b = ops.create({ title: "Country B", parents: [root.id], agent_rules: "Rule country B" }, A);
  const client = ops.create({ title: "Client", type: "Projekt", parents: [a.id, b.id], agent_rules: "Rule client" }, A);
  const task = ops.create({ title: "Todo", type: "Task", parents: [client.id] }, A);
  return { root, a, b, client, task };
}

test("rules apply from all ancestors over every parent, root first, each once; the workspace's first", () => {
  const { root, a, b, client, task } = tree();
  const ix = s.index();
  expect(ix.ancestors(task.id)).toEqual([root.id, a.id, b.id, client.id]);
  expect(rulesFor(ix, task.id).map((r) => r.text)).toEqual(["Rule root", "Rule country A", "Rule country B", "Rule client"]);
  // a sibling sees only its own line
  expect(rulesFor(ix, b.id).map((r) => r.text)).toEqual(["Rule root", "Rule country B"]);
  setWorkspaceRules("Rule workspace");
  expect(rulesFor(s.index(), task.id).map((r) => [r.owner, r.text])).toEqual([[null, "Rule workspace"], [root.id, "Rule root"], [a.id, "Rule country A"], [b.id, "Rule country B"], [client.id, "Rule client"]]);
  // whitespace is no rule
  ops.update(client.id, { agent_rules: "  \n " }, A);
  expect(s.records.get(client.id)!.rules).toBe("");
});

test("tool answers end with the rules that apply, each rule once per answer", async () => {
  const { task, client } = tree();
  setWorkspaceRules("Rule workspace");
  const g = await tool("get", { ref: task.id });
  expect(g.text).toContain("Rules for agents (binding");
  for (const r of ["Rule workspace", "Rule root", "Rule country A", "Rule country B", "Rule client"]) expect(count(g.text, r)).toBe(1);
  expect(g.text).toContain(`### Consulting › Country A › Client [${client.id}]\nRule client`);
  expect(g.text).toContain("### Workspace\nRule workspace");
  expect(g.text.indexOf("Rule root")).toBeLessThan(g.text.indexOf("Rule client"));

  // the children a get lists bring their own rules
  const parent = await tool("get", { ref: "Country A" });
  expect(parent.text).toContain("Rule client");

  // many results: each distinct rule still once
  for (let n = 0; n < 5; n++) ops.create({ title: `Todo ${n}`, type: "Task", parents: [client.id] }, A);
  const q = await tool("query", { query: "under:[[Consulting]]" });
  expect(count(q.text, "Rules for agents (binding")).toBe(1);
  expect(count(q.text, "Rule client")).toBe(1);
  const f = await tool("search", { query: "Todo" });
  expect(count(f.text, "Rule country B")).toBe(1);

  // writing tools: after the change, with the hints and the step before
  const u = await tool("set_status", { refs: [task.id], status: "erledigt" });
  expect(u.text).toMatch(/\(step s\w+ – undo it with the undo tool\)\n\nRules for agents/);
  expect(count(u.text, "Rule client")).toBe(1);
  const c = await tool("create", { items: [{ title: "New", parents: ["Country B"] }] });
  expect(c.text).toContain("Rule country B");
  expect(c.text).not.toContain("Rule country A");
  expect((await tool("add_update", { ref: "Client", text: "Running" })).text).toContain("Rule client");
  // placing it elsewhere brings that place's rules
  const p = await tool("place", { ref: "New", add: ["Country A"] });
  expect(p.text).toContain("Rule country A");
  const d = await tool("delete", { ref: "New" });
  expect(d.text).toContain("Rule country B");
  expect((await tool("restore", { ref: "New" })).text).toContain("Rule country A");
  expect((await tool("focus", {})).text).toContain("Rule workspace");

  // an item no rule reaches: the workspace's only; none at all: no block
  const lose = await tool("get", { ref: "New" });
  expect(lose.text).toContain("Rule root");
  setWorkspaceRules("");
  ops.create({ title: "Outside", pin: true }, A);
  expect((await tool("get", { ref: "Outside" })).text).not.toContain("Rules for agents");
});

test("activity, history, undo and focus's recent changes bring the rules of the items they name", async () => {
  const { task } = tree();
  const u = await tool("update", { ref: task.id, body: "First text", base_version: (await tool("get", { ref: task.id })).text.match(/"version": "(\w+)"/)?.[1] });
  expect(u.error).toBe(false);
  for (const [name, args] of [["activity", { days: 1 }], ["history", { ref: task.id }], ["focus", {}], ["undo", { step: stepOf(u.text) }]] as const)
    expect((await tool(name, args)).text, name).toContain("Rule client");
  // an activity about an item without changes in the time asked for names its rules too
  const quiet = ops.create({ title: "Quiet", parents: [task.id] }, A);
  expect((await tool("activity", { ref: quiet.id, since: new Date(Date.now() + 60_000).toISOString().slice(0, 16) })).text).toContain("Rule client");
});

test("suggest brings the rules of the places it proposes", async () => {
  tree();
  ops.create({ title: "Note in the inbox" }, A);
  const r = await tool("suggest", { ref: "Note in the inbox", parents: ["Country A"] });
  expect(r.text).toContain("Rule country A");
});

test("update and create take agent_rules; null clears; activity names the field; undo brings them back", async () => {
  const c = await tool("create", { items: [{ title: "Project room", pin: true, agent_rules: "Never write to production." }] });
  expect(c.error).toBe(false);
  const id = s.index().resolveTitle("Project room")!;
  expect(s.records.get(id)!.rules).toBe("Never write to production.");
  const u = await tool("update", { ref: id, agent_rules: "Ask first, then send." });
  expect(u.text).toContain("Ask first, then send.");
  expect(u.text).not.toContain("Never write to production");
  expect((await tool("activity", { ref: id })).text).toContain("agent_rules");
  const cleared = await tool("update", { ref: id, agent_rules: null });
  expect(s.records.get(id)!.rules).toBe("");
  expect(cleared.text).not.toContain("Rules for agents");
  undoStep(s, stepOf(cleared.text), A);
  s.flush();
  expect(s.records.get(id)!.rules).toBe("Ask first, then send.");
  const ev = s.events({ doc: id, limit: 10 });
  expect(ev.some((e) => e.changes.some((x) => x.field === "rules"))).toBe(true);
});

test("the workspace's rules: in the instructions of every connection, in schema, in activity", async () => {
  const before = (await storeRpc(s, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).result.instructions as string;
  expect(before).toContain("Rules for agents:");
  expect(before).not.toContain("Rules for agents of this workspace");
  setWorkspaceRules("No e-mails without approval.");
  const after = (await storeRpc(s, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } })).result.instructions as string;
  expect(after).toContain("Rules for agents of this workspace (binding everywhere, as of now):\nNo e-mails without approval.");
  const { client } = tree();
  const sc = JSON.parse((await tool("schema", {})).text);
  expect(sc.rules_for_agents.workspace).toBe("No e-mails without approval.");
  expect(sc.rules_for_agents.owners).toContainEqual({ id: client.id, title: "Client", path: "Consulting › Country A", first_line: "Rule client" });
  // a change of the settings doc shows in activity only for its rules
  expect(s.events({ doc: SETTINGS_ID, limit: 10 }).map((e) => e.changes.map((c) => c.field))).toEqual([["rules"]]);
});

test("a very long rule is cut in answers about other items, whole in get of its owner", async () => {
  const long = "Rules. ".repeat(Math.ceil(RULE_CAP / 7) * 2);
  const root = ops.create({ title: "Long", pin: true, agent_rules: long }, A);
  ops.create({ title: "Below", parents: [root.id] }, A);
  const below = await tool("get", { ref: "Below" });
  expect(below.text).toContain(`… (shortened – read it in full with get "${root.id}")`);
  expect(below.text.length).toBeLessThan(long.length);
  const own = await tool("get", { ref: root.id });
  expect(own.text).toContain(long.trim());
  expect(own.text).not.toContain("shortened");
});

test("the mirror keeps the rules: a section on the page, the workspace's in the README", () => {
  const m = new Mirror(s, join(dir, "vault"));
  tree();
  setWorkspaceRules("Rule workspace");
  m.sync();
  // the heading comes from the German setup
  expect(readFileSync(join(dir, "vault", "Consulting", "Country A", "Client.md"), "utf8")).toContain("## Regeln für Agenten\n\nRule client\n");
  expect(readFileSync(join(dir, "vault", "README.md"), "utf8")).toContain("Rule workspace");
});
