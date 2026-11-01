// Accounts and workspaces of one server, in data/accounts.db.
//
// Who someone is comes from Better Auth (users, sessions, passwords, codes by email, passkeys,
// OAuth; see login.ts); always by bearer token, never by cookie, so the same app can talk to
// several servers. Only an OAuth sign-in ends with a cookie, which the app trades for a token once
// (claim). What someone may see is ours: a
// workspace has members (owner or member), each workspace keeps its data in a folder of its own
// (workspaces/<id>/, see workspace.ts). Nobody needs a workspace of their own – joining one by an
// invite link is enough.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer, emailOTP, genericOAuth } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { getMigrations } from "better-auth/db/migration";
import { newId } from "@obtion/core/model";
import type { InviteLink, Member, Role, SignedIn, SignupPolicy, User, WorkspaceInfo } from "@obtion/core/api";
import { sha256 } from "./blobs";
import type { LoginConfig } from "./login";

/** How long after signing in someone may add a passkey or delete the account without a password. */
export const FRESH_SECONDS = 10 * 60;

/**
 * What a new account comes with, set by the page before it signs up (by code or OAuth, where the
 * request is Better Auth's own): the invite it joins with, the app's language. A cookie, so that it
 * also reaches the OAuth callback.
 */
export const SIGNUP_COOKIE = "obtion_signup";
interface SignupContext {
  invite?: string;
  /** the language of the email with the code */
  lang?: string;
}

function signupContext(headers: Headers | undefined): SignupContext {
  const raw = headers?.get("cookie")?.split(";").map((c) => c.trim()).find((c) => c.startsWith(SIGNUP_COOKIE + "="));
  if (!raw) return {};
  try {
    const v = JSON.parse(decodeURIComponent(raw.slice(SIGNUP_COOKIE.length + 1))) as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === "string" && x.length < 200 ? x : undefined);
    return { invite: str(v.invite), lang: str(v.lang) };
  } catch {
    return {};
  }
}

const signupHeaders = (c: SignupContext) => new Headers({ cookie: `${SIGNUP_COOKIE}=${encodeURIComponent(JSON.stringify(c))}` });

/** A workspace name as stored: trimmed, at most 80 characters. */
const workspaceName = (name: string) => name.trim().slice(0, 80);

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

/** How long an invite link works. */
const INVITE_DAYS = 14;

export const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");

export class Accounts {
  db: Database;
  auth: ReturnType<typeof makeAuth>;

