// Opens the command palette (App listens), optionally with a query typed in.
export const openPalette = (query = "") =>
	dispatchEvent(new CustomEvent("orbis:palette", { detail: query }));
