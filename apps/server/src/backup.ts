// Daily VACUUM INTO copies of a database (a workspace's and the accounts), so a host backup job
// may copy the data folder while the server runs. blobs/ needs no copy: files are written once
// under their hash and only `cli.ts gc` removes any.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const CHECK_EVERY_MS = 60 * 60 * 1000;

export class Backups {
  private timer: ReturnType<typeof setInterval> | null = null;
  private file: RegExp;

  /** Copies are named `<name>-<day>.db`; `flush` runs before each, so the copy has what is pending. */
  constructor(
    private source: { db: Database; flush?(): void },
    private dir: string,
    private keep = 7,
    private name = "obtion",
  ) {
    this.file = new RegExp(`^${name}-\\d{4}-\\d{2}-\\d{2}\\.db$`);
  }

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
    const file = join(this.dir, `${this.name}-${day}.db`);
    const made = existsSync(file) ? undefined : this.snapshot(file);
    this.prune();
    return made;
  }

  private snapshot(file: string): string {
    // temp name first, so a backup job never sees a half-written copy
    const tmp = `${file}.tmp`;
    rmSync(tmp, { force: true });
    this.source.flush?.();
    this.source.db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    renameSync(tmp, file);
    return file;
  }

  private prune() {
    const old = readdirSync(this.dir).filter((name) => this.file.test(name)).sort().slice(0, -this.keep);
    for (const name of old) rmSync(join(this.dir, name));
  }
}
