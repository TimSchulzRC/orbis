// An agent bringing data over from Notion or Obsidian through the MCP operations.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { removeTempDirs } from "../support/helpers";
import { setupStore } from "../support/store";
import type { Store } from "@obtion/server/store";
import type { Ops } from "@obtion/server/ops";

afterAll(removeTempDirs);

let s: Store;
let ops: Ops;
const A = "agent:test";
beforeEach(() => ({ s, ops } = setupStore("obtion-migration-")));

test("source, original times, aliases and free properties on create", () => {
  const folder = ops.create({ title: "Themen", source: "obsidian:Themen" }, A);
  const note = ops.create(
    {
      title: "Künstliche Intelligenz",
      parents: ["obsidian:Themen"],
      source: "obsidian:Themen/Künstliche Intelligenz.md",
      created: "2021-03-04T10:00:00Z",
      updated: 1700000000000,
      aliases: ["KI"],
      free_properties: { autoren: ["[[Ada]]", "[[Grace]]"], gelesen: true, seiten: 312, termin: "2024-05-01T14:30:00+02:00", quelle: "https://example.org/x", notiz: "kurz" },
      body: "Siehe [[KI]].",
    },
    A,
  );
  expect(note.parents[folder.id]).toBeDefined();
  expect(note.created).toBe(Date.parse("2021-03-04T10:00:00Z"));
  expect(note.updated).toBe(1700000000000);
  expect(note.aliases).toEqual(["KI"]);
  expect(note.extra).toEqual({
    autoren: { k: "list", v: ["[[Ada]]", "[[Grace]]"] },
    gelesen: { k: "checkbox", v: true },
    seiten: { k: "number", v: 312 },
    termin: { k: "date", v: "2024-05-01T14:30" },
    quelle: { k: "url", v: "https://example.org/x" },
    notiz: { k: "text", v: "kurz" },
  });
  // refs accept the source, and the [[Alias]] in the body resolves
  expect(ops.resolve("obsidian:Themen/Künstliche Intelligenz.md").id).toBe(note.id);
  expect(s.index().resolveTitle("KI")).toBe(note.id);
  const got = ops.get(note.id) as Record<string, unknown>;
  expect(got.source).toBe("obsidian:Themen/Künstliche Intelligenz.md");
  expect(got.aliases).toEqual(["KI"]);
});

test("a second create with the same source is refused and names the first", () => {
  const first = ops.create({ title: "Page", source: "notion:abc" }, A);
  expect(() => ops.create({ title: "Page again", source: "notion:abc" }, A)).toThrow(new RegExp(`brought over already.*${first.id}`));
  const other = ops.create({ title: "Other" }, A);
  expect(() => ops.update(other.id, { source: "notion:abc" }, A)).toThrow(/source of/);
});

test("update sets free properties, aliases and the source; type properties are refused as free ones", () => {
  const x = ops.create({ title: "Review", type: "Task" }, A);
  expect(() => ops.update(x.id, { free_properties: { Fällig: "2026-01-01" } }, A)).toThrow(/property of type Task/);
  ops.update(x.id, { free_properties: { Tags: ["a", "b"] }, aliases_add: ["Code Review"], source: "notion:1" }, A);
  let now = ops.resolve("notion:1");
  expect(now.id).toBe(x.id);
  expect(now.extra.Tags).toEqual({ k: "list", v: ["a", "b"] });
  expect(now.aliases).toEqual(["Code Review"]);
  ops.update(x.id, { free_properties: { tags: null }, aliases_remove: ["code review"], source: null }, A);
  now = ops.resolve(x.id);
  expect(now.extra).toEqual({});
  expect(now.aliases).toEqual([]);
  expect(now.source).toBeUndefined();
});

test("a date property keeps its time", () => {
  const x = ops.create({ title: "Call", type: "Task", properties: { Fällig: "2026-10-30T09:00:00.000+02:00" } }, A);
  const due = Object.values(x.props).find((v) => typeof v === "string" && v.startsWith("2026-10-30"));
  expect(due).toBe("2026-10-30T09:00");
  expect(ops.line(x)).toContain("due 2026-10-30");
});
