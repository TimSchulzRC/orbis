// Signing in without a password: codes by email, the sign-up rules for every way in, the OAuth
// cookie traded for a token, deleting an account that has no password.
import { test, expect, afterAll } from "bun:test";
import { tempDir, removeTempDirs } from "../support/helpers";
import { Accounts, SIGNUP_COOKIE, setPassword, trustEmails } from "@obtion/server/accounts";
import type { SignupPolicy } from "@obtion/core/api";

afterAll(removeTempDirs);

const SECRET = "a-test-secret-longer-than-thirty-two-characters";
// Better Auth limits requests per address (in memory, across instances): every test its own
let address = 0;

async function setUp(policy: SignupPolicy, opts: { password?: boolean } = {}) {
  const codes: { to: string; code: string; lang?: string }[] = [];
  const accounts = new Accounts(tempDir("obtion-login-"), {
    secret: SECRET,
    baseURL: "http://localhost:8480",
    policy,
    login: { password: opts.password ?? true, oauth: [], sendCode: async (to, code, lang) => void codes.push({ to, code, lang }) },
  });
  await accounts.init(() => "Personal");
  const ip = `10.0.0.${++address}`;
  /** A request of the app's page to Better Auth, as the server passes it on. */
  const call = (path: string, body: unknown, ctx?: { invite?: string; lang?: string }) =>
    accounts.auth.handler(
      new Request("http://localhost:8480/api/auth" + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip, origin: "http://localhost:8480", ...(ctx ? { cookie: `${SIGNUP_COOKIE}=${encodeURIComponent(JSON.stringify(ctx))}` } : {}) },
        body: JSON.stringify(body),
      }),
    );
  /** Ask for a code and sign in with it; the response of the sign-in. */
  async function withCode(email: string, ctx?: { invite?: string; lang?: string }, name?: string) {
    const before = codes.length;
    expect((await call("/email-otp/send-verification-otp", { email, type: "sign-in" }, ctx)).status).toBe(200);
    const sent = codes.slice(before).find((c) => c.to === email);
    if (!sent) return undefined;
    return call("/sign-in/email-otp", { email, otp: sent.code, name }, ctx);
  }
  return { accounts, codes, call, withCode };
}

test("the first account signs up with a code (the email in its language) and becomes admin, without a workspace until it creates one", async () => {
  const { accounts, withCode, codes } = await setUp("off");
  try {
    const res = await withCode("me@example.org", { lang: "en" }, "Me");
    expect(res!.status).toBe(200);
    const { token, user } = (await res!.json()) as { token: string; user: { id: string; name: string } };
    expect(user.name).toBe("Me");
    expect(codes[0]!.lang).toBe("en");
    expect((await accounts.session(token))?.user.id).toBe(user.id);
    expect(accounts.isAdmin(user.id)).toBe(true);
    expect(accounts.workspacesOf(user.id)).toEqual([]);
    expect(await accounts.hasPassword(user.id)).toBe(false);
    // and signs in again with a new code: the same account
    const again = await withCode("me@example.org");
    expect(again!.status).toBe(200);
    expect(accounts.userCount()).toBe(1);
  } finally { accounts.db.close(); }
});

test("a wrong code does not sign in", async () => {
  const { accounts, call, codes } = await setUp("open");
  try {
    await call("/email-otp/send-verification-otp", { email: "me@example.org", type: "sign-in" });
    const wrong = codes[0]!.code === "000000" ? "111111" : "000000";
    expect((await call("/sign-in/email-otp", { email: "me@example.org", otp: wrong })).status).toBe(400);
    expect(accounts.userCount()).toBe(0);
  } finally { accounts.db.close(); }
});

