// "Add to Excalidraw" on libraries.excalidraw.com sends the browser back here with
// "#addLibrary=<url>&token=…" after the address. The app's own routes live in the hash too, so this
// runs before anything else listens (main.tsx imports it first): it takes the link out, puts the
// address back and hands the library to the drawings (Drawing.tsx).

const KEY = "addLibrary";
let pending: string[] = [];
let handler: ((url: string) => void) | null = null;

function take(hash: string): string | null {
	const url = new URLSearchParams(hash.replace(/^#/, "")).get(KEY);
	return url || null;
}

function hand(url: string) {
	if (handler) handler(url);
	else pending.push(url);
}

// opened in a tab of its own (the drawing's tab was closed): the start page
const first = take(location.hash);
if (first) {
	history.replaceState(history.state, "", location.pathname + location.search + "#/");
	hand(first);
}

addEventListener("hashchange", (e) => {
	const url = take(location.hash);
	if (!url) return;
	// the page stays as it was: no route, workspace or open drawing sees this address
	e.stopImmediatePropagation();
	history.replaceState(history.state, "", (e as HashChangeEvent).oldURL);
	hand(url);
});

/** Libraries waiting from before, and every one that comes later. */
export function onLibraryLink(fn: (url: string) => void) {
	handler = fn;
	const waiting = pending;
	pending = [];
	waiting.forEach(fn);
}
