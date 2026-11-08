import type { Database } from "bun:sqlite";

/**
 * Runs the steps a database has not run yet. PRAGMA user_version counts the steps done; each step
 * and its new count commit together, so a crash leaves the database at the step before. Steps are
 * only ever appended: a server that already ran one never sees a change to it.
 */
export function migrate(db: Database, steps: string[]) {
  const done = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let i = done; i < steps.length; i++)
    db.transaction(() => {
      db.exec(steps[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
}
