import { test, expect, beforeEach, afterAll } from "bun:test";
import { removeTempDirs } from "../support/helpers";
import { setupStore, tool as storeTool } from "../support/store";
import type { Store } from "@obtion/server/store";
import type { Ops } from "@obtion/server/ops";
import { undoStep } from "@obtion/server/undo";
import { Backups } from "@obtion/server/backup";
import { Database } from "bun:sqlite";
import { replaceBody, touch } from "@obtion/core/model";
import { personOrigin, agentOrigin } from "@obtion/core/origin";
import { join } from "node:path";

afterAll(removeTempDirs);

let s: Store;
let ops: Ops;
let dir: string;
beforeEach(() => ({ s, ops, dir } = setupStore("obtion-history-")));

const AG = agentOrigin("claude-code", { id: "u1", name: "Tim" });
const TIM = personOrigin({ id: "u1", name: "Tim" }, "Mac");
const ANNA = personOrigin({ id: "u2", name: "Anna" }, "Phone");
const tool = (name: string, args: unknown) => storeTool(s, name, args);
const idOf = (title: string) => s.index().resolveTitle(title)!;

/** A person's edit in the app: one step of its own. */
function edit(origin: string, id: string, body: string) {
  s.step(origin, () => s.change(id, origin, (d) => (replaceBody(d, body), touch(d))));
  s.flush();
}
/** Typing in the app: several flushes of one step by one person. */
function typing(origin: string, id: string, texts: string[]) {
  s.step(origin, () => {
    for (const t of texts) {
      s.change(id, origin, (d) => replaceBody(d, t));
      s.flush();
    }
  });
}

test("every change of the text keeps a version; typing in one step folds into one", () => {
  ops.call(AG, () => (ops.create({ title: "Mapping-Konzept", body: "Zeile eins\n" }, AG), "ok"));
  const id = idOf("Mapping-Konzept");
  expect(s.versions(id)).toEqual([]); // created: nothing to keep yet, the first change keeps it
  typing(TIM, id, ["Zeile eins\nZ", "Zeile eins\nZeile zw", "Zeile eins\nZeile zwei\n"]);
  const v = s.versions(id);
  expect(v.map((x) => [x.n, x.origin])).toEqual([
    [1, AG], // the text it was created with, by whoever created it
    [2, TIM], // three flushes of typing: one version
  ]);
  expect(s.versionText(v[0]!.id)).toBe("Zeile eins\n");
  expect(s.versionText(v[1]!.id)).toBe("Zeile eins\nZeile zwei\n");
  // another step (or another person) is a version of its own
  edit(ANNA, id, "Zeile eins\nZeile zwei\nZeile drei\n");
  ops.call(AG, () => (ops.update("Mapping-Konzept", { body: "Zeile null\n", body_mode: "prepend" }, AG), "ok"));
  expect(s.versions(id).map((x) => x.origin)).toEqual([AG, TIM, ANNA, AG]);
  expect(s.versionText(s.versions(id).at(-1)!.id)).toBe(s.records.get(id)!.body);
  // only changes of the text make versions
  ops.call(AG, () => (ops.update("Mapping-Konzept", { tags_add: ["konzept"] }, AG), "ok"));
  expect(s.versions(id).length).toBe(4);
});

test("versions are stored compressed and travel with the daily backup", () => {
  const long = "Ein langer Absatz über die Anbindung, der sich oft wiederholt. ".repeat(400);
  ops.call(AG, () => (ops.create({ title: "Lang" }, AG), "ok"));
  const id = idOf("Lang");
  edit(TIM, id, long);
  const row = s.db.query("SELECT length(data) AS size, len FROM versions WHERE doc = ?").get(id) as { size: number; len: number };
  expect(row.len).toBe(long.length);
  expect(row.size).toBeLessThan(long.length / 10);
  const file = new Backups(s, join(dir, "backups")).run("2026-11-01")!;
  const copy = new Database(file, { readonly: true });
  expect((copy.query("SELECT count(*) AS n FROM versions WHERE doc = ?").get(id) as { n: number }).n).toBe(1);
  copy.close();
});

