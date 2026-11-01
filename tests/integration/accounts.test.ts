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
