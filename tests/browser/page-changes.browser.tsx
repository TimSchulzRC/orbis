// "Changes" in the updates panel: the changes to this one page from the server's log, by day, with
// the live ones; an update there is one line; a failed load says so and can be tried again. The
// tests run in German, so the panel's labels below are German.
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { useState } from "react";
import { appendUpdate } from "@obtion/core/model";
import type { ActivityEvent } from "@obtion/core/protocol";
import { SYS } from "@obtion/core/setup";
import * as accounts from "../../packages/ui/src/accounts";
import { ItemPage } from "../../packages/ui/src/views/ItemPage";
import { workspace } from "./workspace";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.mocked(accounts.spaceCall).mockReset();
});

const event = (id: number, doc: string, e: Partial<ActivityEvent>): ActivityEvent => ({ id, ts: Date.now() - (100 - id) * 60_000, doc, title: "Relaunch", type: SYS.project, kind: "updated", origin: "web:Test;u=u-test", changes: [], ...e });

test("the changes of this page: by day, named as the updates are, an update in one line", async () => {
  const repo = await workspace(false);
  const project = repo.create({ title: "Relaunch", type: SYS.project, pinned: "a" });
  // twice the same text: the line leads to the one it wrote, by its id
  repo.change(project, (d) => appendUpdate(d, { at: Date.now() - 7200_000, text: "Kickoff war gut.", by: "you" }));
  repo.change(project, (d) => appendUpdate(d, { at: Date.now(), text: "Kickoff war gut.", by: "you" }));
  await expect.poll(() => repo.get(project)?.updates.length).toBe(2);
  const [older] = repo.get(project)!.updates;
  const asked: string[] = [];
  vi.mocked(accounts.spaceCall).mockImplementation(async (_space, path) => {
    asked.push(path);
    return [
      event(3, project, { changes: [{ field: "update", to: "Kickoff war gut.", id: older!.id }] }),
      event(2, project, { origin: "agent:claude-code;u=u-test;n=Test", changes: [{ field: "title", from: "Relaunch alt", to: "Relaunch" }] }),
      event(1.5, project, { changes: [{ field: "update", from: "Vertippt.", id: "gone" }] }),
      event(1, project, { kind: "created" }),
      // another page's: never shown here
      event(0, "other", { kind: "created" }),
    ] as never;
  });
  await render(<ItemPage id={project} isNew={false} />);
  await page.getByRole("button", { name: /Letztes Update/ }).click();
  // the head counts the updates, in either view
  const panel = page.getByRole("dialog", { name: /^Updates zu / });
  await panel.getByRole("radio", { name: "Änderungen" }).click();

  await expect.element(panel.getByText("umbenannt: „Relaunch alt“ → „Relaunch“")).toBeVisible();
  expect(asked[0]).toContain(`doc=${project}`);
  await expect.element(panel.getByText("Seite angelegt")).toBeVisible();
  // a deleted update stays here, struck through, with no way to it
  await expect.element(panel.getByText("Vertippt.")).toBeVisible();
  expect(panel.getByRole("button", { name: /Vertippt/ }).query()).toBeNull();
  expect(panel.getByText("Seite angelegt").all()).toHaveLength(1);
  await expect.element(panel.getByText("Claude")).toBeVisible();
  await expect.element(panel.getByText("Du", { exact: true }).first()).toBeVisible();
  await expect.element(panel.getByRole("heading", { name: "Heute" })).toBeVisible();


  // a change arriving live joins at the top
  // (as the server's "event" message does it)
  repo.events = [event(4, project, { changes: [{ field: "tags", to: ["web"], from: [] }] }), ...repo.events];
  (repo as unknown as { emit(): void }).emit();
  await expect.element(panel.getByText("getaggt #web")).toBeVisible();

  // the update's line leads to it in the updates: focused, marked a moment
  await panel.getByRole("button", { name: /Kickoff war gut\. – Update zeigen/ }).click();
  await expect.element(panel.getByRole("radio", { name: /^Updates/ })).toBeChecked();
  const shown = document.activeElement!.closest<HTMLElement>("[data-update]")!;
  expect(shown.dataset.update).toBe(older!.id);
  expect(shown.hasAttribute("data-flash")).toBe(true);
  await expect.poll(() => shown.hasAttribute("data-flash"), { timeout: 3000 }).toBe(false);
  await panel.getByRole("button", { name: "Schließen" }).click();
});

