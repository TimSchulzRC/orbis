// Free properties, aliases and dates with a time through the agent operations.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { removeTempDirs } from "../support/helpers";
import { setupStore } from "../support/store";
import type { Store } from "@obtion/server/store";
import type { Ops } from "@obtion/server/ops";

afterAll(removeTempDirs);

let s: Store;
let ops: Ops;
const A = "agent:test";
beforeEach(() => ({ s, ops } = setupStore("obtion-free-")));

test("create with aliases and free properties; the kind follows the value", () => {
  const note = ops.create(
    {
      title: "Künstliche Intelligenz",
      aliases: ["KI"],
      free_properties: { autoren: ["Ada", "Grace"], gelesen: true, seiten: 312, termin: "2024-05-01T14:30:00+02:00", quelle: "https://example.org/x", notiz: "kurz" },
    },
    A,
  );
  expect(note.aliases).toEqual(["KI"]);
  expect(note.extra).toEqual({
    autoren: { k: "list", v: ["Ada", "Grace"] },
    gelesen: { k: "checkbox", v: true },
    seiten: { k: "number", v: 312 },
    termin: { k: "date", v: "2024-05-01T14:30" },
    quelle: { k: "url", v: "https://example.org/x" },
    notiz: { k: "text", v: "kurz" },
  });
  ops.create({ title: "Notiz", body: "Siehe [[KI]]." }, A);
  expect(s.index().resolveTitle("KI")).toBe(note.id);
  expect((ops.get(note.id) as Record<string, unknown>).aliases).toEqual(["KI"]);
  expect(() => ops.create({ title: "x", free_properties: { tief: { a: 1 } } }, A)).toThrow(/is an object/);
});

test("update sets and removes free properties and aliases; type properties are refused as free ones", () => {
  const x = ops.create({ title: "Review", type: "Task" }, A);
  expect(() => ops.update(x.id, { free_properties: { Fällig: "2026-01-01" } }, A)).toThrow(/property of type Task/);
  ops.update(x.id, { free_properties: { Tags: ["a", "b"] }, aliases_add: ["Code Review"] }, A);
  let now = ops.resolve(x.id);
  expect(now.extra.Tags).toEqual({ k: "list", v: ["a", "b"] });
  expect(now.aliases).toEqual(["Code Review"]);
  ops.update(x.id, { free_properties: { tags: null }, aliases_remove: ["code review"] }, A);
  now = ops.resolve(x.id);
  expect(now.extra).toEqual({});
  expect(now.aliases).toEqual([]);
});

test("a date property keeps its time", () => {
  const x = ops.create({ title: "Call", type: "Task", properties: { Fällig: "2026-10-30T09:00:00.000+02:00" } }, A);
  const due = Object.values(x.props).find((v) => typeof v === "string" && v.startsWith("2026-10-30"));
  expect(due).toBe("2026-10-30T09:00");
  expect(ops.line(x)).toContain("due 2026-10-30");
});
