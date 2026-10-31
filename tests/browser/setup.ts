// Before any module of the interface loads: the app in German, signed in with one workspace,
// "ws", whose replica is the workspace in memory (workspace.ts) instead of one that syncs.
import { vi } from "vitest";
import "@obtion/ui/styles.css";

localStorage.clear();
localStorage.setItem("obtion.lang", "de");
localStorage.setItem("obtion.account", JSON.stringify({ token: "test", user: { id: "u-test", name: "Test", email: "test@example.org" } }));
localStorage.setItem("obtion.spaces", JSON.stringify([{ id: "ws", name: "Persönlich", role: "owner" }]));
localStorage.setItem("obtion.active", "ws");

vi.mock("../../packages/ui/src/accounts", async (original) => {
  const current = await import("../../packages/ui/src/repo");
  const { noFiles } = await import("./workspace");
  return { ...(await original<object>()), replica: () => ({ repo: current.repo, files: noFiles }) };
});