test("sign-up by code follows the policy: no code for a stranger, the invite joins its workspace", async () => {
  const { accounts, withCode } = await setUp("invite");
  try {
    const first = (await (await withCode("owner@example.org"))!.json()) as { user: { id: string } };
    const space = accounts.createWorkspace(first.user.id, "Persönlich");
    // without an invite no code is sent to an address without an account
    expect(await withCode("stranger@example.org")).toBeUndefined();
    expect(accounts.userCount()).toBe(1);
    const invite = accounts.createInvite(space.id, first.user.id);
    const res = await withCode("guest@example.org", { invite });
    const guest = (await res!.json()) as { user: { id: string } };
    expect(accounts.workspacesOf(guest.user.id).map((w) => w.id)).toEqual([space.id]);
    expect(accounts.isAdmin(guest.user.id)).toBe(false);
  } finally { accounts.db.close(); }
});

test("a user Better Auth would create without the right is refused (OAuth, codes alike)", async () => {
  const { accounts, withCode } = await setUp("off");
  try {
    await withCode("owner@example.org");
    expect(() => accounts.allowNewUser(new Headers())).toThrow("signup closed");
    expect(() => accounts.allowNewUser(new Headers({ cookie: `${SIGNUP_COOKIE}=${encodeURIComponent(JSON.stringify({ invite: "nope" }))}` }))).toThrow("invite invalid");
  } finally { accounts.db.close(); }
});

test("an existing password account signs in by code too", async () => {
  const { accounts, withCode } = await setUp("open");
  try {
    const signed = await accounts.signUp({ name: "Pw", email: "pw@example.org", password: "geheim12345" });
    const res = await withCode("pw@example.org");
    expect(((await res!.json()) as { user: { id: string } }).user.id).toBe(signed.user.id);
  } finally { accounts.db.close(); }
});

test("with passwords off there is no password sign-up", async () => {
  const { accounts, call } = await setUp("open", { password: false });
  try {
    await expect(accounts.signUp({ name: "Pw", email: "pw@example.org", password: "geheim12345" })).rejects.toThrow("passwords off");
    expect((await call("/sign-in/email", { email: "pw@example.org", password: "geheim12345" })).status).toBeGreaterThanOrEqual(400);
  } finally { accounts.db.close(); }
});

test("an account without a password is deleted after a recent sign-in only", async () => {
  const { accounts, withCode } = await setUp("open");
  try {
    const { token, user } = (await (await withCode("me@example.org"))!.json()) as { token: string; user: { id: string } };
    const session = (await accounts.session(token))!;
    await expect(accounts.deleteAccount(user.id, undefined, session.created - 11 * 60_000)).rejects.toThrow("sign in again");
    await expect(accounts.deleteAccount(user.id, "geheim12345", session.created)).rejects.toThrow("invalid password");
    await accounts.deleteAccount(user.id, undefined, session.created);
    expect(accounts.userCount()).toBe(0);
  } finally { accounts.db.close(); }
});

test("the session an OAuth callback leaves in a cookie is traded for its token", async () => {
  const { accounts, withCode } = await setUp("open");
  try {
    const res = (await withCode("me@example.org"))!;
    const { token } = (await res.json()) as { token: string };
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");
    expect((await accounts.claim(new Headers({ cookie })))?.token).toBe(token);
    expect(await accounts.claim(new Headers())).toBeNull();
  } finally { accounts.db.close(); }
});

test("the CLI gives an account a new password, also one that never had one", async () => {
  const { accounts, withCode } = await setUp("open");
  const dir = accounts.dataDir;
  try {
    await withCode("me@example.org");
  } finally { accounts.db.close(); }
  await setPassword(dir, "Me@example.org", "neues-passwort");
  const again = new Accounts(dir, { secret: SECRET, baseURL: "http://localhost:8480", policy: "open" });
  try {
    const ok = await again.auth.api.signInEmail({ body: { email: "me@example.org", password: "neues-passwort" } });
    expect(ok.user.email).toBe("me@example.org");
    expect(await again.hasPassword(ok.user.id)).toBe(true);
  } finally { again.db.close(); }
  await expect(setPassword(dir, "nobody@example.org", "neues-passwort")).rejects.toThrow("No account");
  await expect(setPassword(dir, "me@example.org", "kurz")).rejects.toThrow("8 to 128");
});

