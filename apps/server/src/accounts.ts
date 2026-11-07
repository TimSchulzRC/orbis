// Identity comes from Better Auth, always by bearer token and never by cookie, so one app can talk
// to several servers. Only an OAuth sign-in ends with a cookie, which the app trades for a token
// once (claim). Workspace membership and roles are ours.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { APIError, getSessionFromCtx } from "better-auth/api";
import { bearer, emailOTP, genericOAuth } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { getMigrations } from "better-auth/db/migration";
import { z } from "zod";
import { newId } from "@obtion/core/model";
import type { InviteLink, Member, Role, SignedIn, SignupPolicy, User, WorkspaceInfo } from "@obtion/core/api";
import { sha256 } from "./blobs";
import type { LoginConfig } from "./login";

/** How long after signing in a passkey may be added or the account deleted without a password. */
export const FRESH_SECONDS = 10 * 60;

/**
 * Set by the page before a code or OAuth signup, where the request is Better Auth's own. A cookie,
 * so it also reaches the OAuth callback.
 */
export const SIGNUP_COOKIE = "obtion_signup";
interface SignupContext {
  invite?: string;
  /** language of the code email */
  lang?: string;
}

function signupContext(headers: Headers | undefined): SignupContext {
  const raw = headers?.get("cookie")?.split(";").map((c) => c.trim()).find((c) => c.startsWith(SIGNUP_COOKIE + "="));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(decodeURIComponent(raw.slice(SIGNUP_COOKIE.length + 1))) as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === "string" && x.length < 200 ? x : undefined);
    return { invite: str(parsed.invite), lang: str(parsed.lang) };
  } catch {
    return {};
  }
}

const signupHeaders = (c: SignupContext) => new Headers({ cookie: `${SIGNUP_COOKIE}=${encodeURIComponent(JSON.stringify(c))}` });

const MAX_WORKSPACE_NAME = 80;
const workspaceName = (name: string) => name.trim().slice(0, MAX_WORKSPACE_NAME);

export class AccountError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** What a data folder held before accounts. */
const LEGACY_ENTRIES = ["obtion.db", "obtion.db-wal", "obtion.db-shm", "blobs", "vault", "backups", "agent"];

const INVITE_DAYS = 14;
const DAY_MS = 86400_000;
const CLAIM_TTL_MS = 60_000;
/** From the sign-up form to the device's answer: time to find the phone or the security key. */
const PASSKEY_SIGNUP_MS = 5 * 60_000;
const MAX_PASSKEY_SIGNUPS = 1000;
const MAX_NAME = 100;

/** A sign-up waiting for its passkey (Accounts.startPasskeySignup). */
interface PasskeySignup {
  /** the account's id, also the passkey's user handle */
  id: string;
  name: string;
  email: string;
  until: number;
}

const publicUser = (u: User): User => ({ id: u.id, name: u.name, email: u.email });

