import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "@orbis/server/migrate";

const version = (db: Database) =>
	(db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const columns = (db: Database) =>
	(db.query("SELECT name FROM pragma_table_info('t')").all() as { name: string }[]).map(
		(c) => c.name,
	);

test("a new database runs every step, an old one only the steps it misses", () => {
	const db = new Database(":memory:");
	migrate(db, ["CREATE TABLE t (a)"]);
	db.exec("INSERT INTO t VALUES (1)");
	migrate(db, ["CREATE TABLE t (a)", "ALTER TABLE t ADD b DEFAULT 2"]);
	migrate(db, ["CREATE TABLE t (a)", "ALTER TABLE t ADD b DEFAULT 2"]);
	expect(version(db)).toBe(2);
	expect(db.query("SELECT a, b FROM t").all()).toEqual([{ a: 1, b: 2 }]);
});

test("a failing step leaves the database at the step before", () => {
	const db = new Database(":memory:");
	expect(() => migrate(db, ["CREATE TABLE t (a)", "ALTER TABLE t ADD b; nonsense"])).toThrow();
	expect(version(db)).toBe(1);
	expect(columns(db)).toEqual(["a"]);
});
