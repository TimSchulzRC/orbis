// "Verlauf" on an item page: the versions the server kept, the diff to the previous one and to the
// text now, and restoring one as a new change of its own (the server's answers are faked here).
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import type { HistoryList, TextVersion } from "@obtion/core/api";
import { replaceBody } from "@obtion/core/model";
import { ScopeContext } from "../../packages/ui/src/scope";
import { HistoryDialog } from "../../packages/ui/src/ui/History";
import { AppToaster } from "../../packages/ui/src/ui/toasts";
import { noFiles, workspace } from "./workspace";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TEXTS = ["Ziel\nRechnungen senden\n", "Ziel\nRechnungen senden und empfangen\n", "Ziel\nRechnungen senden und empfangen\n- Testlauf\n"];

/** The server's history API for one item with three versions (by an agent, then by Tim). */
function fakeServer(doc: string) {
  const versions: TextVersion[] = TEXTS.map((t, i) => ({ id: 10 + i, n: i + 1, ts: Date.now() - (3 - i) * 60_000, origin: i ? "web:Tim;u=u1" : "agent:claude-code;u=u1;n=Tim", base: false, len: t.length }));
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input), location.href);
    if (url.pathname !== "/w/w1/api/history" || url.searchParams.get("doc") !== doc) return new Response("{}", { status: 404 });
    const v = url.searchParams.get("version");
    if (v) return Response.json({ text: TEXTS[Number(v) - 10] });
    return Response.json({ versions } satisfies HistoryList);
  });
}

test("lists the versions, shows what changed, and restores one as an undoable step", async () => {
  const repo = await workspace(false);
  const id = repo.create({ title: "Anbindung Musterkunde" });
  repo.change(id, (d) => replaceBody(d, TEXTS[2]!));
  await expect.poll(() => repo.get(id)?.body).toBe(TEXTS[2]);
  fakeServer(id);
  let closed = false;
  await render(
    <ScopeContext.Provider value={{ id: "w1", repo, files: noFiles }}>
      <HistoryDialog item={repo.get(id)!} onClose={() => (closed = true)} />
      <AppToaster />
    </ScopeContext.Provider>,
  );
  // newest first; the newest is the text now
  await expect.element(page.getByRole("button", { name: /Fassung 3 · aktuell/ })).toBeVisible();
  await expect.element(page.getByRole("button", { name: /Fassung 1.*Claude für Tim/ })).toBeVisible();
  // the newest against the one before: one line added
  await expect.element(page.getByText("- Testlauf")).toBeVisible();
  expect(document.querySelectorAll('[data-op="added"]').length).toBe(1);
  expect(document.querySelectorAll('[data-op="removed"]').length).toBe(0);
  expect(page.getByRole("button", { name: "Diese Fassung wiederherstellen" }).query()).toBeNull(); // it is the text now
  // version 1 against the text now
  await page.getByRole("button", { name: /Fassung 1/ }).click();
  await page.getByRole("radio", { name: "Text jetzt" }).click();
  await expect.poll(() => document.querySelectorAll('[data-op="removed"]').length).toBe(1);
  expect(document.querySelectorAll('[data-op="added"]').length).toBe(2);
  // restore: the old text comes back as a change of its own step
  await page.getByRole("button", { name: "Diese Fassung wiederherstellen" }).click();
  expect(closed).toBe(true);
  expect(repo.get(id)!.body).toBe(TEXTS[0]);
  await expect.element(page.getByText("Fassung 1 wiederhergestellt")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Rückgängig" })).toBeVisible();
});

test("without versions or without the server it says so", async () => {
  const repo = await workspace(false);
  const id = repo.create({ title: "Neu" });
  await expect.poll(() => repo.get(id)).toBeTruthy();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ versions: [] }));
  await render(
    <ScopeContext.Provider value={{ id: "w1", repo, files: noFiles }}>
      <HistoryDialog item={repo.get(id)!} onClose={() => {}} />
    </ScopeContext.Provider>,
  );
  await expect.element(page.getByText(/Noch keine früheren Fassungen/)).toBeVisible();
  cleanup();
  vi.restoreAllMocks();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new TypeError("offline");
  });
  await render(
    <ScopeContext.Provider value={{ id: "w1", repo, files: noFiles }}>
      <HistoryDialog item={repo.get(id)!} onClose={() => {}} />
    </ScopeContext.Provider>,
  );
  await expect.element(page.getByText(/Der Verlauf liegt auf deinem Server/)).toBeVisible();
});
