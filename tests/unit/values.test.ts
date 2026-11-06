// Format 3: dates with a time, lists in free properties (a former multiple choice) and former property names.
import { test, expect, describe } from "bun:test";
import { MemRepo } from "../support/helpers";
import { parseDateTime, dateText } from "@obtion/core/input";
import { dayOf, timeOf } from "@obtion/core/date";
import { propByName, readSchema, setExtra, upsertProp } from "@obtion/core/model";
import { dateEnd, dueOf } from "@obtion/core/traits";
import { freeDef, mapValue, toFree } from "@obtion/core/typeops";
import { groupItems, parseQuery, runQuery as run } from "@obtion/core/query";
import type { Index } from "@obtion/core/graph";

const runQuery = (q: string, ix: Index, ctx: { today?: string }) => run(parseQuery(q, ix).def, { ix, ...ctx });

const TODAY = "2026-11-06";

describe("dates with a time", () => {
  test("parseDateTime keeps the time, drops a zone, and stays a day without one", () => {
    expect(parseDateTime("2026-10-30", TODAY)).toBe("2026-10-30");
    expect(parseDateTime("2026-10-30T14:30", TODAY)).toBe("2026-10-30T14:30");
    expect(parseDateTime("2026-10-30 9:30", TODAY)).toBe("2026-10-30T09:30");
    expect(parseDateTime("2026-10-30 9.30 Uhr", TODAY)).toBe("2026-10-30T09:30");
    expect(parseDateTime("2026-10-30T09:00:00.000+02:00", TODAY)).toBe("2026-10-30T09:00");
    expect(parseDateTime("2026-10-30 14:30:15Z", TODAY)).toBe("2026-10-30T14:30");
    expect(parseDateTime("30.10.2026 9:30", TODAY)).toBe("2026-10-30T09:30");
    expect(parseDateTime("30.10.2026 14 Uhr", TODAY)).toBe("2026-10-30T14:00");
    expect(parseDateTime("10/30/2026 2:30 pm", TODAY)).toBe("2026-10-30T14:30");
    expect(parseDateTime("morgen 8:15", TODAY)).toBe("2026-11-07T08:15");
    expect(parseDateTime("30.10.2026 25:00", TODAY)).toBeUndefined();
    expect(parseDateTime("30.10. 2026", TODAY)).toBeUndefined();
  });

  test("dateText shows the time and reads back", () => {
    expect(dateText("de", "2026-10-30T14:30")).toBe("30.10.2026 14:30");
    expect(dateText("en", "2026-10-30")).toBe("10/30/2026");
    expect(parseDateTime(dateText("de", "2026-10-30T14:30"), TODAY)).toBe("2026-10-30T14:30");
  });

  test("days and due dates ignore the time; queries compare days", () => {
    expect(dayOf("2026-10-30T14:30")).toBe("2026-10-30");
    expect(timeOf("2026-10-30T14:30")).toBe("14:30");
    expect(timeOf("2026-10-30")).toBeUndefined();
    expect(dateEnd("2026-10-01T09:00/2026-10-30T17:00")).toBe("2026-10-30");
    const m = new MemRepo();
    const type = m.addType("t-task", { name: "Task", properties: [{ id: "p_due", name: "Fällig", kind: "date" }], capabilities: { due: "p_due" } });
    const x = m.add({ title: "Call", type, props: { p_due: `${TODAY}T15:00` } });
    expect(dueOf(m.get(x)!, m.index().types.get(type)!.schema)).toBe(TODAY);
    const hits = (q: string) => runQuery(q, m.index(), { today: TODAY }).items.map((i) => i.id);
    expect(hits("typ:Task fällig<=heute")).toEqual([x]);
    expect(hits("typ:Task Fällig:heute")).toEqual([x]);
  });
});

describe("free properties hold lists", () => {
  test("a multiple choice becomes a list and goes back to options by name", () => {
    const from = { id: "p", name: "Themen", kind: "select" as const, multiple: true, sort: "V", options: [{ id: "o1", name: "Kunst" }, { id: "o2", name: "Musik" }] };
    const free = toFree(from, ["o1", "o2"])!;
    expect(free).toEqual({ k: "list", v: ["Kunst", "Musik"] });
    const to = { ...from, id: "q", options: [{ id: "x2", name: "musik" }, { id: "x1", name: "Kunst" }] };
    expect(mapValue(freeDef("Themen", free), to, free.v as string[])).toEqual(["x1", "x2"]);
    expect(mapValue(freeDef("Themen", free), { id: "t", name: "Themen", kind: "text", sort: "V" }, free.v as string[])).toBe("Kunst, Musik");
  });

  test("an empty list removes it; queries look for one entry", () => {
    const m = new MemRepo();
    const x = m.add({ title: "Note", extra: { Autoren: { k: "list", v: ["Ada", "Grace"] } } });
    expect(m.get(x)!.extra.Autoren).toEqual({ k: "list", v: ["Ada", "Grace"] });
    expect(runQuery("Autoren:grace", m.index(), {}).items.map((i) => i.id)).toEqual([x]);
    expect(runQuery("Autoren:Lin", m.index(), {}).items).toEqual([]);
    expect(groupItems([m.get(x)!], "Autoren", { ix: m.index() }).map((g) => g.label)).toEqual(["Ada, Grace"]);
    m.change(x, (d) => setExtra(d, "Autoren", { k: "list", v: [] }));
    expect(m.get(x)!.extra.Autoren).toBeUndefined();
  });
});

describe("former property names", () => {
  test("a rename keeps the old name, and views that still use it find the property", () => {
    const m = new MemRepo();
    const type = m.addType("t-task", { name: "Task", properties: [{ id: "p_prio", name: "Prio", kind: "number" }] });
    m.change(type, (d) => upsertProp(d, "p_prio", { name: "Priorität" }));
    m.change(type, (d) => upsertProp(d, "p_prio", { name: "Wichtigkeit" }));
    const schema = m.get(type)!.schema!;
    expect(schema.properties[0]!.formerNames).toEqual(["Prio", "Priorität"]);
    expect(propByName(schema, "prio")?.id).toBe("p_prio");
    expect(propByName(schema, "p_prio")?.id).toBe("p_prio");
    // a sort key or filter written on a device that missed the renames
    const x = m.add({ title: "A", type, props: { p_prio: 3 } });
    expect(runQuery("typ:Task Prio>2", m.index(), {}).items.map((i) => i.id)).toEqual([x]);
  });

  test("a current name wins over another property's former name", () => {
    const m = new MemRepo();
    const type = m.addType("t", { name: "T", properties: [{ id: "a", name: "Alt", kind: "text" }, { id: "b", name: "Neu", kind: "text" }] });
    m.change(type, (d) => upsertProp(d, "a", { name: "Erst" }));
    m.change(type, (d) => upsertProp(d, "b", { name: "Alt" }));
    const schema = readSchema(m.doc(type));
    expect(propByName(schema, "Alt")?.id).toBe("b");
  });
});
