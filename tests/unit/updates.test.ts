// A page's updates as one feed: its own and those below it, unread agent updates, days.
import { expect, test } from "bun:test";
import { appendUpdate } from "@orbis/core/model";
import {
	byAgent,
	byDay,
	markRead,
	NOT_READ,
	type ReadMark,
	unread,
	updateFeed,
} from "@orbis/core/updates";
import { MemRepo } from "../support/helpers";

const at = (iso: string) => new Date(iso).getTime();

function project() {
	const m = new MemRepo();
	const parent = m.add({ title: "Relaunch" });
	const child = m.add({ title: "CMS", parents: [parent] });
	m.change(parent, (d) =>
		appendUpdate(d, { at: at("2026-11-03T09:00:00"), text: "Kickoff", by: "you" }),
	);
	m.change(parent, (d) =>
		appendUpdate(d, { at: at("2026-11-04T10:00:00"), text: "Mockups", by: "agent:claude" }),
	);
	m.change(child, (d) =>
		appendUpdate(d, { at: at("2026-11-05T11:00:00"), text: "Blockiert", by: "agent:claude" }),
	);
	m.change(child, (d) =>
		appendUpdate(d, { at: at("2026-11-05T12:00:00"), text: "Altdaten", by: "import:csv" }),
	);
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

test("unread: agent updates not read on the page they were written on", () => {
	const { m, parent, child } = project();
	const feed = updateFeed(m.index(), parent);
	expect(unread(feed, () => NOT_READ).map((e) => e.u.text)).toEqual(["Blockiert", "Mockups"]);
	// read up to after the child's update: only the parent's own one is left
	const marks: Record<string, ReadMark> = { [child]: { at: at("2026-11-05T13:00:00"), ids: [] } };
	expect(unread(feed, (id) => marks[id] ?? NOT_READ).map((e) => e.u.text)).toEqual(["Mockups"]);
	marks[parent] = { at: 0, ids: [feed.find((e) => e.u.text === "Mockups")!.u.id] };
	expect(unread(feed, (id) => marks[id] ?? NOT_READ)).toEqual([]);
});

test("marking read: all of a page up to now when nothing is left, else one by one", () => {
	const m = new MemRepo();
	const page = m.add({ title: "Relaunch" });
	for (let n = 0; n < 3; n++)
		m.change(page, (d) =>
			appendUpdate(d, {
				at: at(`2026-11-0${n + 1}T10:00:00`),
				text: `Stand ${n}`,
				by: "agent:claude",
			}),
		);
	const feed = updateFeed(m.index(), page);
	const [newest, middle, oldest] = feed.map((e) => e.u.id) as [string, string, string];
	// only the newest two were on screen: they count, the oldest stays unread
	const some = markRead(feed, page, NOT_READ, new Set([newest, middle]), at("2026-11-05T10:00:00"));
	expect(some).toEqual({ at: 0, ids: [newest, middle] });
	expect(unread(feed, () => some).map((e) => e.u.id)).toEqual([oldest]);
	// later the oldest too: all read, the list of single ones is gone
	expect(markRead(feed, page, some, new Set([oldest]), at("2026-11-06T10:00:00"))).toEqual({
		at: at("2026-11-06T10:00:00"),
		ids: [],
	});
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
