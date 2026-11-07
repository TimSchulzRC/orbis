// Daily VACUUM INTO copies, so a host backup job may copy the data folder while the server runs.
// blobs/ needs no copy: files are written once under their hash and only `cli.ts gc` removes any.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store";

const CHECK_EVERY_MS = 60 * 60 * 1000;
const BACKUP_FILE = /^obtion-\d{4}-\d{2}-\d{2}\.db$/;

export class Backups {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private store: Store,
    private dir: string,
    private keep = 7,
  ) {}

  start() {
    this.run();
    this.timer = setInterval(() => this.run(), CHECK_EVERY_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns the new file, if one was made. */
  run(day = new Date().toISOString().slice(0, 10)): string | undefined {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `obtion-${day}.db`);
    this.store.thin(); // hourly, like this check: bounds versions and activity before the copy
    const made = existsSync(file) ? undefined : this.snapshot(file);
    this.prune();
    return made;
  }

  private snapshot(file: string): string {
    // temp name first, so a backup job never sees a half-written copy
    const tmp = `${file}.tmp`;
    rmSync(tmp, { force: true });
    this.store.flush();
    this.store.db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    renameSync(tmp, file);
    return file;
  }

  private prune() {
    const old = readdirSync(this.dir).filter((name) => BACKUP_FILE.test(name)).sort().slice(0, -this.keep);
    for (const name of old) rmSync(join(this.dir, name));
  }
}
