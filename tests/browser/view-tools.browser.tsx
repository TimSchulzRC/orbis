// A view's filter, sort and grouping, set as in Notion: a filter is a pill per property whose
// popover takes comparison and value; sorting and grouping are pages of the view's menu.

import type { ViewTab } from "@obtion/core/model";
import type { Cond } from "@obtion/core/query";
import { SYS } from "@obtion/core/setup";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { ScopeContext } from "../../packages/ui/src/scope";
import { QueryEditor } from "../../packages/ui/src/ui/QueryEditor";
import { useViewFields, ViewSettings } from "../../packages/ui/src/ui/Views";
import { noFiles, workspace } from "./workspace";

afterEach(() => cleanup());

let where: Cond | undefined;
let look: Partial<ViewTab> = {};

function Tools({ start }: { start?: Cond }) {
	const fields = useViewFields({ type: SYS.task });
	const [cond, setCond] = useState(start);
	const [tab, setTab] = useState<ViewTab>({ id: "t", pos: "a", kind: "table" });
	where = cond;
	look = tab;
	return (
		<>
			<QueryEditor bare def={{ where: cond }} fields={fields} onChange={(d) => setCond(d.where)} />
			<ViewSettings fields={fields} onLook={(p) => setTab({ ...tab, ...p })} tab={tab} />
		</>
	);
}

async function setup(start?: Cond) {
	const repo = await workspace();
	await render(
		<ScopeContext.Provider value={{ id: "w1", repo, files: noFiles }}>
			<Tools start={start} />
		</ScopeContext.Provider>,
	);
}
const button = (name: string | RegExp) => page.getByRole("button", { name });

test("a filter on a property: pick it, then its values; several mean one of them", async () => {
	await setup();
	await button("Filter").click();
	await button("Priorität").click();
	// the new pill is open at once and filters nothing before it has a value
	expect(where).toEqual({ prop: "Priorität", op: ":" });
	await button("Hoch").click();
	expect(where).toEqual({ prop: "Priorität", op: ":", value: "Hoch" });
	await button("Mittel").click();
	expect(where).toEqual({
		or: [
			{ prop: "Priorität", op: ":", value: "Hoch" },
			{ prop: "Priorität", op: ":", value: "Mittel" },
		],
	});
	await expect.element(button(/Priorität: Hoch, Mittel/)).toBeVisible();
});

test("the comparison changes in the pill: is not, is empty", async () => {
	await setup({ prop: "Priorität", op: ":", value: "Hoch" });
	await button(/Priorität: Hoch/).click();
	await button("Vergleich ändern").click();
	await page.getByRole("button", { name: "ist nicht", exact: true }).click();
	expect(where).toEqual({ prop: "Priorität", op: "!=", value: "Hoch" });
	await button("Vergleich ändern").click();
	await button("ist leer").click();
	expect(where).toEqual({ prop: "Priorität", op: "empty" });
	await expect.element(button(/Priorität ist leer/)).toBeVisible();
	await button("Filter entfernen").click();
	expect(where).toBeUndefined();
});

test("a date compares with a day that moves with today", async () => {
	await setup();
	await button("Filter").click();
	await button("Fällig").click();
	await button("in 7 Tagen").click();
	await button("Vergleich ändern").click();
	await button("bis").click();
	expect(where).toEqual({ prop: "Fällig", op: "<=", value: "+7d" });
});

test("the view's menu leads to grouping and sorting", async () => {
	await setup();
	await button(/Gruppieren/).click();
	await button("Priorität").click();
	expect(look.group).toBe("Priorität");
	await button("Leere Gruppen ausblenden").click();
	expect(look.hideEmpty).toBe(true);
	await button("Gruppieren").click(); // back
	await button(/Sortieren/).click();
	await button("Sortierung hinzufügen").click();
	await button("Fällig").click();
	expect(look.sort).toEqual([{ key: "Fällig" }]);
	await button("aufsteigend").click();
	expect(look.sort).toEqual([{ key: "Fällig", desc: true }]);
	await button("Sortierung löschen").click();
	expect(look.sort).toEqual([]);
});
