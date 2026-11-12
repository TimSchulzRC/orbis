// Dates are stored as YYYY-MM-DD of the local calendar, optionally with a wall-clock time:
// YYYY-MM-DDTHH:MM (no zone, like the date itself). Plain string order stays chronological, and a
// day without a time sorts before the same day with one. Arithmetic runs in UTC so adding a day
// stays one day across a daylight saving change.

/** For durations between timestamps, not for calendar dates. */
export const DAY_MS = 864e5;

const MINUTE_MS = 60000;

/** Local calendar date of a moment. */
export function todayISO(d = new Date()) {
	const shifted = new Date(d.getTime() - d.getTimezoneOffset() * MINUTE_MS);
	return shifted.toISOString().slice(0, 10);
}

/** Local calendar date of a timestamp. */
export function dateOf(ts: number) {
	return todayISO(new Date(ts));
}

const utc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));

export function addDays(iso: string, n: number) {
	return new Date(utc(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Negative when b is earlier. */
export function diffDays(a: string, b: string) {
	return Math.round((utc(b) - utc(a)) / DAY_MS);
}

export function addDaysISO(days: number, from = new Date()) {
	return addDays(todayISO(from), days);
}

/** The calendar day of a stored date value, with or without a time. */
export function dayOf(v: string): string {
	return v.slice(0, 10);
}

/** "HH:MM" of a stored date value, undefined for a whole day. */
export function timeOf(v: string): string | undefined {
	return /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(v)?.[1];
}

/** A stored date value from a day and an optional time. */
export function withTime(day: string, time?: string): string {
	return time ? `${day}T${time}` : day;
}
