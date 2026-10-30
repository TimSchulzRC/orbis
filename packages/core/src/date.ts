// Dates as stored: ISO strings (YYYY-MM-DD) of the local calendar. Arithmetic runs on the
// calendar (in UTC), so adding a day stays one day across a change to or from summer time.

/** One day in ms: for durations between timestamps, not for calendar dates. */
export const DAY_MS = 864e5;

/** The local date of a moment (today by default). */
export function todayISO(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

/** The local date of a timestamp ("created on", "done on"). */
export function dateOf(ts: number) {
  return todayISO(new Date(ts));
}

const utc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

/** The date `n` days after `iso` (before it for negative n). */
export function addDays(iso: string, n: number) {
  return new Date(utc(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Days from `a` to `b` (negative when b is earlier). */
export function diffDays(a: string, b: string) {
  return Math.round((utc(b) - utc(a)) / DAY_MS);
}

/** The date `days` days after the local date of `from` (today by default). */
export function addDaysISO(days: number, from = new Date()) {
  return addDays(todayISO(from), days);
}
