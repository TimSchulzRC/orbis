// A page shows its type's properties in the order "Typ bearbeiten" gives them: the badges (status,
// single selections) in a row at the top, everything else (dates too) as rows below, each in order.
import { afterEach, expect, test } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { SYS } from "@obtion/core/setup";
import { keyBetween } from "@obtion/core/sortkey";
import { upsertProp } from "@obtion/core/model";
import { PropertyBlock } from "../../packages/ui/src/ui/Properties";
import { useRepo } from "../../packages/ui/src/hooks";
import { workspace } from "./workspace";

afterEach(() => cleanup());

function Host({ id }: { id: string }) {
  const repo = useRepo();
  const item = repo.get(id)!;
  return <PropertyBlock item={item} schema={repo.index().schemaOf(item)} />;
}

/** The names of the rows, top to bottom. */
const rows = () => [...document.querySelectorAll(".group\\/props .grid > div:nth-child(odd)")].map((e) => e.textContent);
/** The badges' text, left to right ("Backlog", "Priorität"). */
const badges = () => [...document.querySelectorAll(".group\\/props > div:first-child > span.inline-flex")].map((e) => e.textContent);

async function setup() {
  const repo = await workspace(false);
  const id = repo.create({ title: "Relaunch", type: SYS.project });
  await render(<Host id={id} />);
  const props = () => repo.get(SYS.project)!.schema!.properties;
  /** Puts `id` right after `after`. */
  const moveAfter = (id: string, after: string) => {
    const all = props();
    const i = all.findIndex((p) => p.id === after);
    repo.change(SYS.project, (d) => upsertProp(d, id, { sort: keyBetween(all[i]!.sort, all[i + 1]?.sort ?? null) }));
  };
  return { props, moveAfter };
}

test("the rows below follow the type's order; a date is one of them", async () => {
  const { props, moveAfter } = await setup();
  await expect.poll(rows).toEqual(["Zeitraum", "Zusammenfassung", "Blockiert durch"]);
  moveAfter("p_period", props().at(-1)!.id);
  await expect.poll(rows).toEqual(["Zusammenfassung", "Blockiert durch", "Zeitraum"]);
});

test("the badges at the top follow the type's order", async () => {
  const { moveAfter } = await setup();
  await expect.poll(() => badges().map((b) => b?.includes("Priorität"))).toEqual([false, true]);
  moveAfter("p_status", "p_priority");
  await expect.poll(() => badges().map((b) => b?.includes("Priorität"))).toEqual([true, false]);
});