test("not loaded: says so, and asks again for the same", async () => {
  const repo = await workspace(false);
  const project = repo.create({ title: "Newsletter", type: SYS.project, pinned: "a" });
  vi.mocked(accounts.spaceCall).mockRejectedValueOnce(new Error("offline")).mockResolvedValue([event(1, project, { kind: "created" })] as never);
  await render(<ItemPage id={project} isNew={false} />);
  await page.getByRole("button", { name: "Erstes Update schreiben" }).click();
  const panel = page.getByRole("dialog", { name: /^Updates zu / });
  await panel.getByRole("radio", { name: "Änderungen" }).click();
  await expect.element(panel.getByText("Die Änderungen liegen auf deinem Server.", { exact: false })).toBeVisible();
  await panel.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect.element(panel.getByText("Seite angelegt")).toBeVisible();
  await panel.getByRole("button", { name: "Schließen" }).click();
});

test("older changes load below, until the log ends; a failed load is asked for again", async () => {
  const repo = await workspace(false);
  const project = repo.create({ title: "Archiv", type: SYS.project, pinned: "a" });
  const page1 = Array.from({ length: 50 }, (_, n) => event(200 - n, project, { changes: [{ field: "tags", to: [`t${200 - n}`], from: [] }] }));
  const asked: string[] = [];
  vi.mocked(accounts.spaceCall).mockImplementation(async (_space, path) => {
    asked.push(path);
    // the first try below fails, the second answers
    if (path.includes("before=151") && asked.filter((p) => p.includes("before=151")).length > 1) return [event(10, project, { kind: "created" })] as never;
    throw new Error("down");
  });
  vi.mocked(accounts.spaceCall).mockImplementationOnce(async (_s, path) => (asked.push(path), page1 as never));
  await render(<ItemPage id={project} isNew={false} />);
  await page.getByRole("button", { name: "Erstes Update schreiben" }).click();
  const panel = page.getByRole("dialog", { name: /^Updates zu / });
  await panel.getByRole("radio", { name: "Änderungen" }).click();
  await expect.element(panel.getByText("getaggt #t200")).toBeInTheDocument();
  await panel.getByRole("button", { name: "Ältere laden" }).click();
  // failed: what is there stays, and trying again asks for the same rows
  await expect.element(panel.getByText("Nicht alles geladen.", { exact: false })).toBeVisible();
  await expect.element(panel.getByText("getaggt #t200")).toBeInTheDocument();
  await panel.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect.element(panel.getByText("Seite angelegt")).toBeInTheDocument();
  expect(asked.slice(1)).toEqual([expect.stringContaining("before=151"), expect.stringContaining("before=151")]);
  // the whole log is there: no more to load
  expect(panel.getByRole("button", { name: "Ältere laden" }).query()).toBeNull();
  await panel.getByRole("button", { name: "Schließen" }).click();
});

test("the view chosen stays for the next opening", async () => {
  const repo = await workspace(false);
  const project = repo.create({ title: "Newsletter", type: SYS.project, pinned: "a" });
  vi.mocked(accounts.spaceCall).mockResolvedValue([event(1, project, { kind: "created" })] as never);
  await render(<ItemPage id={project} isNew={false} />);
  await page.getByRole("button", { name: "Erstes Update schreiben" }).click();
  await page.getByRole("dialog").getByRole("radio", { name: "Änderungen" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Erstes Update schreiben" }).click();
  await expect.element(page.getByRole("dialog").getByRole("radio", { name: "Änderungen" })).toBeChecked();
  await expect.element(page.getByRole("dialog").getByText("Seite angelegt")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

test("a late answer for the page before never shows on the next one", async () => {
  await page.viewport(1440, 900);
  const repo = await workspace(false);
  const first = repo.create({ title: "Relaunch", type: SYS.project, pinned: "a" });
  const second = repo.create({ title: "Website", type: SYS.project, pinned: "b" });
  // the first page's answer comes only when let go
  let release: () => void = () => {};
  vi.mocked(accounts.spaceCall).mockImplementation((_s, path) =>
    path.includes(first)
      ? new Promise((done) => (release = () => done([event(1, first, { changes: [{ field: "tags", to: ["alt"], from: [] }] })] as never)))
      : Promise.resolve([event(2, second, { kind: "created" })] as never),
  );
  let go: (id: string) => void = () => {};
  function Shown() {
    const [id, setId] = useState(first);
    go = setId;
    return <ItemPage id={id} isNew={false} />;
  }
  await render(<Shown />);
  await page.getByRole("button", { name: "Erstes Update schreiben" }).click();
  await page.getByRole("dialog").getByRole("radio", { name: "Änderungen" }).click();
  // docked, the panel stays open on the next page; the first answer arrives after
  go(second);
  await expect.element(page.getByRole("dialog").getByText("Seite angelegt")).toBeVisible();
  release();
  await new Promise((r) => setTimeout(r, 100));
  expect(page.getByRole("dialog").getByText("getaggt #alt").query()).toBeNull();
  await page.getByRole("dialog").getByRole("button", { name: "Schließen" }).click();
  await page.viewport(1280, 900);
});