test("activity: text changes as a diff, properties and options by name, updates with their text", async () => {
  await tool("create", { items: [{ title: "Kunde Nord", type: "Projekt", body: "# Ziel\nRechnungen senden\n\n# Offen\n- Mapping\n" }] });
  await tool("create", { items: [{ title: "Mapping prüfen", type: "Task", parents: ["Kunde Nord"] }] });
  const id = idOf("Kunde Nord");
  edit(TIM, id, "# Ziel\nRechnungen senden und empfangen\n\n# Offen\n- Mapping\n- Testlauf\n");
  await tool("update", { ref: "Mapping prüfen", properties: { Status: "erledigt" } });
  await tool("add_update", { ref: "Kunde Nord", text: "Testlauf mit drei Belegen ok" });
  const out = (await tool("activity", { days: 1 })).text;
  expect(out).toContain(`· Tim · updated "Kunde Nord" [${id}] · Projekt`);
  expect(out).toContain("    -Rechnungen senden");
  expect(out).toContain("    +Rechnungen senden und empfangen");
  expect(out).toContain("    +- Testlauf");
  expect(out).toMatch(/text: \d+ → \d+ characters/);
  expect(out).toContain("Status: Nicht begonnen → Erledigt");
  expect(out).not.toContain("p:p_status");
  expect(out).toContain('update posted: "Testlauf mit drei Belegen ok"');
  expect(out).toMatch(/cursor: \d+-0/);
});

test("activity: a long diff is cut, with the call that shows all of it", async () => {
  await tool("create", { items: [{ title: "Viel Text" }] });
  const id = idOf("Viel Text");
  edit(TIM, id, Array.from({ length: 120 }, (_, i) => `Zeile ${i}`).join("\n") + "\n");
  const out = (await tool("activity", { days: 1, ref: "Viel Text" })).text;
  expect(out).toContain(`more line(s): history ref=${id} from=0 to=1`);
  const full = (await tool("history", { ref: id, from: 0, to: 1 })).text;
  expect(full).toContain("+120 −0 line(s)");
  expect(full).toContain("+Zeile 119");
});

test("activity since a cursor: only what changed after it, also later edits folded into an earlier entry", async () => {
  await tool("create", { items: [{ title: "Notiz A", body: "a\n" }, { title: "Notiz B", body: "b\n" }] });
  const first = (await tool("activity", { since: "2020-01-01T00:00" })).text;
  expect(first).toContain('created "Notiz A"');
  const cursor = /cursor: (\d+-\d+)/.exec(first)![1]!;
  expect((await tool("activity", { since: cursor })).text).toStartWith("0 change(s)");
  await Bun.sleep(2);
  typing(TIM, idOf("Notiz A"), ["a\nzwei\n"]);
  const second = (await tool("activity", { since: cursor })).text;
  expect(second).toStartWith("1 change(s)");
  expect(second).toContain('updated "Notiz A"');
  const cursor2 = /cursor: (\d+-\d+)/.exec(second)![1]!;
  // Tim types on in the same step: the same activity entry grows – and shows up again
  await Bun.sleep(2);
  s.step(TIM, () => s.change(idOf("Notiz A"), TIM, (d) => replaceBody(d, "a\nzwei\ndrei\n")));
  s.flush();
  const third = (await tool("activity", { since: cursor2 })).text;
  expect(third).toStartWith("1 change(s)");
  expect(third).toContain("+drei");
  // an entry id and an ISO time work as since too; nonsense is refused with the reason
  expect((await tool("activity", { since: new Date(Date.now() + 60_000).toISOString() })).text).toStartWith("0 change(s)");
  expect((await tool("activity", { since: "gestern" })).error).toBe(true);
});