test("a code proving an unproven address drops the passkeys, agent tokens, invite links and connections someone else may have made; a proven account keeps its own", async () => {
  const { accounts, withCode } = await setUp("open");
  const addPasskey = (userId: string, id: string) =>
    accounts.db.query("INSERT INTO passkey (id, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES (?, 'k', ?, ?, 0, 'singleDevice', 0, ?)").run(id, userId, id, new Date().toISOString());
  const keys = (userId: string) => (accounts.db.query("SELECT id FROM passkey WHERE userId = ?").all(userId) as { id: string }[]).map((r) => r.id);
  try {
    // someone signs up with the victim's address and a password, and adds a passkey
    const squatter = await accounts.signUp({ name: "Eve", email: "victim@example.org", password: "geheim12345" });
    addPasskey(squatter.user.id, "eve-key");
    const space = accounts.createWorkspace(squatter.user.id, "Persönlich").id;
    accounts.mcpToken(space, squatter.user.id);
    accounts.createInvite(space, squatter.user.id);
    const revoked: string[] = [];
    accounts.onRevoke = (user) => void revoked.push(user);
    // the owner of the mailbox signs in by code: the account is theirs now, without Eve's ways in
    const res = await withCode("victim@example.org");
    expect(((await res!.json()) as { user: { id: string } }).user.id).toBe(squatter.user.id);
    expect(keys(squatter.user.id)).toEqual([]);
    expect(await accounts.hasPassword(squatter.user.id)).toBe(false);
    expect(accounts.db.query("SELECT 1 FROM tokens WHERE user = ?").all(squatter.user.id)).toEqual([]);
    expect(accounts.db.query('SELECT 1 FROM invites WHERE "by" = ?').all(squatter.user.id)).toEqual([]);
    expect(revoked).toEqual([squatter.user.id]);
    // their own passkey stays through the next code
    addPasskey(squatter.user.id, "own-key");
    await withCode("victim@example.org");
    expect(keys(squatter.user.id)).toEqual(["own-key"]);
  } finally { accounts.db.close(); }
});

test("where codes are on, an account with a password proves its address before it exists", async () => {
  const { accounts, call, codes } = await setUp("open");
  const me = { name: "Me", email: "me@example.org", password: "geheim12345" };
  try {
    // the details first: nothing is made yet, the page has a code sent
    expect(await accounts.signUpWithCode(me)).toEqual({ verify: true });
    expect(accounts.db.query('SELECT 1 FROM "user"').all()).toEqual([]);
    expect((await call("/email-otp/send-verification-otp", { email: me.email, type: "sign-in" })).status).toBe(200);
    await expect(accounts.signUpWithCode({ ...me, code: "000000" })).rejects.toThrow("invalid code");
    const signed = await accounts.signUpWithCode({ ...me, code: codes.at(-1)!.code });
    if (!("token" in signed)) throw new Error("no token");
    expect((await accounts.session(signed.token))?.user.email).toBe(me.email);
    expect(await accounts.hasPassword(signed.user.id)).toBe(true);
    expect(accounts.db.query('SELECT emailVerified FROM "user" WHERE id = ?').get(signed.user.id)).toEqual({ emailVerified: 1 });
    expect((await call("/sign-in/email", { email: me.email, password: me.password })).status).toBe(200);
    // the address is taken now; too short a password is said before any code
    await expect(accounts.signUpWithCode(me)).rejects.toThrow("exists");
    await expect(accounts.signUpWithCode({ ...me, email: "other@example.org", password: "kurz" })).rejects.toThrow("password too short");
  } finally { accounts.db.close(); }
});

test("trust-emails: accounts from before codes keep their password through their first code", async () => {
  const { accounts, withCode } = await setUp("open");
  const dir = accounts.dataDir;
  try {
    const old = await accounts.signUp({ name: "Old", email: "old@example.org", password: "geheim12345" });
    expect(trustEmails(dir)).toBe(1);
    expect(trustEmails(dir)).toBe(0);
    expect((await withCode("old@example.org"))!.status).toBe(200);
    expect(await accounts.hasPassword(old.user.id)).toBe(true);
    expect((await accounts.session(old.token))?.user.id).toBe(old.user.id);
  } finally { accounts.db.close(); }
});
