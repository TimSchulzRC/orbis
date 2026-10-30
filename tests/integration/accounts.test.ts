// The accounts database in process, without a server: what deleting an account leaves behind.
import { test, expect, afterAll } from "bun:test";
import { tempDir, removeTempDirs } from "../support/helpers";
import { Accounts } from "@obtion/server/accounts";

afterAll(removeTempDirs);

test("a co-owner can delete their account, including admin and credential records", async () => {
  const accounts = new Accounts(tempDir("obtion-account-delete-"), { secret: "a-test-secret-longer-than-thirty-two-characters", baseURL: "http://localhost:8480", policy: "open" });
  try {
    await accounts.init(() => "Personal");
    const first = await accounts.signUp({ email: "first@example.org", name: "First", password: "geheim12345", personal: "Personal" });
    const [workspace] = accounts.workspacesOf(first.user.id);
    const invite = accounts.createInvite(workspace!.id, first.user.id);
    const second = await accounts.signUp({ email: "second@example.org", name: "Second", password: "geheim12345", personal: "Personal", invite });
    accounts.db.query("UPDATE members SET role = 'owner' WHERE user = ?").run(second.user.id);
    expect(accounts.isAdmin(first.user.id)).toBe(true);
    await accounts.deleteAccount(first.user.id, "geheim12345");
    expect(accounts.isAdmin(first.user.id)).toBe(false);
    expect(accounts.userCount()).toBe(1);
    expect(accounts.members(workspace!.id).map((m) => m.id)).toEqual([second.user.id]);
    expect(accounts.exists(workspace!.id)).toBe(true);
    for (const table of ["session", "account"])
      expect(accounts.db.query(`SELECT 1 FROM "${table}" WHERE userId = ?`).get(first.user.id)).toBeNull();
  } finally { accounts.db.close(); }
});
