// The workspace part of the address. Its own module so accounts.ts can use it without importing
// hooks.ts, which itself needs accounts.ts.

/** "#/w/<workspace>/i/<id>?x" → { space, rest: "/i/<id>?x" } */
export function parseHash(hash = location.hash): { space?: string; rest: string } {
	const raw = hash.replace(/^#/, "");
	const named = /^\/w\/([^/?]+)/.exec(raw);
	return { space: named?.[1], rest: (named ? raw.slice(named[0].length) : raw) || "/" };
}

export function spaceHref(space: string | undefined, path: string) {
	return space ? `#/w/${space}${path}` : `#${path}`;
}

export function navigate(path: string, opts: { space?: string; replace?: boolean } = {}) {
	const href = spaceHref(opts.space, path);
	if (opts.replace) location.replace(href);
	else location.hash = href;
}
