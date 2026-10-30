// Daily copies of the database in data/backups, consistent while the server runs (VACUUM INTO),
// so a backup job on the host may copy the data folder at any time. File contents need no copy:
// blobs/ only gains files, each written once under its hash (only `cli.ts gc` removes any).
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store";

const NAME = /^obtion-\d{4}-\d{2}-\d{2}\.db$/;

export class Backups {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: Store,
    private dir: string,
    private keep = 7,
  ) {}

  /** Make today's copy if it is missing, then check again every hour. */
  start() {
    this.run();
    this.timer = setInterval(() => this.run(), 60 * 60 * 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Today's copy (once per day), then drop all but the newest `keep`. Returns the new file, if any. */
  run(day = new Date().toISOString().slice(0, 10)): string | undefined {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `obtion-${day}.db`);
    let made: string | undefined;
    if (!existsSync(file)) {
      // written under another name first: a backup job never sees a half-written copy
      const tmp = `${file}.tmp`;
      rmSync(tmp, { force: true });
      this.store.flush();
      this.store.db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
      renameSync(tmp, file);
      made = file;
    }
    const old = readdirSync(this.dir).filter((n) => NAME.test(n)).sort().slice(0, -this.keep);
    for (const n of old) rmSync(join(this.dir, n));
    return made;
  }
}