  constructor(
    public dataDir: string,
    opts: { secret: string; baseURL: string; policy: SignupPolicy; login?: LoginConfig; onRevoke?: (user: string) => void },
  ) {
    mkdirSync(join(dataDir, "workspaces"), { recursive: true });
    this.db = new Database(join(dataDir, "accounts.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.policy = opts.policy;
    this.login = opts.login ?? { password: true, oauth: [] };
    this.onRevoke = opts.onRevoke ?? (() => {});
    this.auth = makeAuth(this, opts.secret, opts.baseURL);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, legacy INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS members (workspace TEXT NOT NULL, user TEXT NOT NULL, role TEXT NOT NULL, joined INTEGER NOT NULL, PRIMARY KEY (workspace, user));
      CREATE INDEX IF NOT EXISTS members_user ON members(user);
      CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, workspace TEXT NOT NULL, by TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member', once INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, user TEXT NOT NULL, workspace TEXT NOT NULL, label TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admins (user TEXT PRIMARY KEY);
    `);
    // links from before roles on links: for members, as often as wanted (as they worked)
    const cols = (this.db.query("PRAGMA table_info(invites)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("role")) this.db.exec("ALTER TABLE invites ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
    if (!cols.includes("once")) this.db.exec("ALTER TABLE invites ADD COLUMN once INTEGER NOT NULL DEFAULT 0");
  }

  policy: SignupPolicy;
  login: LoginConfig;
  /**
   * Single-use links a signup is making an account for right now (code → for which address, since
   * when): until that account has joined, nobody else gets in with the same link. Turned away before
   * Better Auth starts: it shares this connection, and a signup failing inside its transaction would
   * roll back the other one's joining too. Stale after a minute, should that account never come.
   */
  private claims = new Map<string, { email: string; since: number }>();

  /** A user's access was taken back (their address proven by someone else): close what is open. */
  onRevoke: (user: string) => void;

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

  /** The first account is marked as the admin; no right depends on it (yet). */
  isAdmin(user: string): boolean {
    return !!this.db.query("SELECT 1 FROM admins WHERE user = ?").get(user);
  }

  /** May this request create an account? The first one always (it becomes the admin). */
  canSignUp(invite?: string, email?: string): boolean {
    if (this.userCount() === 0 || this.policy === "open") return true;
    return this.policy === "invite" && !!invite && !!this.invite(invite) && !this.claimedByOther(invite, email);
  }

  /** Before Better Auth creates a user (any way: password, code, OAuth): may this request? */
  allowNewUser(email: string, headers: Headers | undefined) {
    const c = signupContext(headers);
    // the code sends an OAuth sign-in back to the page (?signin=failed&error=signup_closed)
    if (!this.canSignUp(c.invite, email)) throw new APIError("FORBIDDEN", c.invite ? { message: "invite invalid", code: "invite_invalid" } : { message: "signup closed", code: "signup_closed" });
    // (OAuth and codes come here directly; a password signup has claimed it already)
    if (c.invite) this.hold(c.invite, email);
  }

  /** Who is signing up with this single-use link right now (see claims). */
  private claimant(code: string): string | undefined {
    const c = this.claims.get(code);
    if (c && Date.now() - c.since > 60_000) this.claims.delete(code);
    return this.claims.get(code)?.email;
  }

  private claimedByOther(code: string, email?: string): boolean {
    const by = this.claimant(code);
    return !!by && by !== email?.trim().toLowerCase();
  }

  /** Hold a single-use link for this address while its account is made. False: someone else holds it. */
  private hold(code: string, email: string): boolean {
    if (!this.invite(code)?.once) return true;
    if (this.claimedByOther(code, email)) return false;
    this.claims.set(code, { email: email.trim().toLowerCase(), since: Date.now() });
    return true;
  }

  private release(code: string | undefined, email: string) {
    if (code && !this.claimedByOther(code, email)) this.claims.delete(code);
  }

  /** The link a new account may join with: the one given, unless it is someone else's right now (open signup: then without). */
  private signupInvite(invite: string | undefined, email: string): string | undefined {
    if (!invite || this.hold(invite, email)) return invite;
    if (this.policy === "open") return undefined;
    throw new AccountError("invite invalid", 403);
  }

  /**
   * After Better Auth created a user. With an invite it joins that workspace; without one the app
   * has it create its first (set up there, in the app's language). The very first account becomes the admin and
   * takes over the data from before accounts, if there are any.
   */
  setUpNewUser(id: string, email: string, headers: Headers | undefined) {
    const c = signupContext(headers);
    if (this.userCount() === 1) {
      this.db.query("INSERT OR IGNORE INTO admins (user) VALUES (?)").run(id);
      const orphans = this.db.query("SELECT id FROM workspaces WHERE id NOT IN (SELECT workspace FROM members)").all() as { id: string }[];
      for (const w of orphans) this.addMember(w.id, id, "owner");
    }
    const inv = c.invite ? this.invite(c.invite) : undefined;
    if (c.invite && inv && (!inv.once || this.claimant(c.invite) === email.toLowerCase())) {
      this.release(c.invite, email);
      this.join(c.invite, id);
    }
  }

  /** Create an account with a password and sign it in (see setUpNewUser). */
  async signUp(body: { name: string; email: string; password: string; invite?: string }): Promise<SignedIn> {
    if (!this.login.password) throw new AccountError("passwords off", 403);
    if (!this.canSignUp(body.invite, body.email)) throw new AccountError(body.invite ? "invite invalid" : "signup closed", 403);
    const invite = this.signupInvite(body.invite, body.email);
    const res = await this.auth.api
      .signUpEmail({ body: { name: body.name.trim() || body.email.split("@")[0]!, email: body.email.trim(), password: body.password }, headers: signupHeaders({ invite }) })
      .catch((e) => {
        this.release(invite, body.email);
        throw new AccountError(e?.body?.message ?? e?.message ?? "signup failed", e?.statusCode === 422 ? 409 : (e?.statusCode ?? 400));
      });
    return { token: res.token!, user: { id: res.user.id, name: res.user.name, email: res.user.email } };
  }

  /**
   * Signing up with a password where codes are on (POST /api/account/signup): a new account proves
   * its address first, so nobody can take someone else's. Without `code`: the details are fine, the page
   * now has a code sent (the rate-limited way, POST /api/auth/email-otp/send-verification-otp).
   * With it: the account is made by the code (proven address, the same hooks), then gets the password.
   */
  async signUpWithCode(body: { name: string; email: string; password: string; invite?: string; lang?: string; code?: string }): Promise<SignedIn | { verify: true }> {
    if (!this.login.password) throw new AccountError("passwords off", 403);
    if (!this.canSignUp(body.invite, body.email)) throw new AccountError(body.invite ? "invite invalid" : "signup closed", 403);
    const ctx = await this.auth.$context;
    const email = body.email.trim().toLowerCase();
    const { minPasswordLength, maxPasswordLength } = ctx.password.config;
    if (body.password.length < minPasswordLength) throw new AccountError("password too short");
    if (body.password.length > maxPasswordLength) throw new AccountError("password too long");
    if (await ctx.internalAdapter.findUserByEmail(email)) throw new AccountError("exists", 409);
    if (!body.code) return { verify: true };
    const invite = this.signupInvite(body.invite, email);
    const res = await this.auth.api
      .signInEmailOTP({ body: { email, otp: body.code.trim(), name: body.name.trim() || email.split("@")[0]! }, headers: signupHeaders({ invite, lang: body.lang }) })
      .catch((e) => {
        this.release(invite, email);
        throw new AccountError(e?.body?.code === "INVALID_OTP" || e?.statusCode === 400 ? "invalid code" : (e?.body?.message ?? e?.message ?? "signup failed"), e?.statusCode ?? 400);
      });
    // (made meanwhile by another way: it keeps its own)
    if (!(await ctx.internalAdapter.findCredentialAccount(res.user.id)))
      await ctx.internalAdapter.linkAccount({ userId: res.user.id, providerId: "credential", accountId: res.user.id, password: await ctx.password.hash(body.password) });
    return { token: res.token, user: { id: res.user.id, name: res.user.name, email: res.user.email } };
  }

  /** The session of a bearer token: its user and when it began (for what needs a recent sign-in). */
  async session(token: string | null | undefined) {
    if (!token) return null;
    const s = await this.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }).catch(() => null);
    return s ? { user: { id: s.user.id, name: s.user.name, email: s.user.email } as User, created: new Date(s.session.createdAt).getTime() } : null;
  }

  /**
   * The session an OAuth sign-in left in the browser's cookie, as a token the app keeps: the page
   * trades it once (the cookie goes, see index.ts).
   */
  async claim(headers: Headers): Promise<SignedIn | null> {
    const h = new Headers({ cookie: headers.get("cookie") ?? "" });
    const s = await this.auth.api.getSession({ headers: h }).catch(() => null);
    return s ? { token: s.session.token, user: { id: s.user.id, name: s.user.name, email: s.user.email } } : null;
  }

  /** Whether the user can sign in with a password. */
  async hasPassword(user: string): Promise<boolean> {
    const ctx = await this.auth.$context;
    return !!(await ctx.internalAdapter.findCredentialAccount(user))?.password;
  }

  async signOut(token: string) {
    const ctx = await this.auth.$context;
    await ctx.internalAdapter.deleteSession(token);
  }

  /**
   * Change the password of `user`, signed in with the session `keep`. Every other session (other
   * devices, a stolen token) ends; this one stays.
   */
  async changePassword(user: string, keep: string, current: string, next: string) {
    const ctx = await this.auth.$context;
    await this.verifyPassword(user, current);
    const { minPasswordLength, maxPasswordLength } = ctx.password.config;
    if (next.length < minPasswordLength) throw new AccountError("password too short");
    if (next.length > maxPasswordLength) throw new AccountError("password too long");
    await ctx.internalAdapter.updatePassword(user, await ctx.password.hash(next));
    this.db.query('DELETE FROM "session" WHERE userId = ? AND token != ?').run(user, keep);
  }

  /** Throws unless `password` is the current password of `user`. */
  private async verifyPassword(user: string, password: string) {
    if (!password || password.length > 1024) throw new AccountError("invalid password", 403);
    const ctx = await this.auth.$context;
    const credential = await ctx.internalAdapter.findCredentialAccount(user);
    if (!credential?.password || !(await ctx.password.verify({ hash: credential.password, password })))
      throw new AccountError("invalid password", 403);
  }

  /**
   * Delete only the caller's identity. Workspaces must retain an owner. Proof that it is them: the
   * password, or (without one) a sign-in in the last minutes (`signedInAt`).
   */
  async deleteAccount(user: string, password: string | undefined, signedInAt = 0) {
    if (password !== undefined) await this.verifyPassword(user, password);
    else if (Date.now() - signedInAt > FRESH_SECONDS * 1000) throw new AccountError("sign in again", 403);
    this.db.transaction(() => {
      for (const w of this.workspacesOf(user)) {
        if (w.role === "owner" && this.members(w.id).filter((m) => m.role === "owner").length === 1)
          throw new AccountError("last owner", 409);
      }
      for (const table of ["members", "tokens", "admins"]) this.db.query(`DELETE FROM ${table} WHERE user = ?`).run(user);
      this.db.query('DELETE FROM invites WHERE "by" = ?').run(user);
      // Better Auth's database-backed sessions and credentials have no secondary cache here.
      for (const table of ["session", "account", "passkey"]) this.db.query(`DELETE FROM "${table}" WHERE userId = ?`).run(user);
      this.db.query('DELETE FROM "user" WHERE id = ?').run(user);
    })();
  }

  // ---------- workspaces ----------

  workspacesOf(user: string): WorkspaceInfo[] {
    const rows = this.db.query("SELECT w.id, w.name, w.legacy, m.role FROM members m JOIN workspaces w ON w.id = m.workspace WHERE m.user = ? ORDER BY m.joined").all(user) as { id: string; name: string; legacy: number; role: Role }[];
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, ...(r.legacy ? { legacy: true } : {}) }));
  }

  role(workspace: string, user: string): Role | undefined {
    return (this.db.query("SELECT role FROM members WHERE workspace = ? AND user = ?").get(workspace, user) as { role: Role } | null)?.role;
  }

  createWorkspace(user: string, name: string): WorkspaceInfo {
    const id = newId();
    const clean = workspaceName(name) || "Workspace";
    mkdirSync(this.dir(id), { recursive: true });
    this.db.query("INSERT INTO workspaces (id, name, created) VALUES (?, ?, ?)").run(id, clean, Date.now());
    this.addMember(id, user, "owner");
    return { id, name: clean, role: "owner" };
  }

  rename(workspace: string, user: string, name: string) {
    if (this.role(workspace, user) !== "owner") throw new AccountError("only owners rename", 403);
    const clean = workspaceName(name);
    if (!clean) throw new AccountError("name required");
    this.db.query("UPDATE workspaces SET name = ? WHERE id = ?").run(clean, workspace);
  }

  /** An owner deletes a workspace: for everyone, with its folder (data, files, backups). Close it first. */
  deleteWorkspace(workspace: string, by: string) {
    if (this.role(workspace, by) !== "owner") throw new AccountError("only owners delete", 403);
    for (const table of ["members", "invites", "tokens"]) this.db.query(`DELETE FROM ${table} WHERE workspace = ?`).run(workspace);
    this.db.query("DELETE FROM workspaces WHERE id = ?").run(workspace);
    rmSync(this.dir(workspace), { recursive: true, force: true });
  }

  private addMember(workspace: string, user: string, role: Role) {
    this.db.query("INSERT OR IGNORE INTO members (workspace, user, role, joined) VALUES (?, ?, ?, ?)").run(workspace, user, role, Date.now());
  }

  members(workspace: string): Member[] {
    return this.db.query('SELECT u.id, u.name, u.email, m.role FROM members m JOIN "user" u ON u.id = m.user WHERE m.workspace = ? ORDER BY m.joined').all(workspace) as Member[];
  }

  private isLastOwner(workspace: string, user: string) {
    const owners = this.members(workspace).filter((m) => m.role === "owner");
    return owners.length === 1 && owners[0]!.id === user;
  }

  /**
   * Leave a workspace, or (an owner) remove someone. The last owner cannot go: the workspace
   * would belong to nobody. What the person made to get in goes with them: their agent tokens
   * and the invite links they made for it. Their open connections are the caller's to close.
   */
  removeMember(workspace: string, by: string, user: string) {
    const byRole = this.role(workspace, by);
    if (!byRole || (by !== user && byRole !== "owner")) throw new AccountError("not allowed", 403);
    if (!this.role(workspace, user)) throw new AccountError("not a member", 404);
    if (this.isLastOwner(workspace, user)) throw new AccountError("last owner", 409);
    this.db.transaction(() => {
      this.db.query("DELETE FROM members WHERE workspace = ? AND user = ?").run(workspace, user);
      this.db.query("DELETE FROM tokens WHERE workspace = ? AND user = ?").run(workspace, user);
      this.db.query('DELETE FROM invites WHERE workspace = ? AND "by" = ?').run(workspace, user);
    })();
  }

  /** An owner makes someone an owner or a member. The last owner stays one. */
  setRole(workspace: string, by: string, user: string, role: Role) {
    if (this.role(workspace, by) !== "owner") throw new AccountError("only owners change roles", 403);
    const now = this.role(workspace, user);
    if (!now) throw new AccountError("not a member", 404);
    if (now === role) return;
    if (role === "member" && this.isLastOwner(workspace, user)) throw new AccountError("last owner", 409);
    this.db.query("UPDATE members SET role = ? WHERE workspace = ? AND user = ?").run(role, workspace, user);
  }

  // ---------- invites ----------

  /**
   * An invite link's code: whoever joins with it gets `role`, for 14 days or until an owner revokes
   * it; a single-use one (`once`) works for the first person only. Links for owners are always
   * single-use: one lost in a chat must not hand out the workspace. Owners only.
   */
  createInvite(workspace: string, by: string, role: Role = "member", once = true): string {
    if (this.role(workspace, by) !== "owner") throw new AccountError("only owners invite", 403);
    if (role === "owner" && !once) throw new AccountError("owner links are single-use", 400);
    const code = randomToken();
    this.db.query("INSERT INTO invites (code, workspace, by, created, expires, role, once) VALUES (?, ?, ?, ?, ?, ?, ?)").run(code, workspace, by, Date.now(), Date.now() + INVITE_DAYS * 86400_000, role, once ? 1 : 0);
    return code;
  }

  /** The links of a workspace that still work, newest first (owners only). Expired ones go. */
  invites(workspace: string, by: string): InviteLink[] {
    if (this.role(workspace, by) !== "owner") throw new AccountError("only owners invite", 403);
    this.db.query("DELETE FROM invites WHERE workspace = ? AND expires <= ?").run(workspace, Date.now());
    return this.db.query('SELECT i.code, i.created, i.expires, i.role, i.once, coalesce(u.name, \'\') AS by FROM invites i LEFT JOIN "user" u ON u.id = i.by WHERE i.workspace = ? ORDER BY i.created DESC')
      .all(workspace)
      .map((l: any) => ({ ...l, once: !!l.once })) as InviteLink[];
  }

  /** An owner takes a link back: whoever has it can no longer join with it. */
  revokeInvite(workspace: string, by: string, code: string) {
    if (this.role(workspace, by) !== "owner") throw new AccountError("only owners invite", 403);
    if (!this.db.query("DELETE FROM invites WHERE workspace = ? AND code = ?").run(workspace, code).changes) throw new AccountError("invite invalid", 404);
  }

  invite(code: string): { workspace: string; name: string; by: string; role: Role; once: boolean } | undefined {
    const row = this.db.query('SELECT i.workspace, w.name, u.name AS by, i.role, i.once FROM invites i JOIN workspaces w ON w.id = i.workspace LEFT JOIN "user" u ON u.id = i.by WHERE i.code = ? AND i.expires > ?').get(code, Date.now()) as { workspace: string; name: string; by: string; role: Role; once: number } | null;
    return row ? { ...row, once: !!row.once } : undefined;
  }

  /**
   * Join with a link, in the link's role. Someone already in keeps their role, and a single-use link
   * stays for whom it was meant; otherwise it is used up in the same step.
   */
  join(code: string, user: string): WorkspaceInfo {
    const inv = this.invite(code);
    if (!inv || (inv.once && this.claimant(code))) throw new AccountError("invite invalid", 404);
    if (!this.role(inv.workspace, user))
      this.db.transaction(() => {
        this.addMember(inv.workspace, user, inv.role);
        if (inv.once) this.db.query("DELETE FROM invites WHERE code = ?").run(code);
      })();
    return this.workspacesOf(user).find((w) => w.id === inv.workspace)!;
  }

  // ---------- MCP tokens ----------

  /** A token for agents (Claude Code, Claude Desktop) on one workspace, as this user. Shown once. */
  mcpToken(workspace: string, user: string): string {
    if (!this.role(workspace, user)) throw new AccountError("not a member", 403);
    const token = "obt_" + randomToken();
    this.db.query("INSERT INTO tokens (hash, user, workspace, label, created) VALUES (?, ?, ?, ?, ?)").run(sha256(token), user, workspace, "mcp", Date.now());
    return token;
  }

  /** The user an MCP token stands for on this workspace (and is still a member), or undefined. */
  mcpUser(workspace: string, token: string): User | undefined {
    const row = this.db.query('SELECT u.id, u.name, u.email FROM tokens t JOIN "user" u ON u.id = t.user JOIN members m ON m.workspace = t.workspace AND m.user = t.user WHERE t.hash = ? AND t.workspace = ?').get(sha256(token), workspace) as User | null;
    return row ?? undefined;
  }
}

function makeAuth(accounts: Accounts, secret: string, baseURL: string) {
  const login = accounts.login;
  const oidc = login.oauth.find((p) => p.id === "oidc");
  const social = Object.fromEntries(login.oauth.filter((p) => p.id !== "oidc").map((p) => [p.id, { clientId: p.clientId, clientSecret: p.clientSecret }]));
  return betterAuth({
    database: accounts.db,
    secret,
    baseURL,
    appName: "Obtion",
    emailAndPassword: { enabled: login.password, minPasswordLength: 8 },
    socialProviders: social,
    // an OAuth provider vouching for an address (email_verified) may sign in to the account with it
    // linking in the settings is the signed-in person's own choice: the provider's address may differ
    // (index.ts wants a fresh sign-in for it). Signing in links on its own only to a proven address.
    account: { accountLinking: { enabled: true, allowDifferentEmails: true } },
    // an app stays signed in like a mail app; every use within a day moves the end. Adding a
    // passkey needs a sign-in of the last minutes (a stolen token cannot add one).
    session: { expiresIn: 60 * 60 * 24 * 365, updateAge: 60 * 60 * 24, freshAge: FRESH_SECONDS },
    // the app's own page calls /api/auth/*; the server checks the origin itself (index.ts)
    trustedOrigins: (req) => [req?.headers.get("origin") ?? undefined].filter((o): o is string => !!o),
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => accounts.allowNewUser(user.email, ctx?.headers),
          after: async (user, ctx) => accounts.setUpNewUser(user.id, user.email, ctx?.headers),
        },
        update: {
          // A code by email proves the address of an account whose address nobody had proven
          // (signed up with a password): Better Auth then drops its password and sessions, and
          // here everything else whoever signed up with that address may have made to get in:
          // passkeys, agent tokens, invite links, open connections.
          before: async (data, ctx) => {
            const email = (ctx?.body as { email?: unknown } | undefined)?.email;
            if (data.emailVerified !== true || typeof email !== "string") return;
            const user = accounts.db.query<{ id: string }, [string]>('SELECT id FROM "user" WHERE email = ? AND emailVerified = 0').get(email.toLowerCase());
            if (!user) return;
            accounts.db.query("DELETE FROM passkey WHERE userId = ?").run(user.id);
            accounts.db.query("DELETE FROM tokens WHERE user = ?").run(user.id);
            accounts.db.query('DELETE FROM invites WHERE "by" = ?').run(user.id);
            accounts.onRevoke(user.id);
          },
        },
      },
    },
    plugins: [
      bearer(),
      // always there, so that its table is: the routes answer only when passkeys are on (index.ts)
      passkey({ rpID: login.passkey?.rpID ?? "localhost", rpName: "Obtion", origin: login.passkey?.origin ?? null }),
      ...(login.sendCode
        ? [
            emailOTP({
              expiresIn: 10 * 60,
              storeOTP: "hashed",
              sendVerificationOTP: async ({ email, otp, type }, ctx) => {
                if (type !== "sign-in") return;
                // a code for an address without an account only where it may become one
                const known = !!accounts.db.query('SELECT 1 FROM "user" WHERE email = ?').get(email.toLowerCase());
                const c = signupContext(ctx?.headers);
                if (!known && !accounts.canSignUp(c.invite, email)) return;
                await login.sendCode!(email, otp, c.lang);
              },
            }),
          ]
        : []),
      ...(oidc ? [genericOAuth({ config: [{ providerId: "oidc", discoveryUrl: oidc.discoveryUrl!, clientId: oidc.clientId, clientSecret: oidc.clientSecret, scopes: ["openid", "email", "profile"], pkce: true }] })] : []),
    ],
    // also outside NODE_ENV=production: a hosted server must not let anyone guess passwords
    rateLimit: { enabled: true },
    telemetry: { enabled: false },
  });
}

/**
 * For the CLI: a new password for the account with this address (the way back in for someone who
 * forgot theirs on a server without codes by email). Devices signed in stay signed in.
 */
export async function setPassword(dataDir: string, email: string, password: string) {
  if (password.length < 8 || password.length > 128) throw new Error("The password needs 8 to 128 characters.");
  const accounts = new Accounts(dataDir, { secret: "set-password-only-hashes-and-signs-nothing-here", baseURL: "http://localhost", policy: "off" });
  try {
    await accounts.init(() => "Personal");
    const ctx = await accounts.auth.$context;
    const user = await ctx.internalAdapter.findUserByEmail(email.trim().toLowerCase());
    if (!user) throw new Error(`No account with the address ${email}.`);
    const hash = await ctx.password.hash(password);
    const credential = await ctx.internalAdapter.findCredentialAccount(user.user.id);
    if (credential) await ctx.internalAdapter.updatePassword(user.user.id, hash);
    else await ctx.internalAdapter.linkAccount({ userId: user.user.id, providerId: "credential", accountId: user.user.id, password: hash });
  } finally {
    accounts.db.close();
  }
}

/**
 * For the CLI: count the addresses of all accounts as proven, for a server that turns codes on
 * after people signed up with passwords. Their first code then changes nothing (see the update
 * hook). Only for a server whose admin knows its accounts are those people's. Returns how many.
 */
export function trustEmails(dataDir: string): number {
  const db = new Database(join(dataDir, "accounts.db"));
  try {
    return db.query('UPDATE "user" SET emailVerified = 1 WHERE emailVerified = 0').run().changes;
  } finally {
    db.close();
  }
}

/** For the CLI and tests: the workspace folders that exist. */
export function workspaceDirs(dataDir: string): string[] {
  const root = join(dataDir, "workspaces");
  return existsSync(root) ? readdirSync(root).map((n) => join(root, n)) : [];
}