test("activity since: in pages with limit, the cursor continues where the page ended", async () => {
  const start = new Date(Date.now() - 1000).toISOString();
  await tool("create", { items: Array.from({ length: 7 }, (_, i) => ({ title: `Punkt ${i}` })) });
  const seen: string[] = [];
  let since = start;
  for (let round = 0; round < 5; round++) {
    const out = (await tool("activity", { since, limit: 3 })).text;
    seen.push(...[...out.matchAll(/created "(Punkt \d)"/g)].map((m) => m[1]!));
    const more = /since="(\d+-\d+)"/.exec(out);
    if (!more) break;
    since = more[1]!;
  }
  expect(seen).toEqual(Array.from({ length: 7 }, (_, i) => `Punkt ${i}`));
});

test("activity under: an item and everything below it, deleted items included", async () => {
  await tool("create", { items: [{ title: "Kunde Ost", type: "Projekt" }, { title: "Kunde West", type: "Projekt" }] });
  await tool("create", { items: [{ title: "Spezifikation", parents: ["Kunde Ost"] }, { title: "Westnotiz", parents: ["Kunde West"] }] });
  await tool("create", { items: [{ title: "Detail", parents: ["Spezifikation"] }, { title: "Alt", parents: ["Kunde Ost"] }] });
  const cursor = /cursor: (\d+-\d+)/.exec((await tool("activity", { days: 1 })).text)![1]!;
  await Bun.sleep(2);
  edit(TIM, idOf("Detail"), "tief unten\n");
  edit(TIM, idOf("Westnotiz"), "woanders\n");
  await tool("delete", { ref: "Alt" });
  const out = (await tool("activity", { since: cursor, under: "Kunde Ost" })).text;
  expect(out).toContain('updated "Detail"');
  expect(out).toContain('deleted "Alt"');
  expect(out).not.toContain("Westnotiz");
  expect(out).toContain('under "Kunde Ost"');
});

test("activity by: people, agents, others, a name", async () => {
  await tool("create", { items: [{ title: "Gemeinsam", body: "x\n" }] });
  const id = idOf("Gemeinsam");
  edit(TIM, id, "x\nvon Tim\n");
  edit(ANNA, id, "x\nvon Tim\nvon Anna\n");
  const by = async (who: string) => (await tool("activity", { days: 1, by: who, diff: false })).text;
  const people = await by("people");
  expect(people).toContain("· Tim ·");
  expect(people).toContain("· Anna ·");
  expect(people).not.toContain("· mcp for Kai ·");
  const agents = await by("agents");
  expect(agents).toContain("· mcp for Kai ·");
  expect(agents).not.toContain("· Tim ·");
  // the test calls come from the agent "mcp" for Kai: others are everyone else
  const others = await by("others");
  expect(others).toContain("· Anna ·");
  expect(others).not.toContain("· mcp for Kai ·");
  const anna = await by("anna");
  expect(anna).toContain("· Anna ·");
  expect(anna).not.toContain("· Tim ·");
  expect(await by("Tim, Anna")).toMatch(/^2 change\(s\)/);
});

