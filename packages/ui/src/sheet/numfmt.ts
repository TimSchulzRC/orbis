// Excel number formats ("#,##0.00", "dd.mm.yyyy", "0%", "[Red]-0.0" …): a cell's value as Excel shows
// it. The codes are stored in the en-US form; the separators come from the language, as in Excel.
// Covered: sections (positive;negative;zero;text) with conditions, colours, literals, digits,
// grouping and scaling, percent, exponents, fractions, dates, times and elapsed time. Not
// covered: fill characters (`*`) and the width of `_x` (a space), East Asian calendars.

import type { Lang } from "@orbis/core/i18n";

export interface Formatted {
	text: string;
	/** A colour from the format ("[Red]"), as CSS. */
	color?: string;
}

export interface FormatOptions {
	lang: Lang;
	/** The workbook counts days from 1904 (old Mac files). */
	date1904?: boolean;
}

/** Built-in formats by id; 5–8, 14 and 22 follow the language. */
const BUILTIN: Record<number, string> = {
	0: "General",
	1: "0",
	2: "0.00",
	3: "#,##0",
	4: "#,##0.00",
	9: "0%",
	10: "0.00%",
	11: "0.00E+00",
	12: "# ?/?",
	13: "# ??/??",
	15: "d-mmm-yy",
	16: "d-mmm",
	17: "mmm-yy",
	18: "h:mm AM/PM",
	19: "h:mm:ss AM/PM",
	20: "h:mm",
	21: "h:mm:ss",
	37: "#,##0 ;(#,##0)",
	38: "#,##0 ;[Red](#,##0)",
	39: "#,##0.00;(#,##0.00)",
	40: "#,##0.00;[Red](#,##0.00)",
	45: "mm:ss",
	46: "[h]:mm:ss",
	47: "mm:ss.0",
	48: "##0.0E+0",
	49: "@",
};
const BUILTIN_DE: Record<number, string> = {
	5: '#,##0 "€";-#,##0 "€"',
	6: '#,##0 "€";[Red]-#,##0 "€"',
	7: '#,##0.00 "€";-#,##0.00 "€"',
	8: '#,##0.00 "€";[Red]-#,##0.00 "€"',
	14: "dd.mm.yyyy",
	22: "dd.mm.yyyy hh:mm",
};
const BUILTIN_EN: Record<number, string> = {
	5: '"$"#,##0_);("$"#,##0)',
	6: '"$"#,##0_);[Red]("$"#,##0)',
	7: '"$"#,##0.00_);("$"#,##0.00)',
	8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
	14: "m/d/yyyy",
	22: "m/d/yyyy h:mm",
};