/** Better Auth's length limits, as the signup page shows them. */
function checkPasswordLength(password: string, config: { minPasswordLength: number; maxPasswordLength: number }) {
  if (password.length < config.minPasswordLength) throw new AccountError("password too short");
  if (password.length > config.maxPasswordLength) throw new AccountError("password too long");
}

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
      CREATE TABLE IF NOT EXISTS members (workspace TEXT NOT NULL, user TEXT NOT NULL, role TEXT NOT NULL, joined INTEGER NOT NULL, pos INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (workspace, user));
      CREATE INDEX IF NOT EXISTS members_user ON members(user);
      CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, workspace TEXT NOT NULL, by TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member');
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, user TEXT NOT NULL, workspace TEXT NOT NULL, label TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS admins (user TEXT PRIMARY KEY);
    `);
    // from before a new MCP token ended the one before: only the newest per member and workspace stays
    this.db.exec(`DELETE FROM tokens WHERE label = 'mcp' AND EXISTS (SELECT 1 FROM tokens n WHERE n.label = 'mcp' AND n.workspace = tokens.workspace AND n.user = tokens.user AND (n.created > tokens.created OR (n.created = tokens.created AND n.hash > tokens.hash)))`);
  }

  policy: SignupPolicy;
  login: LoginConfig;
  /**
   * Invite codes a signup is using right now. Until that account has joined, nobody else gets in
   * with the link. Checked before Better Auth starts: it shares this connection, and a signup failing
   * inside its transaction would roll back the other one's join too.
   */
  private claims = new Map<string, { email: string; since: number }>();
  /** Keyed by the context the page hands to the passkey routes. */
  private passkeySignups = new Map<string, PasskeySignup>();

  /** Someone else proved the user's address: close what is open. */
  onRevoke: (user: string) => void;

  async init(legacyName: (dir: string) => string) {
    const { runMigrations } = await getMigrations(this.auth.options);
    await runMigrations();
    this.migrateLegacy(legacyName);
  }

  /**
   * Pre-accounts data becomes a workspace without members; the first account gets it. The store
   * keeps its id, so devices recognise it and keep their copy.
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

  dir(id: string) {
    return join(this.dataDir, "workspaces", id);
  }

  exists(id: string): boolean {
    return /^[\w-]{1,40}$/.test(id) && !!this.db.query("SELECT 1 FROM workspaces WHERE id = ?").get(id) && existsSync(this.dir(id));
  }

  /** Cookies are never looked at: a request without the token cannot be one the user meant, whatever site sent it. */
  async userOf(token: string | null | undefined): Promise<User | null> {
    return (await this.session(token))?.user ?? null;
  }

  userCount(): number {
    return (this.db.query('SELECT count(*) AS n FROM "user"').get() as { n: number }).n;
  }

  /** The first account is the admin; no right depends on it yet. */
  isAdmin(user: string): boolean {
    return !!this.db.query("SELECT 1 FROM admins WHERE user = ?").get(user);
  }

  canSignUp(invite?: string, email?: string): boolean {
    if (this.userCount() === 0 || this.policy === "open") return true;
    return this.policy === "invite" && !!invite && !!this.invite(invite) && !this.claimedByOther(invite, email);
  }

  /** Better Auth hook before it creates a user by any method. */
  allowNewUser(email: string, headers: Headers | undefined) {
    const { invite } = signupContext(headers);
    // the code sends an OAuth sign-in back to the page as ?signin=failed&error=signup_closed
    if (!this.canSignUp(invite, email)) throw new APIError("FORBIDDEN", invite ? { message: "invite invalid", code: "invite_invalid" } : { message: "signup closed", code: "signup_closed" });
    // a password signup has claimed it already; OAuth and codes arrive here directly
    if (invite) this.hold(invite, email);
  }

  /** For signups through our own routes, before Better Auth sees them. */
  private checkPasswordSignup(invite: string | undefined, email: string) {
    if (!this.login.password) throw new AccountError("passwords off", 403);
    if (!this.canSignUp(invite, email)) throw new AccountError(invite ? "invite invalid" : "signup closed", 403);
  }

  private claimant(code: string): string | undefined {
    const c = this.claims.get(code);
    if (c && Date.now() - c.since > CLAIM_TTL_MS) this.claims.delete(code);
    return this.claims.get(code)?.email;
  }

  private claimedByOther(code: string, email?: string): boolean {
    const by = this.claimant(code);
    return !!by && by !== email?.trim().toLowerCase();
  }

  /** False if someone else holds it. */
  private hold(code: string, email: string): boolean {
    if (this.claimedByOther(code, email)) return false;
    this.claims.set(code, { email: email.trim().toLowerCase(), since: Date.now() });
    return true;
  }

  private release(code: string | undefined, email: string) {
    if (code && !this.claimedByOther(code, email)) this.claims.delete(code);
  }

  /** Drops a link someone else holds when signup is open; otherwise throws. */
  private signupInvite(invite: string | undefined, email: string): string | undefined {
    if (!invite || this.hold(invite, email)) return invite;
    if (this.policy === "open") return undefined;
    throw new AccountError("invite invalid", 403);
  }

  /**
   * Better Auth hook after it created a user. The very first account becomes admin and owns any
   * workspace without members (pre-accounts data).
   */
  setUpNewUser(id: string, email: string, headers: Headers | undefined) {
    const { invite } = signupContext(headers);
    if (this.userCount() === 1) {
      this.db.query("INSERT OR IGNORE INTO admins (user) VALUES (?)").run(id);
      const orphans = this.db.query("SELECT id FROM workspaces WHERE id NOT IN (SELECT workspace FROM members)").all() as { id: string }[];
      for (const w of orphans) this.addMember(w.id, id, "owner");
    }
    if (invite && this.invite(invite) && this.claimant(invite) === email.toLowerCase()) {
      this.release(invite, email);
      this.join(invite, id);
    }
  }

  async signUp(body: { name: string; email: string; password: string; invite?: string }): Promise<SignedIn> {
    this.checkPasswordSignup(body.invite, body.email);
    const invite = this.signupInvite(body.invite, body.email);
    const res = await this.auth.api
      .signUpEmail({ body: { name: body.name.trim() || body.email.split("@")[0]!, email: body.email.trim(), password: body.password }, headers: signupHeaders({ invite }) })
      .catch((e) => {
        this.release(invite, body.email);
        throw new AccountError(e?.body?.message ?? e?.message ?? "signup failed", e?.statusCode === 422 ? 409 : (e?.statusCode ?? 400));
      });
    return { token: res.token!, user: publicUser(res.user) };
  }

  /**
   * Password signup where codes are on: the account proves its address first, so nobody can take
   * someone else's. Without `code` this only validates; the page then requests a code through Better
   * Auth's rate-limited route. With it the code creates the account, then it gets the password.
   */
  async signUpWithCode(body: { name: string; email: string; password: string; invite?: string; lang?: string; code?: string }): Promise<SignedIn | { verify: true }> {
    this.checkPasswordSignup(body.invite, body.email);
    const ctx = await this.auth.$context;
    const email = body.email.trim().toLowerCase();
    checkPasswordLength(body.password, ctx.password.config);
    if (await ctx.internalAdapter.findUserByEmail(email)) throw new AccountError("exists", 409);
    if (!body.code) return { verify: true };
    const invite = this.signupInvite(body.invite, email);
    const res = await this.auth.api
      .signInEmailOTP({ body: { email, otp: body.code.trim(), name: body.name.trim() || email.split("@")[0]! }, headers: signupHeaders({ invite, lang: body.lang }) })
      .catch((e) => {
        this.release(invite, email);
        throw new AccountError(e?.body?.code === "INVALID_OTP" || e?.statusCode === 400 ? "invalid code" : (e?.body?.message ?? e?.message ?? "signup failed"), e?.statusCode ?? 400);
      });
    // a password set meanwhile by another way stays
    if (!(await ctx.internalAdapter.findCredentialAccount(res.user.id)))
      await ctx.internalAdapter.linkAccount({ userId: res.user.id, providerId: "credential", accountId: res.user.id, password: await ctx.password.hash(body.password) });
    return { token: res.token, user: publicUser(res.user) };
  }

  /**
   * Sign-up with a passkey instead of a password, where codes are off (with codes the address
   * proves itself first, and the new account then adds a passkey as any account does). Checks name,
   * address and the sign-up rules; the page then registers a passkey with the returned context, and
   * that creates the account (afterVerification in makeAuth). Nothing is created before.
   */
  async startPasskeySignup(body: { name: string; email: string; invite?: string }): Promise<{ context: string }> {
    if (!this.login.passkey) throw new AccountError("passkeys off", 403);
    if (this.login.sendCode) throw new AccountError("verify by code", 403);
    const email = body.email.trim().toLowerCase();
    if (!z.email().safeParse(email).success) throw new AccountError("invalid email");
    if (!this.canSignUp(body.invite, email)) throw new AccountError(body.invite ? "invite invalid" : "signup closed", 403);
    const ctx = await this.auth.$context;
    if (await ctx.internalAdapter.findUserByEmail(email)) throw new AccountError("exists", 409);
    const now = Date.now();
    for (const [k, v] of this.passkeySignups) if (v.until <= now) this.passkeySignups.delete(k);
    if (this.passkeySignups.size >= MAX_PASSKEY_SIGNUPS) throw new AccountError("too many", 429);
    const context = randomToken();
    const name = body.name.trim().slice(0, MAX_NAME) || email.split("@")[0]!;
    this.passkeySignups.set(context, { id: ctx.generateId({ model: "user" }) || randomToken(), name, email, until: now + PASSKEY_SIGNUP_MS });
    return { context };
  }

  /** The waiting sign-up behind a context; `take` uses it up. */
  passkeySignup(context: string | null | undefined, take = false): PasskeySignup | undefined {
    const s = context ? this.passkeySignups.get(context) : undefined;
    if (!s || s.until <= Date.now()) return undefined;
    if (take) this.passkeySignups.delete(context!);
    return s;
  }

  /** `created` is for actions that need a recent sign-in. */
  async session(token: string | null | undefined) {
    if (!token) return null;
    const s = await this.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }).catch(() => null);
    return s ? { user: publicUser(s.user), created: new Date(s.session.createdAt).getTime() } : null;
  }

  /** Trades the session an OAuth sign-in left in a cookie for a token the app keeps. */
  async claim(headers: Headers): Promise<SignedIn | null> {
    const cookieOnly = new Headers({ cookie: headers.get("cookie") ?? "" });
    const s = await this.auth.api.getSession({ headers: cookieOnly }).catch(() => null);
    return s ? { token: s.session.token, user: publicUser(s.user) } : null;
  }

  async hasPassword(user: string): Promise<boolean> {
    const ctx = await this.auth.$context;
    return !!(await ctx.internalAdapter.findCredentialAccount(user))?.password;
  }

  /** False for an account's last passkey where nothing else signs it in: no code, password or provider. */
  async canDropPasskey(user: string): Promise<boolean> {
    if (this.login.sendCode || (this.login.password && (await this.hasPassword(user)))) return true;
    if ((this.db.query("SELECT count(*) AS n FROM passkey WHERE userId = ?").get(user) as { n: number }).n > 1) return true;
    const providers = this.login.oauth.map((p) => p.id);
    return providers.some((p) => !!this.db.query("SELECT 1 FROM account WHERE userId = ? AND providerId = ?").get(user, p));
  }

  async signOut(token: string) {
    const ctx = await this.auth.$context;
    await ctx.internalAdapter.deleteSession(token);
  }

  /** Ends every other session (other devices, a stolen token); `keep` stays. */
  async changePassword(user: string, keep: string, current: string, next: string) {
    const ctx = await this.auth.$context;
    await this.verifyPassword(user, current);
    checkPasswordLength(next, ctx.password.config);
    await ctx.internalAdapter.updatePassword(user, await ctx.password.hash(next));
    this.db.query('DELETE FROM "session" WHERE userId = ? AND token != ?').run(user, keep);
  }

  private async verifyPassword(user: string, password: string) {
    if (!password || password.length > 1024) throw new AccountError("invalid password", 403);
    const ctx = await this.auth.$context;
    const credential = await ctx.internalAdapter.findCredentialAccount(user);
    if (!credential?.password || !(await ctx.password.verify({ hash: credential.password, password })))
      throw new AccountError("invalid password", 403);
  }

  /**
   * Proof is the password, or for accounts without one a recent sign-in. Workspaces must keep an
   * owner and are not deleted.
   */
  async deleteAccount(user: string, password: string | undefined, signedInAt = 0) {
    if (password !== undefined) await this.verifyPassword(user, password);
    else if (Date.now() - signedInAt > FRESH_SECONDS * 1000) throw new AccountError("sign in again", 403);
    this.db.transaction(() => {
      for (const w of this.workspacesOf(user)) if (this.isLastOwner(w.id, user)) throw new AccountError("last owner", 409);
      for (const table of ["members", "tokens", "admins"]) this.db.query(`DELETE FROM ${table} WHERE user = ?`).run(user);
      this.db.query('DELETE FROM invites WHERE "by" = ?').run(user);
      // Better Auth's database-backed sessions and credentials have no secondary cache here.
      for (const table of ["session", "account", "passkey"]) this.db.query(`DELETE FROM "${table}" WHERE userId = ?`).run(user);
      this.db.query('DELETE FROM "user" WHERE id = ?').run(user);
    })();
  }

  workspacesOf(user: string): WorkspaceInfo[] {
    const rows = this.db.query("SELECT w.id, w.name, w.legacy, m.role FROM members m JOIN workspaces w ON w.id = m.workspace WHERE m.user = ? ORDER BY m.pos, m.joined DESC").all(user) as { id: string; name: string; legacy: number; role: Role }[];
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
    this.requireOwner(workspace, user, "only owners rename");
    const clean = workspaceName(name);
    if (!clean) throw new AccountError("name required");
    this.db.query("UPDATE workspaces SET name = ? WHERE id = ?").run(clean, workspace);
  }

  /** Removes the folder too; close the workspace first. */
  deleteWorkspace(workspace: string, by: string) {
    this.requireOwner(workspace, by, "only owners delete");
    for (const table of ["members", "invites", "tokens"]) this.db.query(`DELETE FROM ${table} WHERE workspace = ?`).run(workspace);
    this.db.query("DELETE FROM workspaces WHERE id = ?").run(workspace);
    rmSync(this.dir(workspace), { recursive: true, force: true });
  }

  /**
   * The user's own order of their workspaces: `ids` in this order. Ones the list leaves out (joined
   * since the list was made) stay on top, as new ones are.
   */
  reorder(user: string, ids: string[]) {
    const current = this.workspacesOf(user).map((w) => w.id);
    const order = [...current.filter((id) => !ids.includes(id)), ...ids.filter((id) => current.includes(id))];
    const set = this.db.query("UPDATE members SET pos = ? WHERE workspace = ? AND user = ?");
    this.db.transaction(() => order.forEach((id, i) => set.run(i, id, user)))();
  }

  /** A new member; the workspace comes first in their order. */
  private addMember(workspace: string, user: string, role: Role) {
    this.db
      .query("INSERT OR IGNORE INTO members (workspace, user, role, joined, pos) VALUES (?, ?, ?, ?, (SELECT COALESCE(MIN(pos), 1) - 1 FROM members WHERE user = ?))")
      .run(workspace, user, role, Date.now(), user);
  }

  members(workspace: string): Member[] {
    return this.db.query('SELECT u.id, u.name, u.email, m.role FROM members m JOIN "user" u ON u.id = m.user WHERE m.workspace = ? ORDER BY m.joined').all(workspace) as Member[];
  }

  private isLastOwner(workspace: string, user: string) {
    const owners = this.members(workspace).filter((m) => m.role === "owner");
    return owners.length === 1 && owners[0]!.id === user;
  }

  /** Their agent tokens and invite links go with them. Closing their connections is up to the caller. */
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

  private requireOwner(workspace: string, user: string, message: string) {
    if (this.role(workspace, user) !== "owner") throw new AccountError(message, 403);
  }

  setRole(workspace: string, by: string, user: string, role: Role) {
    this.requireOwner(workspace, by, "only owners change roles");
    const now = this.role(workspace, user);
    if (!now) throw new AccountError("not a member", 404);
    if (now === role) return;
    if (role === "member" && this.isLastOwner(workspace, user)) throw new AccountError("last owner", 409);
    this.db.query("UPDATE members SET role = ? WHERE workspace = ? AND user = ?").run(role, workspace, user);
  }

  /** Single use, so a link passed on reaches nobody else. */
  createInvite(workspace: string, by: string, role: Role = "member"): string {
    this.requireOwner(workspace, by, "only owners invite");
    const code = randomToken();
    this.db.query("INSERT INTO invites (code, workspace, by, created, expires, role) VALUES (?, ?, ?, ?, ?, ?)").run(code, workspace, by, Date.now(), Date.now() + INVITE_DAYS * DAY_MS, role);
    return code;
  }

  /** Also deletes expired links. */
  invites(workspace: string, by: string): InviteLink[] {
    this.requireOwner(workspace, by, "only owners invite");
    this.db.query("DELETE FROM invites WHERE workspace = ? AND expires <= ?").run(workspace, Date.now());
    return this.db.query('SELECT i.code, i.created, i.expires, i.role, coalesce(u.name, \'\') AS by FROM invites i LEFT JOIN "user" u ON u.id = i.by WHERE i.workspace = ? ORDER BY i.created DESC').all(workspace) as InviteLink[];
  }

  revokeInvite(workspace: string, by: string, code: string) {
    this.requireOwner(workspace, by, "only owners invite");
    if (!this.db.query("DELETE FROM invites WHERE workspace = ? AND code = ?").run(workspace, code).changes) throw new AccountError("invite invalid", 404);
  }

  invite(code: string): { workspace: string; name: string; by: string; role: Role } | undefined {
    const row = this.db.query('SELECT i.workspace, w.name, u.name AS by, i.role FROM invites i JOIN workspaces w ON w.id = i.workspace LEFT JOIN "user" u ON u.id = i.by WHERE i.code = ? AND i.expires > ?').get(code, Date.now()) as { workspace: string; name: string; by: string; role: Role } | null;
    return row ?? undefined;
  }

  /** Someone already in keeps their role, and the link stays for whom it was meant. */
  join(code: string, user: string): WorkspaceInfo {
    const inv = this.invite(code);
    if (!inv || this.claimant(code)) throw new AccountError("invite invalid", 404);
    if (!this.role(inv.workspace, user))
      this.db.transaction(() => {
        this.addMember(inv.workspace, user, inv.role);
        this.db.query("DELETE FROM invites WHERE code = ?").run(code);
      })();
    return this.workspacesOf(user).find((w) => w.id === inv.workspace)!;
  }

  /** Only the hash is stored, so the token can be shown once. A new one ends the one before. */
  mcpToken(workspace: string, user: string): string {
    if (!this.role(workspace, user)) throw new AccountError("not a member", 403);
    const token = "obt_" + randomToken();
    this.db.transaction(() => {
      this.revokeMcpToken(workspace, user);
      this.db.query("INSERT INTO tokens (hash, user, workspace, label, created) VALUES (?, ?, ?, ?, ?)").run(sha256(token), user, workspace, "mcp", Date.now());
    })();
    return token;
  }

  /** Ends the user's MCP token for this workspace at once. */
  revokeMcpToken(workspace: string, user: string) {
    this.db.query("DELETE FROM tokens WHERE workspace = ? AND user = ? AND label = 'mcp'").run(workspace, user);
  }

  /** Undefined once the user is no longer a member. */
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
    // Signing in links on its own only to an address the provider vouches for (email_verified).
    // Linking in the settings is the user's own choice, so the address may differ; index.ts wants a
    // fresh sign-in for it.
    account: { accountLinking: { enabled: true, allowDifferentEmails: true } },
    // apps stay signed in like a mail app; any use within a day extends it. freshAge keeps a stolen
    // token from adding a passkey.
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
          // A code proves the address of a password account nobody had verified. Better Auth drops
          // its password and sessions; here goes everything else whoever signed up with that
          // address may have made to get in.
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
      // always registered so its table exists; index.ts hides the routes when passkeys are off
      passkey({
        rpID: login.passkey?.rpID ?? "localhost",
        rpName: "Obtion",
        origin: login.passkey?.origin ?? null,
        // Without a session a passkey creates an account, and only one checked before
        // (startPasskeySignup). With one it is added to that account; index.ts wants a recent sign-in
        // for that, as Better Auth's own check is off along with requireSession.
        registration: {
          requireSession: false,
          resolveUser: ({ context }) => {
            const s = accounts.passkeySignup(context);
            if (!s) throw new APIError("UNAUTHORIZED", { message: "sign in", code: "SESSION_REQUIRED" });
            return { id: s.id, name: s.email, displayName: s.name };
          },
          afterVerification: async ({ ctx, user, context }) => {
            if (!context) {
              // options asked for while signed in, the answer sent without the session
              if (!(await getSessionFromCtx(ctx))) throw new APIError("UNAUTHORIZED", { message: "sign in", code: "SESSION_REQUIRED" });
              return;
            }
            const s = accounts.passkeySignup(context, true);
            if (!s || s.id !== user.id) throw new APIError("BAD_REQUEST", { message: "sign up again", code: "SIGNUP_EXPIRED" });
            // the address may have become an account meanwhile
            if (await ctx.context.internalAdapter.findUserByEmail(s.email)) throw new APIError("UNPROCESSABLE_ENTITY", { message: "exists", code: "USER_ALREADY_EXISTS" });
            // the user hooks check the sign-up rules again and join the invite (cookie, as for codes)
            await ctx.context.internalAdapter.createUser({ id: s.id, email: s.email, name: s.name, emailVerified: false }, { method: "passkey" });
            return { userId: s.id };
          },
        },
      }),
      ...(login.sendCode
        ? [
            emailOTP({
              expiresIn: 10 * 60,
              storeOTP: "hashed",
              sendVerificationOTP: async ({ email, otp, type }, ctx) => {
                if (type !== "sign-in") return;
                // a code for an address without an account only where it may become one
                const known = !!accounts.db.query('SELECT 1 FROM "user" WHERE email = ?').get(email.toLowerCase());
                const signup = signupContext(ctx?.headers);
                if (!known && !accounts.canSignUp(signup.invite, email)) return;
                await login.sendCode!(email, otp, signup.lang);
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

/** The way back in on a server without email codes. Signed-in devices stay signed in. */
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
 * For turning codes on after people signed up with passwords: their first code then revokes nothing
 * (see the user update hook). Only safe if the admin knows the accounts are those people's.
 */
export function trustEmails(dataDir: string): number {
  const db = new Database(join(dataDir, "accounts.db"));
  try {
    return db.query('UPDATE "user" SET emailVerified = 1 WHERE emailVerified = 0').run().changes;
  } finally {
    db.close();
  }
}

export function workspaceDirs(dataDir: string): string[] {
  const root = join(dataDir, "workspaces");
  return existsSync(root) ? readdirSync(root).map((n) => join(root, n)) : [];
}
