// Startup benchmark on a generated workspace: items with long edit histories, made the way
// devices make them (each session a new Yjs client, every edit a pushed update).
//   bun scripts/bench-startup.ts gen <dir> [items] [sessions] [edits]
//   bun scripts/bench-startup.ts store <dir>    time and memory of opening the store alone
//   bun scripts/bench-startup.ts server <dir>   the same for the whole workspace (store, files, mirror)
//   bun scripts/bench-startup.ts device <dir>   the same data loaded by a device's Repo (the first run prepares its rows)

import { deserialize, serialize } from "bun:jsc";
import { initItem, metaMap } from "@obtion/core/model";
import { type ReplicaStorage, Repo, type StoredRow } from "@obtion/sync";
import * as Y from "yjs";
import { Store } from "../apps/server/src/store";
import { Workspace } from "../apps/server/src/workspace";

const [mode, dir, ...rest] = process.argv.slice(2);
if (!mode || !dir)
	throw new Error(
		"usage: bench-startup.ts gen|store|server|device <dir> [items] [sessions] [edits]",
	);

const WORDS =
	"the of and to in is was for on that with as by at from this be have are not but".split(" ");
let seed = 1;
const rnd = (n: number) => {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % n;
};

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
function memory(): string {
	Bun.gc(true);
	const u = process.memoryUsage();
	return `rss ${mb(u.rss)}, heap ${mb(u.heapUsed)}`;
}

if (mode === "gen") {
	const [items = 3000, sessions = 20, edits = 15] = rest.map(Number);
	const store = new Store(dir);
	const t0 = performance.now();
	for (let i = 0; i < items; i++) {
		const id = `bench${i.toString().padStart(6, "0")}`;
		let state: Uint8Array | null = null;
		store.db.exec("BEGIN"); // generation only: one transaction per item instead of one per update
		for (let s = 0; s < sessions; s++) {
			const doc = new Y.Doc({ gc: true }); // a new client id per session, as a browser gets one per load
			if (state) Y.applyUpdate(doc, state);
			doc.on("update", (u: Uint8Array) => store.applyRemote(id, u, "web:bench"));
			if (!state) doc.transact(() => initItem(doc, { title: `Item ${i}`, body: "Start. " }));
			const text = doc.getText("body");
			for (let e = 0; e < edits; e++) {
				doc.transact(() => {
					const r = rnd(10);
					if (r < 7) text.insert(rnd(text.length + 1), `${WORDS[rnd(WORDS.length)]!} `);
					else if (r < 9 && text.length > 20) text.delete(rnd(text.length - 10), 1 + rnd(8));
					else metaMap(doc).set("title", `Item ${i} v${s}.${e}`);
					metaMap(doc).set("updated", Date.now());
				});
			}
			state = Y.encodeStateAsUpdate(doc);
			doc.destroy();
		}
		store.db.exec("COMMIT");
		store.flush();
		store.trim();
		if (i % 500 === 499)
			console.log(`${i + 1} items, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
	}
	store.flush();
	const rows = store.db
		.query("SELECT count(*) AS n, sum(length(data)) AS b FROM updates")
		.get() as { n: number; b: number };
	const snaps = store.db.query("SELECT sum(length(state)) AS b FROM docstate").get() as {
		b: number;
	};
	console.log(`${items} items, ${rows.n} log rows (${mb(rows.b)}), snapshots ${mb(snaps.b)}`);
	store.db.close();
} else if (mode === "store" || mode === "server") {
	const before = memory();
	const t0 = performance.now();
	const open = mode === "store" ? new Store(dir) : new Workspace(dir);
	const ms = performance.now() - t0;
	const store = open instanceof Store ? open : open.store;
	console.log(
		`${mode} ${ms.toFixed(0)} ms, ${store.records.size} records, ${store.loaded.size} docs in memory; before ${before}; after ${memory()}`,
	);
	if (open instanceof Workspace) open.shut();
	else open.db.close();
} else if (mode === "device") {
	// a device's stored rows, prepared once (compacted, as after the first start) in device.rows
	const file = `${dir}/device.rows`;
	let rows: StoredRow[];
	const prepare = !(await Bun.file(file).exists());
	if (prepare) {
		const src = new Store(dir);
		const ids = src.db.query("SELECT id FROM docstate").all() as { id: string }[];
		rows = ids.map(({ id }, i) => ({ key: i, d: id, u: src.stateOf(id) }));
		src.db.close();
	} else rows = deserialize(await Bun.file(file).arrayBuffer()) as StoredRow[];
	const storage: ReplicaStorage = {
		open: async () => {},
		load: async () => ({ rows, outbox: [] }),
		compact: async (docs) => {
			const gone = new Set(docs.flatMap((d) => d.keys));
			rows = [
				...rows.filter((r) => !gone.has(r.key)),
				...docs.map((d, i) => ({ ...d.row, key: `c${i}` })),
			];
		},
		write: async () => {},
		outbox: async () => [],
		drop: async () => {},
		serverId: async () => undefined,
		destroy: async () => {},
	};
	const before = memory();
	const t0 = performance.now();
	const repo = new Repo({
		storage,
		device: "bench",
		connect: () => ({
			readyState: 0,
			send() {},
			close() {},
			onopen: null,
			onmessage: null,
			onclose: null,
			onerror: null,
		}),
		post: async () => null,
		askOtherServer: async () => null,
		confirmDiscard: async () => false,
		tooNew() {},
		reload() {},
	});
	await repo.init();
	const ms = performance.now() - t0;
	console.log(
		`device ${ms.toFixed(0)} ms, ${repo.records.size} records, ${repo.docs.size} docs decoded; before ${before}; after ${memory()}`,
	);
	if (prepare) {
		await Bun.sleep(10); // compaction
		await Bun.write(file, serialize(rows));
	}
	process.exit(0);
}
