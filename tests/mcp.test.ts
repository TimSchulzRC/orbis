import { test, expect, beforeEach, afterAll } from "bun:test";
import { tempDir, removeTempDirs } from "./helpers";
import { Store } from "@obtion/hub/store";
import { handleMcp } from "@obtion/hub/mcp";
import { runSetup } from "@obtion/core/setup";
import { storeWriter } from "@obtion/hub/importers";
import { deleteType } from "@obtion/core/typeops";

afterAll(removeTempDirs);

let s: Store;
beforeEach(() => {
  s = new Store(tempDir("obtion-mcp-"));
  runSetup(storeWriter(s, "system:setup"), "de");
  s.flush();
});

let rpcId = 0;
async function rpc(method: string, params: unknown) {
  const req = new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const res = await handleMcp(s, req);
  return (await res.json()) as any;
}
async function tool(name: string, args: unknown): Promise<{ text: string; error: boolean }> {
  const r = await rpc("tools/call", { name, arguments: args });
  return { text: r.result.content.map((c: { text: string }) => c.text).join("\n"), error: !!r.result.isError };
}
const count = () => s.live().length;

test("all or nothing: one bad item in a create call, nothing is created", async () => {
  const before = count();
  const seq = s.seq;
  const r = await tool("create", { items: [{ title: "Gut", type: "Task" }, { title: "Schlecht", type: "Task", properties: { Status: "lila" } }] });
  expect(r.error).toBe(true);
  expect(r.text).toMatch(/^Nothing changed\. "lila" is not an option of "Status"/);
  expect(count()).toBe(before);
  expect(s.seq).toBe(seq);
  expect(s.index().resolveTitle("Gut")).toBeUndefined();
  // and the store still works normally afterwards
  expect((await tool("create", { items: [{ title: "Gut", type: "Task" }] })).error).toBe(false);
  expect(s.index().resolveTitle("Gut")).toBeDefined();
});

