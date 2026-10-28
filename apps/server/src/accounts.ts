// Accounts and workspaces of one server, in data/accounts.db.
//
// Who someone is comes from Better Auth (users, sessions, passwords); always by bearer token, never
// by cookie, so the same app can talk to several servers. What someone may see is ours: a
// workspace has members (owner or member), each workspace keeps its data in a folder of its own
// (workspaces/<id>/, see workspace.ts). Nobody needs a workspace of their own – joining one by an
// invite link is enough.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { newId } from "@obtion/core/model";

/** Who may create an account: anyone, only with an invite link, or nobody (the first account always may). */
export type SignupPolicy = "open" | "invite" | "off";

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  role: "owner" | "member";
  /** The data of the server from before accounts: devices keep their local copy of it. */
  legacy?: boolean;
}

export class AccountError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** What a server folder held before accounts: it becomes the first workspace (see migrateLegacy). */
const LEGACY_ENTRIES = ["obtion.db", "obtion.db-wal", "obtion.db-shm", "blobs", "vault", "backups", "agent"];

const hash = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");

export class Accounts {
  db: Database;
  auth: ReturnType<typeof makeAuth>;

  constructor(
    public dataDir: string,
    opts: { secret: string; baseURL: string; policy: SignupPolicy },
  ) {
    mkdirSync(join(dataDir, "workspaces"), { recursive: true });
    this.db = new Database(join(dataDir, "accounts.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.policy = opts.policy;
    this.auth = makeAuth(this.db, opts.secret, opts.baseURL);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, legacy INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS members (workspace TEXT NOT NULL, user TEXT NOT NULL, role TEXT NOT NULL, joined INTEGER NOT NULL, PRIMARY KEY (workspace, user));
      CREATE INDEX IF NOT EXISTS members_user ON members(user);
      CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, workspace TEXT NOT NULL, by TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, user TEXT NOT NULL, workspace TEXT NOT NULL, label TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admins (user TEXT PRIMARY KEY);
    `);
  }

  policy: SignupPolicy;

  /** Create Better Auth's tables (once) and turn the data of a server from before accounts into a workspace. */
  async init(legacyName: (dir: string) => string) {
    const { runMigrations } = await getMigrations(this.auth.options);
    await runMigrations();
    this.migrateLegacy(legacyName);
  }

  /**
   * A server from before accounts kept its data right in the data folder. It moves (renames, on the
   * same disk) into workspaces/<id>/ and becomes a workspace without members: the first account
   * gets it. Its store keeps its id, so devices recognise it and keep their copy.
   */
  private migrateLegacy(legacyName: (dir: string) => string) {
    if (!existsSync(join(this.dataDir, "obtion.db"))) return;
    const id = newId();
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    for (const name of LEGACY_ENTRIES) if (existsSync(join(this.dataDir, name))) renameSync(join(this.dataDir, name), join(dir, name));
    this.db.query("INSERT INTO workspaces (id, name, created, legacy) VALUES (?, ?, ?, 1)").run(id, legacyName(dir), Date.now());
    console.log(`[obtion] the data from before accounts are now the workspace ${id} (workspaces/${id})`);
  }

  /** The folder of a workspace's data. */
  dir(id: string) {
    return join(this.dataDir, "workspaces", id);
  }

  exists(id: string): boolean {
    return /^[\w-]{1,40}$/.test(id) && !!this.db.query("SELECT 1 FROM workspaces WHERE id = ?").get(id) && existsSync(this.dir(id));
  }

  // ---------- who is calling ----------

  /**
   * The user of a bearer token (an app session), or null. Cookies are never looked at: a request
   * without the token cannot be one the user meant, whatever site sent it.
   */
  async userOf(token: string | null | undefined): Promise<User | null> {
    if (!token) return null;
    const s = await this.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }).catch(() => null);
    return s ? { id: s.user.id, name: s.user.name, email: s.user.email } : null;
  }

  userCount(): number {
    return (this.db.query('SELECT count(*) AS n FROM "user"').get() as { n: number }).n;
  }

  isAdmin(user: string): boolean {
    return !!this.db.query("SELECT 1 FROM admins WHERE user = ?").get(user);
  }

  /** May this request create an account? The first one always (it becomes the admin). */
  canSignUp(invite?: string): boolean {
    if (this.userCount() === 0 || this.policy === "open") return true;
    return this.policy === "invite" && !!invite && !!this.invite(invite);
  }

  /**
   * Create an account and sign it in. With an invite it joins that workspace and gets none of
   * its own; without one it gets a personal workspace. The very first account becomes the admin and
   * takes over the data from before accounts, if there are any.
   */
  async signUp(body: { name: string; email: string; password: string; invite?: string; personal: string }): Promise<{ token: string; user: User }> {
    if (!this.canSignUp(body.invite)) throw new AccountError(body.invite ? "invite invalid" : "signup closed", 403);
    const first = this.userCount() === 0;
    const res = await this.auth.api.signUpEmail({ body: { name: body.name.trim() || body.email.split("@")[0]!, email: body.email.trim(), password: body.password } }).catch((e) => {
      throw new AccountError(e?.body?.message ?? e?.message ?? "signup failed", e?.statusCode === 422 ? 409 : 400);
    });
    const user = { id: res.user.id, name: res.user.name, email: res.user.email };
    if (first) {
      this.db.query("INSERT OR IGNORE INTO admins (user) VALUES (?)").run(user.id);
      const orphans = this.db.query("SELECT id FROM workspaces WHERE id NOT IN (SELECT workspace FROM members)").all() as { id: string }[];
      for (const w of orphans) this.addMember(w.id, user.id, "owner");
    }
    if (body.invite) this.join(body.invite, user.id);
    else if (!this.workspacesOf(user.id).length) this.createWorkspace(user.id, body.personal);
    return { token: res.token!, user };
  }

  async signOut(token: string) {
    const ctx = await this.auth.$context;
    await ctx.internalAdapter.deleteSession(token);
  }

  // ---------- workspaces ----------

  workspacesOf(user: string): WorkspaceInfo[] {
    const rows = this.db.query("SELECT w.id, w.name, w.legacy, m.role FROM members m JOIN workspaces w ON w.id = m.workspace WHERE m.user = ? ORDER BY m.joined").all(user) as { id: string; name: string; legacy: number; role: WorkspaceInfo["role"] }[];
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, ...(r.legacy ? { legacy: true } : {}) }));
  }

  role(workspace: string, user: string): WorkspaceInfo["role"] | undefined {
    return (this.db.query("SELECT role FROM members WHERE workspace = ? AND user = ?").get(workspace, user) as { role: WorkspaceInfo["role"] } | null)?.role;
  }

  createWorkspace(user: string, name: string): WorkspaceInfo {
    const id = newId();
    mkdirSync(this.dir(id), { recursive: true });
    this.db.query("INSERT INTO workspaces (id, name, created) VALUES (?, ?, ?)").run(id, name.trim().slice(0, 80) || "Workspace", Date.now());
    this.addMember(id, user, "owner");
    return { id, name, role: "owner" };
  }

  rename(workspace: string, user: string, name: string) {
    if (this.role(workspace, user) !== "owner") throw new AccountError("only owners rename", 403);
    if (!name.trim()) throw new AccountError("name required");
    this.db.query("UPDATE workspaces SET name = ? WHERE id = ?").run(name.trim().slice(0, 80), workspace);
  }

  /** An owner deletes a workspace: for everyone, with its folder (data, files, backups). Close it first. */
  deleteWorkspace(workspace: string, by: string) {
    if (this.role(workspace, by) !== "owner") throw new AccountError("only owners delete", 403);
    for (const table of ["members", "invites", "tokens"]) this.db.query(`DELETE FROM ${table} WHERE workspace = ?`).run(workspace);
    this.db.query("DELETE FROM workspaces WHERE id = ?").run(workspace);
    rmSync(this.dir(workspace), { recursive: true, force: true });
  }

  private addMember(workspace: string, user: string, role: WorkspaceInfo["role"]) {
    this.db.query("INSERT OR IGNORE INTO members (workspace, user, role, joined) VALUES (?, ?, ?, ?)").run(workspace, user, role, Date.now());
  }

  members(workspace: string): { id: string; name: string; email: string; role: string }[] {
    return this.db.query('SELECT u.id, u.name, u.email, m.role FROM members m JOIN "user" u ON u.id = m.user WHERE m.workspace = ? ORDER BY m.joined').all(workspace) as any[];
  }

  /**
   * Leave a workspace, or (an owner) remove someone. The last owner cannot go: the workspace
   * would belong to nobody.
   */
  removeMember(workspace: string, by: string, user: string) {
    const byRole = this.role(workspace, by);
    if (!byRole || (by !== user && byRole !== "owner")) throw new AccountError("not allowed", 403);
    const owners = this.members(workspace).filter((m) => m.role === "owner");
    if (owners.length === 1 && owners[0]!.id === user) throw new AccountError("last owner", 409);
    this.db.query("DELETE FROM members WHERE workspace = ? AND user = ?").run(workspace, user);
    this.db.query("DELETE FROM tokens WHERE workspace = ? AND user = ?").run(workspace, user);
  }

  // ---------- invites ----------

  /** An invite link's code: anyone with it may join for 14 days. */
  createInvite(workspace: string, by: string): string {
    if (!this.role(workspace, by)) throw new AccountError("not a member", 403);
    const code = randomToken();
    this.db.query("INSERT INTO invites (code, workspace, by, created, expires) VALUES (?, ?, ?, ?, ?)").run(code, workspace, by, Date.now(), Date.now() + 14 * 86400_000);
    return code;
  }

  invite(code: string): { workspace: string; name: string; by: string } | undefined {
    const row = this.db.query('SELECT i.workspace, w.name, u.name AS by FROM invites i JOIN workspaces w ON w.id = i.workspace LEFT JOIN "user" u ON u.id = i.by WHERE i.code = ? AND i.expires > ?').get(code, Date.now()) as { workspace: string; name: string; by: string } | null;
    return row ?? undefined;
  }

  join(code: string, user: string): WorkspaceInfo {
    const inv = this.invite(code);
    if (!inv) throw new AccountError("invite invalid", 404);
    this.addMember(inv.workspace, user, "member");
    return this.workspacesOf(user).find((w) => w.id === inv.workspace)!;
  }

  // ---------- MCP tokens ----------

  /** A token for agents (Claude Code, Claude Desktop) on one workspace, as this user. Shown once. */
  mcpToken(workspace: string, user: string, label = "mcp"): string {
    if (!this.role(workspace, user)) throw new AccountError("not a member", 403);
    const token = "obt_" + randomToken();
    this.db.query("INSERT INTO tokens (hash, user, workspace, label, created) VALUES (?, ?, ?, ?, ?)").run(hash(token), user, workspace, label, Date.now());
    return token;
  }

  /** The user an MCP token stands for on this workspace (and is still a member), or undefined. */
  mcpUser(workspace: string, token: string): User | undefined {
    const row = this.db.query('SELECT u.id, u.name, u.email FROM tokens t JOIN "user" u ON u.id = t.user JOIN members m ON m.workspace = t.workspace AND m.user = t.user WHERE t.hash = ? AND t.workspace = ?').get(hash(token), workspace) as User | null;
    return row ?? undefined;
  }
}

function makeAuth(db: Database, secret: string, baseURL: string) {
  return betterAuth({
    database: db,
    secret,
    baseURL,
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    // an app stays signed in like a mail app; every use within a day moves the end
    session: { expiresIn: 60 * 60 * 24 * 365, updateAge: 60 * 60 * 24 },
    // the app's own page calls /api/auth/*; the server checks the origin itself (index.ts)
    trustedOrigins: (req) => [req?.headers.get("origin") ?? undefined].filter((o): o is string => !!o),
    plugins: [bearer()],
    // also outside NODE_ENV=production: a hosted server must not let anyone guess passwords
    rateLimit: { enabled: true },
    telemetry: { enabled: false },
  });
}

/** For the CLI and tests: the workspace folders that exist. */
export function workspaceDirs(dataDir: string): string[] {
  const root = join(dataDir, "workspaces");
  return existsSync(root) ? readdirSync(root).map((n) => join(root, n)) : [];
}
