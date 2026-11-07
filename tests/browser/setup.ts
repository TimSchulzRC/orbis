// Before any module of the interface loads: the app in German, signed in with one workspace,
// "ws", whose replica is the workspace in memory (workspace.ts) instead of one that syncs.
import { vi } from "vitest";
import "@obtion/ui/styles.css";

localStorage.clear();
localStorage.setItem("obtion.lang", "de");
localStorage.setItem("obtion.account", JSON.stringify({ token: "test", user: { id: "u-test", name: "Test", email: "test@example.org" } }));
localStorage.setItem("obtion.spaces", JSON.stringify([{ id: "ws", name: "Personal", role: "owner" }]));
localStorage.setItem("obtion.active", "ws");

// accounts.ts as it is, only replica() answers with the workspace in memory. Spied, not replaced
// by a factory: accounts.ts and hooks.ts import each other, and a factory that loads the original
// would wait for itself.
vi.mock("../../packages/ui/src/accounts", { spy: true });
const accounts = await import("../../packages/ui/src/accounts");
const current = await import("../../packages/ui/src/repo");
const { noFiles } = await import("./workspace");
vi.mocked(accounts.replica).mockImplementation(() => ({ repo: current.repo, files: noFiles }));
