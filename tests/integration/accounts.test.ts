// The accounts database in process, without a server: what deleting an account leaves behind.
import { test, expect, afterAll } from "bun:test";
import { tempDir, removeTempDirs } from "../support/helpers";
import { Accounts } from "@obtion/server/accounts";

afterAll(removeTempDirs);

test("a co-owner can delete their account, including admin and credential records", async () => {
  const accounts = new Accounts(tempDir("obtion-account-delete-"), { secret: "a-test-secret-longer-than-thirty-two-characters", baseURL: "http://localhost:8480", policy: "open" });
  try {
    await accounts.init(() => "Personal");
    const first = await accounts.signUp({ email: "first@example.org", name: "First", password: "geheim12345" });
    const workspace = accounts.createWorkspace(first.user.id, "Personal");
    const invite = accounts.createInvite(workspace.id, first.user.id);
    const second = await accounts.signUp({ email: "second@example.org", name: "Second", password: "geheim12345", invite });
    accounts.db.query("UPDATE members SET role = 'owner' WHERE user = ?").run(second.user.id);
    expect(accounts.isAdmin(first.user.id)).toBe(true);
    await accounts.deleteAccount(first.user.id, "geheim12345");
    expect(accounts.isAdmin(first.user.id)).toBe(false);
    expect(accounts.userCount()).toBe(1);
    expect(accounts.members(workspace.id).map((m) => m.id)).toEqual([second.user.id]);
    expect(accounts.exists(workspace.id)).toBe(true);
    for (const table of ["session", "account"])
      expect(accounts.db.query(`SELECT 1 FROM "${table}" WHERE userId = ?`).get(first.user.id)).toBeNull();
  } finally { accounts.db.close(); }
});

test("changing the password needs the current one and ends every other session", async () => {
  const accounts = new Accounts(tempDir("obtion-account-password-"), { secret: "a-test-secret-longer-than-thirty-two-characters", baseURL: "http://localhost:8480", policy: "open" });
  try {
    await accounts.init(() => "Personal");
    const here = await accounts.signUp({ email: "me@example.org", name: "Me", password: "geheim12345" });
    const other = await accounts.auth.api.signInEmail({ body: { email: "me@example.org", password: "geheim12345" } });
    await expect(accounts.changePassword(here.user.id, here.token, "falsch12345", "neues-geheim")).rejects.toThrow("invalid password");
    await expect(accounts.changePassword(here.user.id, here.token, "geheim12345", "kurz")).rejects.toThrow("password too short");
    expect(await accounts.userOf(other.token)).not.toBeNull();
    await accounts.changePassword(here.user.id, here.token, "geheim12345", "neues-geheim");
    expect((await accounts.userOf(here.token))?.id).toBe(here.user.id);
    expect(await accounts.userOf(other.token)).toBeNull();
    await expect(accounts.auth.api.signInEmail({ body: { email: "me@example.org", password: "geheim12345" } })).rejects.toThrow();
    expect((await accounts.auth.api.signInEmail({ body: { email: "me@example.org", password: "neues-geheim" } })).user.id).toBe(here.user.id);
  } finally { accounts.db.close(); }
});

test("a new or joined workspace comes first; each account keeps its own order", async () => {
  const accounts = new Accounts(tempDir("obtion-account-order-"), { secret: "a-test-secret-longer-than-thirty-two-characters", baseURL: "http://localhost:8480", policy: "open" });
  try {
    await accounts.init(() => "Personal");
    const me = await accounts.signUp({ email: "me@example.org", name: "Me", password: "geheim12345" });
    const other = await accounts.signUp({ email: "other@example.org", name: "Other", password: "geheim12345" });
    const names = (user: string) => accounts.workspacesOf(user).map((w) => w.name);
    const a = accounts.createWorkspace(me.user.id, "A");
    const b = accounts.createWorkspace(me.user.id, "B");
    const c = accounts.createWorkspace(me.user.id, "C");
    expect(names(me.user.id)).toEqual(["C", "B", "A"]);
    accounts.reorder(me.user.id, [a.id, c.id, b.id]);
    expect(names(me.user.id)).toEqual(["A", "C", "B"]);
    // made by someone else and joined later: on top
    const theirs = accounts.createWorkspace(other.user.id, "Theirs");
    accounts.join(accounts.createInvite(theirs.id, other.user.id), me.user.id);
    expect(names(me.user.id)).toEqual(["Theirs", "A", "C", "B"]);
    // a list that misses one (joined since) keeps that one on top; unknown ids are ignored
    accounts.reorder(me.user.id, [b.id, a.id, "nope", c.id]);
    expect(names(me.user.id)).toEqual(["Theirs", "B", "A", "C"]);
    expect(names(other.user.id)).toEqual(["Theirs"]);
  } finally { accounts.db.close(); }
});

test("MCP tokens from before they were exclusive: at the next start only the newest per member and workspace stays", async () => {
  const dir = tempDir("obtion-account-mcp-");
  const opts = { secret: "a-test-secret-longer-than-thirty-two-characters", baseURL: "http://localhost:8480", policy: "open" as const };
  const accounts = new Accounts(dir, opts);
  await accounts.init(() => "Personal");
  const me = await accounts.signUp({ email: "me@example.org", name: "Me", password: "geheim12345" });
  const a = accounts.createWorkspace(me.user.id, "A");
  const b = accounts.createWorkspace(me.user.id, "B");
  const inB = accounts.mcpToken(b.id, me.user.id);
  // as an older server left them: several valid MCP tokens for one workspace
  const tokens = ["obt_alt", "obt_mittel", "obt_neu"];
  tokens.forEach((t, i) => accounts.db.query("INSERT INTO tokens (hash, user, workspace, label, created) VALUES (?, ?, ?, 'mcp', ?)").run(new Bun.CryptoHasher("sha256").update(t).digest("hex"), me.user.id, a.id, i + 1));
  for (const t of tokens) expect(accounts.mcpUser(a.id, t)?.id).toBe(me.user.id);
  accounts.db.close();
  const again = new Accounts(dir, opts);
  try {
    expect(again.mcpUser(a.id, "obt_alt")).toBeUndefined();
    expect(again.mcpUser(a.id, "obt_mittel")).toBeUndefined();
    expect(again.mcpUser(a.id, "obt_neu")?.id).toBe(me.user.id);
    expect(again.mcpUser(b.id, inB)?.id).toBe(me.user.id);
  } finally { again.db.close(); }
});
