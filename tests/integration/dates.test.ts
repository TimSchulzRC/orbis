// Dates with a time through the agent operations.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { removeTempDirs } from "../support/helpers";
import { setupStore } from "../support/store";
import type { Ops } from "@obtion/server/ops";

afterAll(removeTempDirs);

let ops: Ops;
const A = "agent:test";
// set up in German: the due property is "Fällig"
beforeEach(() => ({ ops } = setupStore("obtion-dates-")));

test("a date property keeps its time", () => {
  const x = ops.create({ title: "Call", type: "Task", properties: { Fällig: "2026-10-30T09:00:00.000+02:00" } }, A);
  const due = Object.values(x.props).find((v) => typeof v === "string" && v.startsWith("2026-10-30"));
  expect(due).toBe("2026-10-30T09:00");
  expect(ops.line(x)).toContain("due 2026-10-30");
});
