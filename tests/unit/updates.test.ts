// A page's updates as one feed: its own and those below it, unread agent updates, days.
import { test, expect } from "bun:test";
import { MemRepo } from "../support/helpers";
import { appendUpdate } from "@obtion/core/model";
import { byAgent, byDay, unread, updateFeed } from "@obtion/core/updates";

const at = (iso: string) => new Date(iso).getTime();

function project() {
  const m = new MemRepo();
  const parent = m.add({ title: "Relaunch" });
  const child = m.add({ title: "CMS", parents: [parent] });
  m.change(parent, (d) => appendUpdate(d, { at: at("2026-11-03T09:00:00"), text: "Kickoff", by: "you" }));
  m.change(parent, (d) => appendUpdate(d, { at: at("2026-11-04T10:00:00"), text: "Mockups", by: "agent:claude" }));
  m.change(child, (d) => appendUpdate(d, { at: at("2026-11-05T11:00:00"), text: "Blockiert", by: "agent:claude" }));
  m.change(child, (d) => appendUpdate(d, { at: at("2026-11-05T12:00:00"), text: "Altdaten", by: "import:csv" }));
  return { m, parent, child };
}

test("the feed holds the updates below the page, newest first", () => {
  const { m, parent, child } = project();
  const feed = updateFeed(m.index(), parent);
  expect(feed.map((e) => e.u.text)).toEqual(["Altdaten", "Blockiert", "Mockups", "Kickoff"]);
  expect(feed[1]!.from.id).toBe(child);
  expect(updateFeed(m.index(), child).map((e) => e.u.text)).toEqual(["Altdaten", "Blockiert"]);
});

test("only agents count as agents, not people or imports", () => {
  expect(byAgent("you")).toBe(false);
  expect(byAgent("import:csv")).toBe(false);
  expect(byAgent("agent:claude")).toBe(true);
});

test("unread: agent updates newer than the last look at the page they were written on", () => {
  const { m, parent, child } = project();
  const feed = updateFeed(m.index(), parent);
  expect(unread(feed, () => 0).map((e) => e.u.text)).toEqual(["Blockiert", "Mockups"]);
  // looked at the child page after its update: only the parent's own one is left
  const seen: Record<string, number> = { [child]: at("2026-11-05T13:00:00") };
  expect(unread(feed, (id) => seen[id] ?? 0).map((e) => e.u.text)).toEqual(["Mockups"]);
  seen[parent] = at("2026-11-04T10:00:00");
  expect(unread(feed, (id) => seen[id] ?? 0)).toEqual([]);
});

test("days keep the feed's order", () => {
  const { m, parent } = project();
  const days = byDay(updateFeed(m.index(), parent));
  expect(days.map(([day, list]) => [day, list.length])).toEqual([
    ["2026-11-05", 2],
    ["2026-11-04", 1],
    ["2026-11-03", 1],
  ]);
});
