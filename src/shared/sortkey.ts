// Fractional sort keys: a key between any two keys always exists, so two devices
// can reorder offline and the result still merges (ties are broken by id).
const D = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? D.indexOf(a[0]!) : 0;
  const db = b !== null ? D.indexOf(b[0]!) : D.length;
  if (db - da > 1) return D[Math.round((da + db) / 2)]!;
  if (b && b.length > 1) return b.slice(0, 1);
  return D[da]! + midpoint(a.slice(1), null);
}

/** A key that sorts after `a` and before `b` (either may be missing). */
export function keyBetween(a?: string | null, b?: string | null): string {
  const lo = a ?? "";
  const hi = b ?? null;
  if (hi !== null && lo >= hi) return lo + "V"; // broken order (concurrent edits): stay after a
  return midpoint(lo, hi);
}

/** n keys in ascending order, evenly spread – for initial orderings and imports. */
export function keysFor(n: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) out.push((prev = keyBetween(prev, null)));
  return out;
}