/** The code of a built-in format; ids Excel reserves for East Asian dates read as the short date. */
export function builtinFormat(id: number, lang: Lang): string {
	const own = (lang === "de" ? BUILTIN_DE : BUILTIN_EN)[id] ?? BUILTIN[id];
	if (own) return own;
	if ((id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return builtinFormat(14, lang);
	return "General";
}

const COLORS: Record<string, string> = {
	black: "#000000",
	blue: "#0000ff",
	cyan: "#00ffff",
	green: "#008000",
	magenta: "#ff00ff",
	red: "#ff0000",
	white: "#ffffff",
	yellow: "#ffff00",
};

interface Section {
	/** The code without colour and condition. */
	code: string;
	color?: string;
	cond?: { op: string; value: number };
}

const parsed = new Map<string, Section[]>();

/** The sections of a code, split at `;` outside quotes and brackets. */
function sections(code: string): Section[] {
	const hit = parsed.get(code);
	if (hit) return hit;
	const parts: string[] = [];
	let cur = "";
	for (let i = 0; i < code.length; i++) {
		const ch = code[i]!;
		if (ch === '"') {
			const end = code.indexOf('"', i + 1);
			const stop = end < 0 ? code.length : end;
			cur += code.slice(i, stop + 1);
			i = stop;
		} else if (ch === "\\" || ch === "_" || ch === "*") {
			cur += code.slice(i, i + 2);
			i++;
		} else if (ch === "[") {
			const end = code.indexOf("]", i);
			const stop = end < 0 ? code.length : end;
			cur += code.slice(i, stop + 1);
			i = stop;
		} else if (ch === ";") {
			parts.push(cur);
			cur = "";
		} else cur += ch;
	}
	parts.push(cur);
	const out = parts.map((p) => {
		const s: Section = { code: p };
		s.code = p.replace(/\[([^\]]*)\]/g, (m, inner: string) => {
			const low = inner.toLowerCase();
			if (COLORS[low]) {
				s.color = COLORS[low];
				return "";
			}
			if (/^color\s*\d+$/.test(low)) return "";
			const c = /^(<=|>=|<>|<|>|=)\s*(-?[\d.]+)$/.exec(inner);
			if (c) {
				s.cond = { op: c[1]!, value: Number(c[2]) };
				return "";
			}
			// [$€-407], [$-407]: the symbol before the language
			if (inner.startsWith("$")) {
				const sym = inner.slice(1).split("-")[0] ?? "";
				return sym ? `"${sym.replace(/"/g, "")}"` : "";
			}
			return m; // [h], [mm], [ss]: elapsed time
		});
		return s;
	});
	if (parsed.size > 500) parsed.clear();
	parsed.set(code, out);
	return out;
}

const test = (c: { op: string; value: number }, v: number) =>
	c.op === "<"
		? v < c.value
		: c.op === "<="
			? v <= c.value
			: c.op === ">"
				? v > c.value
				: c.op === ">="
					? v >= c.value
					: c.op === "="
						? v === c.value
						: v !== c.value;

const separators = (lang: Lang) =>
	lang === "de" ? { dec: ",", grp: "." } : { dec: ".", grp: "," };

/** A number as Excel's "General" shows it: up to about 11 characters, else in exponent form. */
export function general(v: number, lang: Lang): string {
	if (!Number.isFinite(v)) return String(v);
	const { dec } = separators(lang);
	if (v === 0) return "0";
	const abs = Math.abs(v);
	let s: string;
	if (abs >= 1e11 || abs < 1e-9) {
		const [m, e] = v.toExponential(5).split("e");
		const mant = m!.replace(/\.?0+$/, "");
		const exp = Number(e);
		s = `${mant}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
	} else {
		const digits = abs >= 1 ? 10 - Math.floor(Math.log10(abs)) : 9;
		s = String(Number(v.toFixed(Math.min(20, Math.max(0, digits)))));
		if (s.includes("e")) s = v.toFixed(Math.min(20, Math.max(0, digits))).replace(/\.?0+$/, "");
	}
	return s.replace(".", dec);
}

/**
 * A number in a format code. Text gets `@`'s section if the code has one; a boolean or an error
 * is not passed here.
 */
export function formatNumber(value: number, code: string, opts: FormatOptions): Formatted {
	let v = value;
	if (!code || /^general$/i.test(code)) return { text: general(v, opts.lang) };
	const secs = sections(code);
	let sec: Section;
	let signed = true; // the minus comes from the value, not the section
	const conditional = secs.some((s) => s.cond);
	if (conditional) {
		const hit = secs.slice(0, 2).find((s) => s.cond && test(s.cond, v));
		if (hit) {
			sec = hit;
			signed = hit.cond!.op === "<" || hit.cond!.op === "<=" ? v >= 0 : true;
			if (!signed) v = Math.abs(v);
		} else {
			sec = secs.find((s, i) => i < 3 && !s.cond) ?? secs[0]!;
		}
	} else if (v < 0 && secs.length >= 2 && !secs[1]!.code.includes("@")) {
		sec = secs[1]!;
		v = -v;
		signed = false;
	} else if (v === 0 && secs.length >= 3 && !secs[2]!.code.includes("@")) sec = secs[2]!;
	else sec = secs[0]!;
	if (/^general$/i.test(sec.code.trim()))
		return { text: general(signed ? v : Math.abs(v), opts.lang), color: sec.color };
	const text = isDateCode(sec.code)
		? formatDate(v, sec.code, opts)
		: formatPlain(v, sec.code, opts.lang, signed);
	return { text, color: sec.color };
}

/** Text in a format's text section (the fourth, or one with `@`); else the text itself. */
export function formatText(s: string, code: string): Formatted {
	if (!code?.includes("@")) return { text: s };
	const secs = sections(code);
	const sec = secs.find((x) => x.code.includes("@"));
	if (!sec) return { text: s };
	let out = "";
	for (const t of tokens(sec.code)) {
		if (t.kind === "lit") out += t.s;
		else if (t.kind === "at") out += s;
	}
	return { text: out, color: sec.color };
}

/** Whether a code shows a date or a time (and so its cells are dates). */
export function isDateFormat(code: string): boolean {
	if (!code || /^general$/i.test(code)) return false;
	return isDateCode(sections(code)[0]!.code);
}

function isDateCode(code: string): boolean {
	for (const t of tokens(code)) if (t.kind === "date" || t.kind === "elapsed") return true;
	return false;
}

type Token =
	| { kind: "lit"; s: string }
	| { kind: "at" }
	| { kind: "date"; s: string }
	| { kind: "ampm"; s: string }
	| { kind: "elapsed"; s: string }
	| { kind: "num"; s: string };

const tokenCache = new Map<string, Token[]>();

/** A section's tokens: literals, date parts, number characters. */
function tokens(code: string): Token[] {
	const hit = tokenCache.get(code);
	if (hit) return hit;
	const out: Token[] = [];
	const lit = (s: string) => {
		const last = out.at(-1);
		if (last?.kind === "lit") last.s += s;
		else out.push({ kind: "lit", s });
	};
	for (let i = 0; i < code.length; i++) {
		const ch = code[i]!;
		const rest = code.slice(i);
		if (ch === '"') {
			const end = code.indexOf('"', i + 1);
			const stop = end < 0 ? code.length : end;
			lit(code.slice(i + 1, stop));
			i = stop;
		} else if (ch === "\\") {
			lit(code[i + 1] ?? "");
			i++;
		} else if (ch === "_") {
			lit(" ");
			i++;
		} else if (ch === "*") {
			i++; // fill: no room to fill here
		} else if (ch === "@") out.push({ kind: "at" });
		else if (ch === "[") {
			const end = code.indexOf("]", i);
			const inner = code.slice(i + 1, end < 0 ? code.length : end);
			if (/^(h+|m+|s+)$/i.test(inner)) out.push({ kind: "elapsed", s: inner.toLowerCase() });
			i = end < 0 ? code.length : end;
		} else if (/^(am\/pm|a\/p)/i.test(rest)) {
			const m = /^(am\/pm|a\/p)/i.exec(rest)![0];
			out.push({ kind: "ampm", s: m });
			i += m.length - 1;
		} else if (/[ymdhseg]/i.test(ch) && !(ch.toLowerCase() === "e" && /^e[+-]/i.test(rest))) {
			const m = new RegExp(`^${ch}+`, "i").exec(rest)![0];
			const low = m.toLowerCase();
			if (low[0] === "e" || low[0] === "g") lit(m);
			else out.push({ kind: "date", s: low });
			i += m.length - 1;
		} else if (ch === "." && out.at(-1)?.kind === "date" && /^\.0+/.test(rest)) {
			const m = /^\.0+/.exec(rest)![0];
			out.push({ kind: "date", s: m });
			i += m.length - 1;
		} else if (/[0#?.,%/]/.test(ch) || /^e[+-]/i.test(rest)) {
			if (/^e[+-]/i.test(rest)) {
				out.push({ kind: "num", s: rest.slice(0, 2).toUpperCase() });
				i++;
			} else out.push({ kind: "num", s: ch });
		} else if (/\d/.test(ch)) {
			// digits after "/" are a fixed denominator; elsewhere a literal
			const prev = out.at(-1);
			if (prev?.kind === "num" && /[/\d]/.test(prev.s.at(-1) ?? "")) {
				const m = /^\d+/.exec(rest)![0];
				out.push({ kind: "num", s: m });
				i += m.length - 1;
			} else lit(ch);
		} else lit(ch);
	}
	if (tokenCache.size > 500) tokenCache.clear();
	tokenCache.set(code, out);
	return out;
}

// ---------- numbers ----------

function formatPlain(v: number, code: string, lang: Lang, signed: boolean): string {
	const { dec, grp } = separators(lang);
	const toks = tokens(code);
	const nums = toks.filter((t) => t.kind === "num");
	if (!nums.length) {
		// only literals ("-", "Total"): the value is not shown
		let out = "";
		for (const t of toks) if (t.kind === "lit") out += t.s;
		return (signed && v < 0 && !out ? "-" : "") + out;
	}
	if (nums.some((t) => t.s === "/")) return formatFraction(v, toks, signed);
	const neg = signed && v < 0;
	let x = Math.abs(v);
	// the shape of the number: digits before and after the point, grouping, scaling, %
	let pct = 0;
	for (const t of toks) if (t.kind === "num" && t.s === "%") pct++;
	const expAt = toks.findIndex((t) => t.kind === "num" && /^E[+-]$/.test(t.s));
	const main = expAt < 0 ? toks : toks.slice(0, expAt);
	const dotAt = main.findIndex((t) => t.kind === "num" && t.s === ".");
	const isDigit = (t: Token) => t.kind === "num" && /^[0#?]$/.test(t.s);
	const intToks = (dotAt < 0 ? main : main.slice(0, dotAt)).map((t, i) => ({ t, i }));
	const decToks = dotAt < 0 ? [] : main.slice(dotAt + 1).filter(isDigit);
	const lastInt = intToks.filter(({ t }) => isDigit(t)).at(-1)?.i ?? -1;
	// commas right after the last integer digit divide by 1000 each; one between digits groups
	let scale = 0;
	let group = false;
	for (const { t, i } of intToks) {
		if (t.kind !== "num" || t.s !== ",") continue;
		const after = intToks.slice(i + 1).some(({ t: u }) => isDigit(u));
		if (i > lastInt && !after) scale++;
		else if (i < lastInt) group = true;
	}
	if (dotAt >= 0 && expAt < 0) {
		// "0.0," also scales
		for (const t of main.slice(dotAt + 1)) if (t.kind === "num" && t.s === ",") scale++;
	}
	x = (x * 100 ** pct) / 1000 ** scale;
	let exp = 0;
	const intDigits = intToks.filter(({ t }) => isDigit(t)).length;
	if (expAt >= 0 && x !== 0) {
		exp = Math.floor(Math.log10(x));
		if (intDigits > 1 && intToks.some(({ t }) => t.kind === "num" && t.s === "#"))
			exp = Math.floor(exp / intDigits) * intDigits; // engineering: "##0.0E+0"
		else exp -= Math.max(0, intDigits - 1);
		x /= 10 ** exp;
	}
	const places = decToks.length;
	let fixed = roundFixed(x, places);
	if (expAt >= 0 && Number(fixed) >= 10 ** Math.max(1, intDigits) && intDigits <= 1) {
		exp += 1;
		x /= 10;
		fixed = roundFixed(x, places);
	}
	let [ip = "0", dp = ""] = fixed.split(".");
	if (ip === "0") ip = "";
	// decimals: "#" drops trailing zeros, "?" turns them into spaces
	let decOut = "";
	{
		const chars = dp.split("");
		let cut = chars.length;
		for (let k = chars.length - 1; k >= 0; k--) {
			if (chars[k] !== "0") break;
			const ph = decToks[k]!.kind === "num" ? (decToks[k] as { s: string }).s : "0";
			if (ph === "0") break;
			cut = k;
		}
		decOut = chars
			.map((c, k) => (k < cut ? c : (decToks[k] as { s: string }).s === "?" ? " " : ""))
			.join("");
	}
	// integer digits into their places, right to left; extra digits go to the first place
	const intPlaces = intToks.filter(({ t }) => isDigit(t));
	const minZeros = (() => {
		let n = 0;
		let seen = false;
		for (const { t } of intPlaces) {
			if ((t as { s: string }).s === "0") seen = true;
			if (seen) n++;
		}
		return n;
	})();
	const fill: string[] = new Array(intPlaces.length).fill("");
	if (group || intPlaces.length === 0) {
		let digits = ip.padStart(minZeros, "0");
		if (group) digits = digits.replace(/\B(?=(\d{3})+(?!\d))/g, grp);
		if (intPlaces.length) fill[0] = digits;
		else if (digits) fill.push(digits);
	} else {
		let rest = ip;
		for (let k = intPlaces.length - 1; k >= 0; k--) {
			const ph = (intPlaces[k]!.t as { s: string }).s;
			if (k === 0) fill[k] = rest || (ph === "0" ? "0" : ph === "?" ? " " : "");
			else if (rest) {
				fill[k] = rest.slice(-1);
				rest = rest.slice(0, -1);
			} else fill[k] = ph === "0" ? "0" : ph === "?" ? " " : "";
		}
	}
	let out = "";
	let placeIx = 0;
	let decIx = 0;
	let afterDot = false;
	const expToks = expAt < 0 ? [] : toks.slice(expAt + 1);
	for (const t of expAt < 0 ? toks : toks.slice(0, expAt)) {
		if (t.kind === "lit") out += t.s;
		else if (t.kind === "at" || t.kind === "date" || t.kind === "ampm" || t.kind === "elapsed")
			continue;
		else if (t.s === ".") {
			if (!afterDot) out += dec;
			afterDot = true;
		} else if (t.s === "," || t.s === "%") {
			if (t.s === "%") out += "%";
		} else if (/^[0#?]$/.test(t.s)) {
			if (afterDot) {
				out += decOut[decIx] ?? "";
				decIx++;
			} else {
				if (intPlaces.length === 0) continue;
				out += fill[placeIx] ?? "";
				placeIx++;
			}
		}
	}
	if (intPlaces.length === 0 && fill[0]) out = fill[0] + out;
	if (expAt >= 0) {
		const sign = (toks[expAt] as { s: string }).s[1];
		const expDigits = expToks.filter(isDigit).length || 1;
		out += `E${exp < 0 ? "-" : sign === "+" ? "+" : ""}${String(Math.abs(exp)).padStart(expDigits, "0")}`;
		for (const t of expToks) if (t.kind === "lit") out += t.s;
	}
	const zero = !/[1-9]/.test(out);
	return (neg && !zero ? "-" : neg && zero && x !== 0 ? "-" : "") + out;
}

/** `x` with `places` decimals, rounded half away from zero, without exponent form. */
function roundFixed(x: number, places: number): string {
	if (x >= 1e21) return BigInt(Math.round(x)).toString() + (places ? `.${"0".repeat(places)}` : "");
	// toFixed rounds 1.005 down; nudge by the representation error
	const f = 10 ** places;
	const r = Math.round(x * f * (1 + Number.EPSILON)) / f;
	return r.toFixed(places);
}

function formatFraction(v: number, toks: Token[], signed: boolean): string {
	const neg = signed && v < 0;
	let x = Math.abs(v);
	const slash = toks.findIndex((t) => t.kind === "num" && t.s === "/");
	const before = toks.slice(0, slash);
	const after = toks.slice(slash + 1);
	// "# ?/?": a whole part when a digit group is followed by a literal before the numerator
	let wholeEnd = -1;
	for (let i = before.length - 1; i >= 0; i--) {
		const t = before[i]!;
		if (t.kind === "lit" && /\s/.test(t.s)) {
			wholeEnd = i;
			break;
		}
	}
	const hasWhole =
		wholeEnd > 0 && before.slice(0, wholeEnd).some((t) => t.kind === "num" && /[0#?]/.test(t.s));
	let whole = 0;
	if (hasWhole) {
		whole = Math.floor(x);
		x -= whole;
	}
	const fixedDen = after.find((t) => t.kind === "num" && /^\d+$/.test(t.s) && t.s !== "0");
	let num: number;
	let den: number;
	if (fixedDen) {
		den = Number((fixedDen as { s: string }).s);
		num = Math.round(x * den);
	} else {
		const digits = Math.max(1, after.filter((t) => t.kind === "num" && /^[0#?]$/.test(t.s)).length);
		[num, den] = approximate(x, 10 ** digits - 1);
	}
	if (hasWhole && num === den) {
		whole++;
		num = 0;
	}
	const parts: string[] = [];
	if (hasWhole && (whole || num === 0)) parts.push(String(whole));
	if (num !== 0 || !hasWhole) parts.push(`${num}/${den}`);
	return (neg ? "-" : "") + parts.join(" ");
}

/** The closest fraction with a denominator up to `max` (Stern–Brocot / continued fractions). */
function approximate(x: number, max: number): [number, number] {
	if (x === 0) return [0, 1];
	let [a, b, c, d] = [0, 1, 1, 0];
	let best: [number, number] = [Math.round(x), 1];
	let err = Math.abs(x - best[0]);
	let y = x;
	for (let k = 0; k < 64; k++) {
		const n = Math.floor(y);
		const nc = n * c + a;
		const nd = n * d + b;
		if (nd > max) break;
		[a, b, c, d] = [c, d, nc, nd];
		const e = Math.abs(x - nc / nd);
		if (e < err) {
			best = [nc, nd];
			err = e;
		}
		if (y - n < 1e-12) break;
		y = 1 / (y - n);
	}
	return best;
}

// ---------- dates ----------

const DAY_MS = 86_400_000;

/** A serial date as UTC parts; Excel's 29 Feb 1900 (serial 60) is kept. */
export function serialToParts(serial: number, date1904 = false) {
	const days = Math.floor(serial);
	let ms = Math.round((serial - days) * DAY_MS);
	let d = days;
	if (ms >= DAY_MS) {
		ms -= DAY_MS;
		d++;
	}
	let y: number;
	let mo: number;
	let day: number;
	let weekday: number;
	if (!date1904 && d === 60) {
		y = 1900;
		mo = 1;
		day = 29;
		weekday = 3;
	} else {
		const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, d < 60 ? 31 : 30);
		const dt = new Date(base + d * DAY_MS);
		y = dt.getUTCFullYear();
		mo = dt.getUTCMonth();
		day = dt.getUTCDate();
		weekday = dt.getUTCDay();
	}
	return {
		y,
		mo,
		d: day,
		weekday,
		h: Math.floor(ms / 3_600_000),
		mi: Math.floor(ms / 60_000) % 60,
		s: Math.floor(ms / 1000) % 60,
		ms: ms % 1000,
		totalMs: serial * DAY_MS,
	};
}

const names = new Map<string, string[]>();
function nameList(lang: Lang, kind: "month" | "weekday", width: "long" | "short"): string[] {
	const key = `${lang}${kind}${width}`;
	const hit = names.get(key);
	if (hit) return hit;
	const fmt = new Intl.DateTimeFormat(lang, { [kind]: width, timeZone: "UTC" });
	const list =
		kind === "month"
			? Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2021, i, 1))))
			: Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2021, 0, 3 + i))));
	const out = list.map((s) => s.replace(/\.$/, ""));
	names.set(key, out);
	return out;
}

function formatDate(v: number, code: string, opts: FormatOptions): string {
	const toks = tokens(code);
	const ampm = toks.some((t) => t.kind === "ampm");
	const subsec = toks.find((t) => t.kind === "date" && t.s.startsWith("."));
	const decimals = subsec ? Math.min(3, subsec.kind === "date" ? subsec.s.length - 1 : 0) : 0;
	// rounded to what the format shows: no seconds' fraction, whole seconds
	const unit = 1000 / 10 ** decimals;
	const rounded = Math.round((v * DAY_MS) / unit) * unit;
	const p = serialToParts(rounded / DAY_MS, opts.date1904);
	const pad = (n: number, w: number) => String(n).padStart(w, "0");
	// "m" means minutes right after an hour or before a second
	const minutes = toks.map((t, i) => {
		if (t.kind !== "date" || t.s[0] !== "m" || t.s.length > 2) return false;
		const prev = toks
			.slice(0, i)
			.reverse()
			.find((u) => u.kind === "date" || u.kind === "elapsed");
		const next = toks.slice(i + 1).find((u) => u.kind === "date" || u.kind === "elapsed");
		const isMin =
			(prev && (prev.s[0] === "h" || (prev.kind === "elapsed" && prev.s[0] === "h"))) ||
			(next && next.s[0] === "s") ||
			(next?.kind === "elapsed" && next.s[0] === "s");
		return !!isMin;
	});
	let out = "";
	for (const [i, t] of toks.entries()) {
		if (t.kind === "lit") out += t.s;
		else if (t.kind === "num")
			out += t.s; // "." and "/" between date parts
		else if (t.kind === "ampm") {
			const pm = p.h >= 12;
			out += t.s.length > 3 ? (pm ? "PM" : "AM") : pm ? t.s[2]! : t.s[0]!;
		} else if (t.kind === "elapsed") {
			const total = Math.abs(rounded);
			const n =
				t.s[0] === "h"
					? Math.floor(total / 3_600_000)
					: t.s[0] === "m"
						? Math.floor(total / 60_000)
						: Math.floor(total / 1000);
			out += (rounded < 0 ? "-" : "") + pad(n, t.s.length);
		} else if (t.kind === "date") {
			const s = t.s;
			if (s.startsWith(".")) out += opts.lang === "de" ? "," : ".";
			if (s.startsWith(".")) out += pad(p.ms, 3).slice(0, s.length - 1);
			else if (s[0] === "y") out += s.length <= 2 ? pad(p.y % 100, 2) : String(p.y);
			else if (s[0] === "m" && minutes[i]) out += pad(p.mi, s.length);
			else if (s[0] === "m") {
				if (s.length <= 2) out += pad(p.mo + 1, s.length);
				else if (s.length === 3) out += nameList(opts.lang, "month", "long")[p.mo]!.slice(0, 3);
				else if (s.length === 4) out += nameList(opts.lang, "month", "long")[p.mo]!;
				else out += nameList(opts.lang, "month", "long")[p.mo]![0]!;
			} else if (s[0] === "d") {
				if (s.length <= 2) out += pad(p.d, s.length);
				else if (s.length === 3) out += nameList(opts.lang, "weekday", "short")[p.weekday]!;
				else out += nameList(opts.lang, "weekday", "long")[p.weekday]!;
			} else if (s[0] === "h") {
				const h = ampm ? p.h % 12 || 12 : p.h;
				out += pad(h, Math.min(2, s.length));
			} else if (s[0] === "s") out += pad(p.s, Math.min(2, s.length));
		}
	}
	return out;
}

/** A cell as Excel shows it, with the colour its format gives. */
export function cellText(
	cell:
		| { t: "n"; v: number }
		| { t: "s"; v: string }
		| { t: "b"; v: boolean }
		| { t: "e"; v: string },
	fmt: string,
	opts: FormatOptions,
): Formatted {
	switch (cell.t) {
		case "n":
			return formatNumber(cell.v, fmt, opts);
		case "s":
			return formatText(cell.v, fmt);
		case "b":
			return {
				text: opts.lang === "de" ? (cell.v ? "WAHR" : "FALSCH") : cell.v ? "TRUE" : "FALSE",
			};
		case "e":
			return { text: cell.v };
	}
}