test("history: the list, one version, and diffs between versions or to now", async () => {
  await tool("create", { items: [{ title: "Leitfaden", body: "Schritt 1\n" }] });
  const id = idOf("Leitfaden");
  edit(TIM, id, "Schritt 1\nSchritt 2\n");
  edit(ANNA, id, "Schritt 1\nSchritt 2 genauer\n");
  const list = (await tool("history", { ref: "Leitfaden" })).text;
  expect(list).toContain('3 version(s) of the text of "Leitfaden"');
  expect(list).toMatch(/#3 · .* · Anna · \d+ characters · \+1 −1 line\(s\)/);
  expect(list).toMatch(/#1 · .* · mcp for Kai · /);
  expect(list).toContain("The text now is version 3.");
  expect((await tool("history", { ref: id, version: 1 })).text).toEndWith("\n\nSchritt 1\n");
  const d = (await tool("history", { ref: id, from: 1, to: 2 })).text;
  expect(d).toContain("#1 → #2, +1 −0 line(s)");
  expect(d).toContain("+Schritt 2");
  const toNow = (await tool("history", { ref: id, from: 2 })).text;
  expect(toNow).toContain("#2 → the text now");
  expect(toNow).toContain("-Schritt 2\n+Schritt 2 genauer");
  expect((await tool("history", { ref: id, version: 9 })).error).toBe(true);
  // an item whose text never changed
  await tool("create", { items: [{ title: "Ruhig", body: "bleibt\n" }] });
  expect((await tool("history", { ref: "Ruhig" })).text).toContain("has no versions yet");
});

test("restoring a version is a change of its own: a new version, in the activity, undoable", async () => {
  await tool("create", { items: [{ title: "Vertragsnotiz", body: "Fassung A\n" }] });
  const id = idOf("Vertragsnotiz");
  edit(ANNA, id, "Fassung B\n");
  const [a] = s.versions(id);
  // what the app does: write the old text as a new change, in its own step
  const step = s.step(TIM, (st) => (s.change(id, TIM, (d) => (replaceBody(d, s.versionText(a!.id)!), touch(d))), st));
  s.flush();
  expect(s.records.get(id)!.body).toBe("Fassung A\n");
  expect(s.versions(id).map((v) => v.origin)).toEqual(["agent:mcp;u=u0;n=Kai", ANNA, TIM]);
  const restored = s.events({ doc: id, limit: 1 })[0]!;
  expect(restored).toMatchObject({ origin: TIM, step });
  expect(restored.changes.find((c) => c.field === "body")).toMatchObject({ diff: true });
  expect(s.eventText(restored.id)).toMatchObject({ before: "Fassung B\n", after: "Fassung A\n", from: 2, to: 3 });
  // undo brings B back, as one more version
  const r = undoStep(s, step, TIM);
  expect(r.changed).toEqual([id]);
  expect(s.records.get(id)!.body).toBe("Fassung B\n");
  expect(s.versions(id).length).toBe(4);
  expect(s.versionText(s.versions(id).at(-1)!.id)).toBe("Fassung B\n");
  const out = (await tool("activity", { days: 1, ref: id })).text;
  expect(out).toContain("undid a step");
});

test("what an activity entry changed: the versions before and after it", async () => {
  await tool("create", { items: [{ title: "Über HTTP", body: "eins\n" }] });
  const id = idOf("Über HTTP");
  edit(TIM, id, "eins\nzwei\n");
  const ev = s.events({ doc: id, limit: 1 })[0]!;
  expect(s.eventText(ev.id)).toEqual({ doc: id, before: "eins\n", after: "eins\nzwei\n", from: 1, to: 2 });
  const [v1] = s.versions(id);
  expect(s.versionText(v1!.id, "andere-id")).toBeUndefined();
  // an entry that kept no version (the creation) has nothing to show
  const created = s.events({ doc: id, limit: 5 }).find((e) => e.kind === "created")!;
  expect(s.eventText(created.id)).toBeUndefined();
});

test("edits that keep the length still show their diff when folded into one entry", async () => {
  await tool("create", { items: [{ title: "Tier", body: "cat\n" }] });
  const id = idOf("Tier");
  typing(TIM, id, ["bat\n", "bar\n"]);
  const ev = s.events({ doc: id, limit: 1 })[0]!;
  expect(ev.changes.find((c) => c.field === "body")).toMatchObject({ diff: true });
  expect((await tool("activity", { days: 1, ref: id })).text).toContain("-cat\n    +bar");
});

test("activity without since says how to get the older entries a limit cut off", async () => {
  await tool("create", { items: Array.from({ length: 4 }, (_, i) => ({ title: `Eintrag ${i}` })) });
  const out = (await tool("activity", { days: 1, limit: 2 })).text;
  expect(out).toMatch(/More, older changes than these: raise limit, or go through all of them oldest first with since="\d{4}-/);
});

test("a deleted item's activity and subtree stay readable by id", async () => {
  await tool("create", { items: [{ title: "Altprojekt", type: "Projekt" }] });
  await tool("create", { items: [{ title: "Unterpunkt", parents: ["Altprojekt"] }] });
  const id = idOf("Altprojekt");
  await tool("delete", { ref: "Altprojekt", children: "trash" });
  const out = await tool("activity", { days: 1, under: id });
  expect(out.error).toBe(false);
  expect(out.text).toContain('created "Unterpunkt"');
  expect(out.text).toContain('deleted "Altprojekt"');
});
