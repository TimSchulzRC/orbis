// Back and forward in the app's bar: they step through the pages opened and are off at either end.

import { afterEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { HistoryButtons } from "../../packages/ui/src/ui/HistoryButtons";

afterEach(() => cleanup());

test("back and forward step through the pages opened; forward is off on the newest", async () => {
	location.hash = "#/activity";
	location.hash = "#/trash";
	await render(<HistoryButtons forward />);
	const back = page.getByRole("button", { name: "Zurück" });
	const forward = page.getByRole("button", { name: "Vor" });
	await expect.element(back).toBeEnabled();
	await expect.element(forward).toBeDisabled();

	await back.click();
	await expect.poll(() => location.hash).toBe("#/activity");
	await expect.element(forward).toBeEnabled();

	await forward.click();
	await expect.poll(() => location.hash).toBe("#/trash");
	await expect.element(forward).toBeDisabled();
});
