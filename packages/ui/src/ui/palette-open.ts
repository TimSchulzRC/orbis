// Opens the command palette (App listens), optionally with a query typed in.
export const openPalette = (query = "") => dispatchEvent(new CustomEvent("obtion:palette", { detail: query }));
