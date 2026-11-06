// Schema versions of the server's SQLite databases. `PRAGMA user_version` holds how many steps a
// database has run; a later schema change appends a step, never edits one that shipped.
import type { Database } from "bun:sqlite";

export function migrate(db: Database, steps: string[]) {
  const { user_version: at } = db.query("PRAGMA user_version").get() as { user_version: number };
  if (at > steps.length) throw new Error(`${db.filename} has schema version ${at}, this server knows up to ${steps.length}. Update the server.`);
  if (at === steps.length) return;
  db.transaction(() => {
    for (const step of steps.slice(at)) db.exec(step);
    db.exec(`PRAGMA user_version = ${steps.length}`);
  })();
}