test("answers have one line per entry with id, type, status, due, path and blockers", async () => {
  await tool("create", { items: [{ title: "Arbeit", pin: true }] });
  await tool("create", { items: [{ title: "Website", type: "Projekt", parents: ["Arbeit"], properties: { Status: "aktiv" } }] });
  await tool("create", { items: [{ title: "Zertifikat", type: "Task", parents: ["Website"] }] });
  const r = await tool("create", { items: [{ title: "Deploy", type: "Task", parents: ["Website"], properties: { Fällig: "30.10.2026", "Blockiert durch": ["Zertifikat"] } }] });
  const id = s.index().resolveTitle("Deploy")!;
  expect(r.text.split("\n").slice(0, 2)).toEqual(["Created:", `- Deploy [${id}] · Task · Nicht begonnen (todo) · due 2026-10-30 · Arbeit › Website · ⚠ blocked by "Zertifikat"`]);
  expect(r.text).toMatch(/\(step s\w+ – undo it with the undo tool\)$/);
  const q = await tool("query", { query: "typ:Task blockiert" });
  expect(q.text.split("\n")).toEqual([expect.stringMatching(/^1 item\(s\) · typ:Task blockiert/), expect.stringMatching(/^- Deploy \[/)]);
});

test("hints: unresolved links, duplicate and unlinkable titles, done with open items, no longer blocked", async () => {
  const a = await tool("create", { items: [{ title: "Projekt X", type: "Projekt", body: "Siehe [[Gibt es nicht]]." }] });
  expect(a.text).toContain('[[Gibt es nicht]] in "Projekt X" does not match any item');
  const b = await tool("create", { items: [{ title: "Projekt X" }] });
  expect(b.text).toContain('Another item is also called "Projekt X"');
  const c = await tool("create", { items: [{ title: "C# | Notizen" }] });
  const cid = s.index().resolveTitle("C# | Notizen") ?? s.live().find((i) => i.title === "C# | Notizen")!.id;
  expect(c.text).toContain(`can't be linked by title; link it as [[${cid}|C Notizen]]`);
  // [[id|Label]] links exactly
  await tool("create", { items: [{ title: "Verweis", body: `Siehe [[${cid}|C# Notizen]].` }] });
  expect(s.index().textLinks(s.live().find((i) => i.title === "Verweis")!).map((l) => l.to)).toEqual([cid]);

  await tool("create", { items: [{ title: "Release", type: "Projekt" }] });
  await tool("create", { items: [{ title: "Tests", type: "Task", parents: ["Release"] }, { title: "Doku", type: "Task", parents: ["Release"], properties: { "Blockiert durch": ["Tests"] } }] });
  const done = await tool("update", { ref: "Release", properties: { Status: "erledigt" } });
  expect(done.text).toContain('"Release" is marked done, but 2 open item(s) are below it');
  const freed = await tool("set_status", { refs: ["Tests"], status: "done" });
  expect(freed.text).toContain('No longer blocked: "Doku".');
  // a relation value outside the target is saved, with a hint
  await tool("create", { items: [{ title: "Lose Idee" }] });
  const off = await tool("update", { ref: "Doku", properties: { "Blockiert durch": ["Lose Idee"] } });
  expect(off.error).toBe(false);
  expect(off.text).toContain('"Lose Idee" doesn\'t match. Saved anyway.');
  const fine = await tool("update", { ref: "Doku", properties: { "Blockiert durch": ["Lose Idee", "Release"] } });
  expect(fine.text).not.toContain("Saved anyway");
});

test("a link to the item itself is refused", async () => {
  const r = await tool("create", { items: [{ title: "Selbst", body: "Mehr unter [[Selbst]]." }] });
  expect(r.error).toBe(true);
  expect(r.text).toMatch(/^Nothing changed\. .*links to itself/);
  await tool("create", { items: [{ title: "Andere" }] });
  const id = s.index().resolveTitle("Andere")!;
  expect((await tool("update", { ref: "Andere", body: `Siehe [[${id}|mich]]` })).text).toMatch(/links to itself/);
  expect((await tool("update", { ref: "Andere", refs_add: ["Andere"] })).text).toMatch(/cannot refer to itself/);
  expect((await tool("create", { items: [{ title: "T", type: "Task", properties: { "Blockiert durch": ["T"] } }] })).error).toBe(true);
});

test("prompts process_inbox and weekly_review", async () => {
  const r = await rpc("prompts/list", {});
  expect(r.result.prompts.map((p: { name: string }) => p.name).sort()).toEqual(["process_inbox", "weekly_review"]);
  const w = await rpc("prompts/get", { name: "weekly_review" });
  const text = w.result.messages[0].content.text as string;
  for (const part of ["done>-7d", "blocked", "14 days", "inbox"]) expect(text).toContain(part);
});

test("the queries the weekly review uses parse", async () => {
  for (const q of ["done>-7d", "status:open due<today", "blocked status:open", "inbox"]) {
    const r = await tool("query", { query: q });
    expect([q, r.error]).toEqual([q, false]);
  }
});

test("with zero types the agent still reads, creates, queries and gets told how to start a type", async () => {
  const w = storeWriter(s, "system:test");
  await tool("create", { items: [{ title: "Website", type: "Projekt", properties: { Status: "aktiv" } }] });
  for (const id of [...s.index().types.keys()]) deleteType(w, s.index(), id, { mode: "remove" }, "test");
  s.flush();
  expect(s.index().types.size).toBe(0);
  const schema = await tool("schema", {});
  expect(schema.error).toBe(false);
  const c = await tool("create", { items: [{ title: "Notiz ohne Typ", parents: ["Website"] }] });
  expect(c.error).toBe(false);
  const q = await tool("query", { query: "unter:[[Website]]" });
  expect(q.text).toContain("Notiz ohne Typ");
  const bad = await tool("create", { items: [{ title: "X", type: "Projekt" }] });
  expect(bad.error).toBe(true);
  expect(bad.text).toMatch(/define_type|No type/i);
});
