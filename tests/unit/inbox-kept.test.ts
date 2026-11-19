// The inbox as a workspace: an entry kept there stays with its type, place and pin until it is
// checked off or done; sorting one that lies there by the rule alone keeps it too.
import { describe, expect, test } from "bun:test";
import { inboxSince } from "@orbis/core/inbox";
import { setMeta, setProp } from "@orbis/core/model";
import { canCheckOff, inbox, isInInbox, keepInInbox, laterItems } from "@orbis/core/placement";
import { parseQuery, runQuery } from "@orbis/core/query";
import { runSetup, SYS } from "@orbis/core/setup";
import { type ReplicaStorage, Repo } from "@orbis/sync";
import { MemRepo } from "../support/helpers";

const titles = (m: MemRepo) =>
	inbox(m.index())
		.map((i) => i.title)
		.sort();

describe("kept in the inbox", () => {
	test("stays with a type, a place and a pin; checked off it leaves", () => {
		const m = new MemRepo();
		runSetup(m.writer, "de");
		const project = m.add({ title: "Relaunch", type: SYS.project, pinned: "a0" });
		const todo = m.add({ title: "Call Lena", type: SYS.task, parents: [project], inbox: 1000 });
		const note = m.add({ title: "Thought", inbox: 2000 });
		m.change(note, (d) => setMeta(d, { pinned: "a1" }));
		expect(titles(m)).toEqual(["Call Lena", "Thought"]);
		const ix = m.index();
		expect(runQuery(parseQuery("eingang typ:Task", ix).def, { ix }).items.length).toBe(1);
		expect(inboxSince(ix.get(todo)!)).toBe(1000);
		m.change(todo, (d) => setMeta(d, { inbox: null }));
		expect(titles(m)).toEqual(["Thought"]);
	});

	test("a done status takes it out; reopened, it is back", () => {
		const m = new MemRepo();
		runSetup(m.writer, "de");
		const todo = m.add({ title: "Send offer", type: SYS.task, inbox: Date.now() });
		expect(titles(m)).toEqual(["Send offer"]);
		m.change(todo, (d) => setProp(d, "p_status", "st_done"));
		expect(titles(m)).toEqual([]);
		m.change(todo, (d) => setProp(d, "p_status", "st_todo"));
		expect(titles(m)).toEqual(["Send offer"]);
	});

	test('"Back tomorrow" still sets it aside until then', () => {
		const m = new MemRepo();
		runSetup(m.writer, "de");
		const id = m.add({ title: "Later", type: SYS.task, inbox: 1 });
		m.change(id, (d) => setMeta(d, { later: Date.now() + 60_000 }));
		expect(titles(m)).toEqual([]);
		expect(laterItems(m.index()).map((i) => i.title)).toEqual(["Later"]);
	});

	test("only an entry with a type or a place can be checked off", () => {
		const m = new MemRepo();
		runSetup(m.writer, "de");
		const project = m.add({ title: "Relaunch", type: SYS.project });
		const loose = m.add({ title: "Loose", inbox: 1 });
		const typed = m.add({ title: "Typed", type: SYS.card, inbox: 1 });
		const placed = m.add({ title: "Placed", parents: [project], inbox: 1 });
		const byRule = m.add({ title: "By the rule" });
		const ix = m.index();
		expect(canCheckOff(ix.get(loose)!, ix)).toBe(false);
		expect(canCheckOff(ix.get(typed)!, ix)).toBe(true);
		expect(canCheckOff(ix.get(placed)!, ix)).toBe(true);
		expect(canCheckOff(ix.get(byRule)!, ix)).toBe(false);
	});

	test("sorting an entry there by the rule keeps it, since it was made; one outside stays outside", () => {
		const m = new MemRepo();
		runSetup(m.writer, "de");
		const idea = m.add({ title: "Idea", created: 5000 });
		const task = m.add({ title: "Task", type: SYS.task });
		let ix = m.index();
		m.change(idea, (d) => {
			keepInInbox(d, ix.get(idea), ix);
			setMeta(d, { type: SYS.card });
		});
		m.change(task, (d) => keepInInbox(d, ix.get(task), ix));
		ix = m.index();
		expect(ix.get(idea)!.inbox).toBe(5000);
		expect(isInInbox(ix.get(idea)!, ix)).toBe(true);
		expect(ix.get(task)!.inbox).toBeUndefined();
	});
});

const done = () => Promise.resolve();
const noop = () => undefined;
const storage: ReplicaStorage = {
	open: done,
	load: async () => ({ rows: [], outbox: [] }),
	compact: done,
	write: done,
	outbox: async () => [],
	drop: done,
	serverId: async () => undefined,
	destroy: done,
};

async function device() {
	const repo = new Repo({
		storage,
		device: "test",
		connect: () => ({
			readyState: 0,
			send: noop,
			close: noop,
			onopen: null,
			onmessage: null,
			onclose: null,
			onerror: null,
		}),
		post: async () => null,
		askOtherServer: async () => null,
		confirmDiscard: async () => false,
		tooNew: noop,
		reload: noop,
	});
	await repo.init();
	runSetup(repo.writer, "de", repo.origin);
	return repo;
}

/** The records follow their documents a microtask later. */
const settled = () => new Promise((r) => setTimeout(r));

describe("on a device", () => {
	test("a type, a place or a pin keeps an inbox entry there; the same outside the inbox adds none", async () => {
		const repo = await device();
		const project = repo.create({ title: "Relaunch", type: SYS.project, parents: [] });
		const typed = repo.create({ title: "Typed", type: null, parents: [] });
		const placed = repo.create({ title: "Placed", type: null, parents: [] });
		const pinned = repo.create({ title: "Pinned", type: null, parents: [] });
		await settled();
		repo.setType(typed, SYS.task);
		repo.addParent(placed, project);
		repo.pin(pinned, true);
		repo.addParent(project, placed);
		await settled();
		const ix = repo.index();
		for (const id of [typed, placed, pinned]) expect(isInInbox(ix.get(id)!, ix)).toBe(true);
		expect(ix.get(project)!.inbox).toBeUndefined();
		repo.setInbox(typed, false);
		await settled();
		expect(isInInbox(repo.get(typed)!, repo.index())).toBe(false);
		repo.setInbox(project, true);
		await settled();
		expect(isInInbox(repo.get(project)!, repo.index())).toBe(true);
	});
});
