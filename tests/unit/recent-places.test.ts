// "Zuletzt verwendet" for places: one list on the device, read per workspace.
import { afterAll, expect, test } from "bun:test";

// actions.ts belongs to the web app: just enough browser for it to load
const g = globalThis as any;
const stubs: Record<string, unknown> = {
	window: g,
	document: { documentElement: {} },
	location: { hash: "", origin: "http://localhost" },
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	localStorage: (() => {
		const m = new Map<string, string>();
		return {
			getItem: (k: string) => m.get(k) ?? null,
			setItem: (k: string, v: string) => void m.set(k, v),
		};
	})(),
};
const before = Object.fromEntries(Object.keys(stubs).map((k) => [k, g[k]]));
Object.assign(g, stubs);
// by a path in a variable: the root typecheck stays out of the web app (vite imports)
const actions = "../../packages/ui/src/actions";
const {
	recentPlaces,
	rememberPlace,
}: { recentPlaces: (repo: unknown) => string[]; rememberPlace: (id: string) => void } =
	await import(actions);
afterAll(() => {
	for (const [k, v] of Object.entries(before)) v === undefined ? delete g[k] : (g[k] = v);
});

const space = (...ids: string[]) => ({
	index: () => ({ get: (id: string) => (ids.includes(id) ? { id, kind: "note" } : undefined) }),
});

test("a place remembered in one workspace keeps the other workspace's list", () => {
	const a = space("a1", "a2");
	const b = space("b1");
	rememberPlace("a1");
	rememberPlace("a2");
	rememberPlace("b1");
	expect(recentPlaces(a)).toEqual(["a2", "a1"]);
	expect(recentPlaces(b)).toEqual(["b1"]);
	rememberPlace("a1");
	expect(recentPlaces(a)).toEqual(["a1", "a2"]);
});
