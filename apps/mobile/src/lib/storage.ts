// A workspace's replica on the phone: one SQLite database, the same three stores as the browser's
// IndexedDB (packages/ui/src/browser.ts): Yjs updates, the outbox and the sync cursor.

import type { OutItem, ReplicaStorage, StoredRow } from "@obtion/sync";
import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS updates (k INTEGER PRIMARY KEY AUTOINCREMENT, d TEXT NOT NULL, u BLOB NOT NULL, r TEXT);
CREATE INDEX IF NOT EXISTS updates_doc ON updates (d);
CREATE TABLE IF NOT EXISTS outbox (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export const databaseName = (space: string) => `obtion-ws-${space}.db`;

export type Storage = ReplicaStorage & {
	/** Closes the database after what is queued; later calls fail. */
	close(): Promise<void>;
};

export function sqliteStorage(space: string): Storage {
	const name = databaseName(space);
	let db: SQLiteDatabase | null = null;
	// One connection, one operation at a time: a transaction never interleaves with another write.
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: (db: SQLiteDatabase) => Promise<T>): Promise<T> => {
		const run = queue.then(() => {
			if (!db) throw new Error(`${name} is closed`);
			return fn(db);
		});
		queue = run.catch(() => undefined);
		return run;
	};
	const transaction = (fn: (db: SQLiteDatabase) => Promise<void>) =>
		serial(async (d) => {
			await d.execAsync("BEGIN");
			try {
				await fn(d);
				await d.execAsync("COMMIT");
			} catch (e) {
				await d.execAsync("ROLLBACK");
				throw e;
			}
		});
	const meta = async (d: SQLiteDatabase, k: string) =>
		(await d.getFirstAsync<{ v: string }>("SELECT v FROM meta WHERE k = ?", k))?.v;

	return {
		async open() {
			db = await openDatabaseAsync(name);
			await db.execAsync(SCHEMA);
		},
		load: () =>
			serial(async (d) => {
				const rows = await d.getAllAsync<{ k: number; d: string; u: Uint8Array; r: string | null }>(
					"SELECT k, d, u, r FROM updates ORDER BY k",
				);
				const outbox = await d.getAllAsync<{ v: string }>("SELECT v FROM outbox ORDER BY k");
				const lastSeq = await meta(d, "lastSeq");
				return {
					rows: rows.map(
						(row): StoredRow => ({
							key: row.k,
							d: row.d,
							u: row.u,
							r: row.r ? (JSON.parse(row.r) as StoredRow["r"]) : undefined,
						}),
					),
					outbox: outbox.map((o) => JSON.parse(o.v) as OutItem),
					lastSeq: lastSeq === undefined ? undefined : Number(lastSeq),
					lastId: await meta(d, "lastId"),
				};
			}),
		compact: (docs) =>
			transaction(async (d) => {
				const remove = await d.prepareAsync("DELETE FROM updates WHERE k = ?");
				const add = await d.prepareAsync("INSERT INTO updates (d, u, r) VALUES (?, ?, ?)");
				try {
					for (const { keys, row } of docs) {
						for (const k of keys) await remove.executeAsync(k as number);
						await add.executeAsync(row.d, row.u, row.r ? JSON.stringify(row.r) : null);
					}
				} finally {
					await remove.finalizeAsync();
					await add.finalizeAsync();
				}
			}),
		write: (w) =>
			transaction(async (d) => {
				if (w.rows?.length) {
					const add = await d.prepareAsync("INSERT INTO updates (d, u) VALUES (?, ?)");
					try {
						for (const r of w.rows) await add.executeAsync(r.d, r.u);
					} finally {
						await add.finalizeAsync();
					}
				}
				// puts before deletes (ReplicaStorage.write)
				for (const o of w.outbox ?? [])
					await d.runAsync(
						"INSERT OR REPLACE INTO outbox (k, v) VALUES (?, ?)",
						o.k,
						JSON.stringify(o),
					);
				for (const k of w.acked ?? []) await d.runAsync("DELETE FROM outbox WHERE k = ?", k);
				if (w.cursor) {
					await d.runAsync(
						"INSERT OR REPLACE INTO meta (k, v) VALUES ('lastSeq', ?)",
						String(w.cursor.lastSeq),
					);
					if (w.cursor.lastId)
						await d.runAsync(
							"INSERT OR REPLACE INTO meta (k, v) VALUES ('lastId', ?)",
							w.cursor.lastId,
						);
					else await d.runAsync("DELETE FROM meta WHERE k = 'lastId'");
				}
				if (w.serverId)
					await d.runAsync("INSERT OR REPLACE INTO meta (k, v) VALUES ('serverId', ?)", w.serverId);
			}),
		outbox: () =>
			serial(async (d) =>
				(await d.getAllAsync<{ v: string }>("SELECT v FROM outbox ORDER BY k")).map(
					(o) => JSON.parse(o.v) as OutItem,
				),
			),
		drop: (ids) =>
			transaction(async (d) => {
				for (const id of ids) await d.runAsync("DELETE FROM updates WHERE d = ?", id);
				const gone = new Set(ids);
				for (const o of await d.getAllAsync<{ k: string; v: string }>("SELECT k, v FROM outbox"))
					if (gone.has((JSON.parse(o.v) as OutItem).d))
						await d.runAsync("DELETE FROM outbox WHERE k = ?", o.k);
			}),
		serverId: () => serial((d) => meta(d, "serverId")),
		async destroy() {
			await queue;
			await db?.closeAsync();
			db = null;
			await deleteDatabaseAsync(name);
		},
		async close() {
			await queue;
			const d = db;
			db = null;
			await d?.closeAsync();
		},
	};
}

/** Deletes a workspace's replica that is not open (signing out, a workspace gone on the server). */
export async function removeReplica(space: string) {
	await deleteDatabaseAsync(databaseName(space)).catch(() => {
		// never opened on this device
	});
}
