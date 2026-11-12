// Fractional sort keys: a key between any two keys always exists, so two devices can reorder
// offline and the result still merges (ties are broken by id).
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function midpoint(a: string, b: string | null): string {
	if (b !== null) {
		let n = 0;
		while ((a[n] ?? "0") === b[n]) n++;
		if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
	}
	const da = a ? DIGITS.indexOf(a[0]!) : 0;
	const db = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
	if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
	if (b && b.length > 1) return b.slice(0, 1);
	return DIGITS[da]! + midpoint(a.slice(1), null);
}

export function keyBetween(a?: string | null, b?: string | null): string {
	const lo = a ?? "";
	const hi = b ?? null;
	if (hi !== null && lo >= hi) return `${lo}V`; // broken order (concurrent edits): stay after a
	return midpoint(lo, hi);
}

export function keysFor(n: number): string[] {
	const out: string[] = [];
	let prev: string | null = null;
	for (let i = 0; i < n; i++) out.push((prev = keyBetween(prev, null)));
	return out;
}

/** Plain code-unit order, not localeCompare: sort keys and ISO dates need it. */
export function cmpKey(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function nextPinKey(items: Iterable<{ pinned?: string }>): string {
	let last: string | null = null;
	for (const i of items) if (i.pinned && (last === null || i.pinned > last)) last = i.pinned;
	return keyBetween(last, null);
}
