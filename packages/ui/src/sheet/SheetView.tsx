// The viewer for Excel workbooks on the file page: a sheet per tab, cells as Excel shows them
// (number formats, fonts, fills, merged cells, column widths, frozen panes), only read, never
// changed. Only the rows and columns in view are drawn, so long sheets scroll freely. A click
// selects a cell (its whole value and formula show above the grid), a drag or Shift a range
// (count and sum below); Ctrl+C copies it as tab-separated text.

import { fmtNumber, type Lang } from "@orbis/core/i18n";
import type { FileMeta } from "@orbis/core/model";
import { ChevronDown, ChevronUp, EyeOff, Maximize2, Minimize2, Search } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useFiles } from "../hooks";
import { useT } from "../i18n";
import { IconButton } from "../ui/primitives";
import { notify } from "../ui/toasts";
import { builtinFormat, cellText, type Formatted } from "./numfmt";
import {
	type Cell,
	type CellStyle,
	colName,
	type Range,
	readWorkbook,
	type SheetData,
	type Workbook,
} from "./workbook";

/** Files this viewer opens; others (.xls, .ods) keep the text the server took out. */
export const SHEET_FILE = /\.(xlsx|xlsm|xltx|xltm)$/i;

/** Height of the column letters. */
const HEAD_H = 24;
/** Rows and columns drawn beyond the visible ones. */
const OVERSCAN = 3;
/** Columns a text may run into while they are empty. */
const OVERFLOW_MAX = 30;
/** Hits a search lists at most. */
const MATCH_MAX = 10_000;
/** Cells a copy takes at most: a sparse sheet's "select all" can span billions. */
const COPY_MAX = 2_000_000;
/** The viewer's least height; below it the page scrolls. */
const MIN_HEIGHT = 360;
/** Excel's 11 pt at 13 px. */
const PX_PER_PT = 13 / 11;
const COLS = 16_384;
const key = (r: number, c: number) => r * COLS + c;

interface Pos {
	r: number;
	c: number;
}
interface Selection {
	/** Where the selection started: the cell shown above the grid. */
	a: Pos;
	/** The other corner. */
	f: Pos;
}

type Loaded = { hash: string; book?: Workbook; failed?: boolean };

/**
 * The workbook in `file`, loaded from this device or the server. `fallback` shows when it can't be
 * read (offline, not an xlsx after all).
 */
export function SheetView({ file, fallback }: { file: FileMeta; fallback: ReactNode }) {
	const files = useFiles();
	const { t, lang } = useT();
	const [loaded, setLoaded] = useState<Loaded>();
	useEffect(() => {
		let alive = true;
		void (async () => {
			let book: Workbook | undefined;
			try {
				const blob = await files.content(file.hash);
				if (blob)
					book = await readWorkbook(new Uint8Array(await blob.arrayBuffer()), (id) =>
						builtinFormat(id, lang),
					);
			} catch (e) {
				console.warn("workbook not readable", e);
			}
			if (alive) setLoaded({ hash: file.hash, book, failed: !book });
		})();
		return () => {
			alive = false;
		};
	}, [files, file.hash, lang]);
	const current = loaded?.hash === file.hash ? loaded : undefined;
	if (current?.failed) return <>{fallback}</>;
	if (!current?.book)
		return (
			<div className="flex h-40 items-center justify-center rounded-xl border border-line bg-surface-2 text-sm text-muted-foreground">
				{t("sheet.loading")}
			</div>
		);
	return <BookView book={current.book} fallback={fallback} key={file.hash} lang={lang} />;
}

function BookView({ book, lang, fallback }: { book: Workbook; lang: Lang; fallback: ReactNode }) {
	const { t } = useT();
	const [index, setIndex] = useState(book.active);
	const [sheet, setSheet] = useState<{ index: number; data?: SheetData }>();
	useEffect(() => {
		let alive = true;
		void book.sheet(index).then((data) => alive && setSheet({ index, data }));
		return () => {
			alive = false;
		};
	}, [book, index]);
	const data = sheet?.index === index ? sheet.data : undefined;
	// a sheet whose part can't be read: the text the server took out instead
	const failed = sheet?.index === index && !sheet.data;
	const info = book.sheets[index];
	const [sel, setSel] = useState<Selection>({ a: { r: 0, c: 0 }, f: { r: 0, c: 0 } });
	// a new sheet starts at its first cell
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new sheet only
	useEffect(() => setSel({ a: { r: 0, c: 0 }, f: { r: 0, c: 0 } }), [index]);
	const show = useCallback(
		(cell: Cell): Formatted =>
			cellText(cell, book.styles[cell.s]?.fmt ?? "General", { lang, date1904: book.date1904 }),
		[book, lang],
	);

	// search: every cell whose shown text holds the words, row by row
	const [query, setQuery] = useState("");
	const [hit, setHit] = useState(0);
	const matches = useMemo(() => {
		const q = query.trim().toLocaleLowerCase();
		if (!q || !data) return [];
		const out: Pos[] = [];
		for (let r = 0; r < data.cells.length && out.length < MATCH_MAX; r++) {
			const row = data.cells[r];
			if (!row) continue;
			for (let c = 0; c < row.length; c++) {
				const cell = row[c];
				if (!cell) continue;
				if (show(cell).text.toLocaleLowerCase().includes(q)) out.push({ r, c });
				if (out.length >= MATCH_MAX) break;
			}
		}
		return out;
	}, [query, data, show]);
	const matchKeys = useMemo(() => new Set(matches.map((m) => key(m.r, m.c))), [matches]);
	const go = (i: number) => {
		if (!matches.length) return;
		const n = (i + matches.length) % matches.length;
		setHit(n);
		const m = matches[n]!;
		setSel({ a: m, f: m });
	};
	// a new search jumps to its first hit
	useEffect(() => {
		setHit(0);
		const m = matches[0];
		if (m) setSel({ a: m, f: m });
	}, [matches]);

	const root = useRef<HTMLDivElement>(null);
	const [full, setFull] = useState(false);
	useEffect(() => {
		const on = () => setFull(document.fullscreenElement === root.current);
		document.addEventListener("fullscreenchange", on);
		return () => document.removeEventListener("fullscreenchange", on);
	}, []);
	const canFull = typeof document !== "undefined" && document.fullscreenEnabled;
	// as high as the page's scrolling area below the title, so the sheet and its tabs are in view
	const [height, setHeight] = useState<number>();
	useLayoutEffect(() => {
		const el = root.current;
		const main = el?.closest("main");
		if (!el || !main) return;
		const measure = () => {
			const top =
				el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
			const room = Number.parseFloat(getComputedStyle(main).paddingBottom) || 0;
			setHeight(Math.max(MIN_HEIGHT, Math.floor(main.clientHeight - top - room - 16)));
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(main);
		return () => ro.disconnect();
	}, []);

	const anchor = data?.cells[sel.a.r]?.[sel.a.c];
	const range = useMemo(() => norm(sel), [sel]);
	const single = range.r1 === range.r2 && range.c1 === range.c2;
	const merged = data?.merges.find((m) => m.r1 === sel.a.r && m.c1 === sel.a.c);
	const address =
		single || (merged && sameRange(merged, range))
			? `${colName(sel.a.c)}${sel.a.r + 1}`
			: `${colName(range.c1)}${range.r1 + 1}:${colName(range.c2)}${range.r2 + 1}`;
	const stats = useMemo(
		() => (data && !single ? statsOf(data, range) : undefined),
		[data, single, range],
	);

	return (
		<div
			className="xl flex h-[70vh] min-h-[360px] flex-col overflow-hidden rounded-xl border border-line bg-surface [&:fullscreen]:h-screen [&:fullscreen]:rounded-none [&:fullscreen]:border-0"
			ref={root}
			style={full || !height ? undefined : { height }}
		>
			{/* the selected cell's address and whole value; search; full screen */}
			<div className="flex min-h-10 shrink-0 items-start gap-2 border-b border-line px-2 py-1.5">
				<span className="mt-px shrink-0 rounded-md border border-line px-2 py-0.5 font-mono text-[12px] tabular-nums text-muted-foreground">
					{address}
				</span>
				<div
					className="max-h-24 min-w-0 flex-1 overflow-auto py-0.5 text-[13px] leading-[1.45] whitespace-pre-wrap break-words"
					data-testid="sheet-value"
				>
					{anchor ? show(anchor).text : ""}
					{anchor?.f && (
						<span className="ml-3 font-mono text-[12px] text-muted-foreground">={anchor.f}</span>
					)}
				</div>
				<label className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line px-2 text-[13px] focus-within:border-ring max-md:w-36">
					<Search className="shrink-0 text-muted-foreground" size={14} />
					<input
						aria-label={t("sheet.search")}
						className="w-32 min-w-0 bg-transparent outline-none placeholder:text-faint max-md:w-full"
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								go(hit + (e.shiftKey ? -1 : 1));
							} else if (e.key === "Escape") setQuery("");
						}}
						placeholder={t("sheet.search")}
						type="search"
						value={query}
					/>
					{query.trim() && (
						<span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
							{matches.length
								? t("sheet.match", { at: hit + 1, count: matches.length })
								: t("sheet.noMatch")}
						</span>
					)}
				</label>
				{query.trim() && matches.length > 1 && (
					<span className="flex shrink-0">
						<IconButton
							icon={ChevronUp}
							label={t("sheet.previous")}
							onClick={() => go(hit - 1)}
							size="sm"
						/>
						<IconButton
							icon={ChevronDown}
							label={t("sheet.next")}
							onClick={() => go(hit + 1)}
							size="sm"
						/>
					</span>
				)}
				{canFull && (
					<IconButton
						className="shrink-0"
						icon={full ? Minimize2 : Maximize2}
						label={t(full ? "sheet.exitFullscreen" : "sheet.fullscreen")}
						onClick={() =>
							full ? void document.exitFullscreen() : void root.current?.requestFullscreen()
						}
						size="sm"
					/>
				)}
			</div>

			<div className="relative min-h-0 flex-1">
				{info?.kind === "chart" ? (
					<Note>{t("sheet.chart")}</Note>
				) : failed ? (
					<div className="h-full overflow-auto p-3">{fallback}</div>
				) : !data ? (
					<Note>{t("sheet.loading")}</Note>
				) : (
					<>
						<Grid
							data={data}
							key={index}
							matches={matchKeys}
							onSelect={setSel}
							sel={sel}
							show={show}
							styles={book.styles}
						/>
						{data.rows === 0 && (
							<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
								<span className="rounded-lg bg-surface-2 px-3 py-1.5 text-sm text-muted-foreground">
									{t("sheet.empty")}
								</span>
							</div>
						)}
					</>
				)}
			</div>

			{/* the sheets as tabs; the size or the selection's numbers */}
			<div className="flex min-h-9 shrink-0 items-stretch border-t border-line bg-surface-2">
				<div
					aria-label={t("sheet.sheets")}
					className="flex min-w-0 flex-1 overflow-x-auto"
					role="tablist"
				>
					{book.sheets.map((s, i) => (
						<button
							aria-selected={i === index}
							className={`flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-line px-3 text-[13px] whitespace-nowrap ${
								i === index
									? "bg-surface font-medium text-fg shadow-[inset_0_2px_0_var(--t-drawing)]"
									: "text-muted-foreground hover:bg-hover"
							} ${s.hidden ? "italic" : ""}`}
							key={s.name}
							onClick={() => setIndex(i)}
							role="tab"
							title={s.hidden ? t("sheet.hidden") : undefined}
							type="button"
						>
							{s.hidden && <EyeOff aria-label={t("sheet.hidden")} size={12} />}
							{s.name}
						</button>
					))}
				</div>
				<div className="flex shrink-0 items-center gap-3 px-3 text-[12px] tabular-nums text-muted-foreground max-md:hidden">
					{stats ? (
						<>
							<span>{t("sheet.count", { count: fmtNumber(lang, stats.count) })}</span>
							{stats.numbers > 0 && (
								<>
									<span>{t("sheet.sum", { sum: number(lang, stats.sum) })}</span>
									<span>
										{t("sheet.average", { average: number(lang, stats.sum / stats.numbers) })}
									</span>
								</>
							)}
						</>
					) : data && data.rows > 0 ? (
						<span>
							{t("sheet.size", { rows: data.rows, cols: data.cols })}
							{data.cut && ` · ${t("sheet.cut", { count: fmtNumber(lang, data.rows) })}`}
						</span>
					) : null}
				</div>
			</div>
		</div>
	);
}

const Note = ({ children }: { children: ReactNode }) => (
	<div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
		{children}
	</div>
);

const number = (lang: Lang, n: number) =>
	new Intl.NumberFormat(lang, { maximumFractionDigits: 6 }).format(n);

function norm(s: Selection): Range {
	return {
		r1: Math.min(s.a.r, s.f.r),
		c1: Math.min(s.a.c, s.f.c),
		r2: Math.max(s.a.r, s.f.r),
		c2: Math.max(s.a.c, s.f.c),
	};
}
const sameRange = (a: Range, b: Range) =>
	a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;

/** Cells with a value in a range, and the sum of its numbers (as Excel's status bar). */
function statsOf(data: SheetData, r: Range) {
	let count = 0;
	let numbers = 0;
	let sum = 0;
	for (let i = r.r1; i <= Math.min(r.r2, data.cells.length - 1); i++) {
		const row = data.cells[i];
		if (!row) continue;
		for (let c = r.c1; c <= Math.min(r.c2, row.length - 1); c++) {
			const cell = row[c];
			if (!cell || (cell.t === "s" && cell.v === "")) continue;
			count++;
			if (cell.t === "n") {
				numbers++;
				sum += cell.v;
			}
		}
	}
	return { count, numbers, sum };
}

/** The text of a range, cells by tabs, rows by line breaks (what a spreadsheet pastes). */
function rangeText(data: SheetData, r: Range, show: (c: Cell) => Formatted): string {
	const lines: string[] = [];
	for (let i = r.r1; i <= Math.min(r.r2, data.rows - 1); i++) {
		const row = data.cells[i];
		const cells: string[] = [];
		for (let c = r.c1; c <= Math.min(r.c2, Math.max(0, data.cols - 1)); c++) {
			const cell = row?.[c];
			const text = cell ? show(cell).text : "";
			cells.push(/[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
		}
		lines.push(cells.join("\t"));
	}
	return lines.join("\n");
}

/** The largest i with at[i] <= x, within 0 … n-1. */
function find(at: Float64Array, n: number, x: number): number {
	let lo = 0;
	let hi = n - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (at[mid]! <= x) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** Rows looked at to fit a column's width, from the top and spread over the rest. */
const FIT_ROWS = 2000;
const FIT_MAX = 360;
let ruler: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, bold: boolean): number {
	if (ruler === undefined) {
		ruler = document.createElement("canvas").getContext("2d");
	}
	if (!ruler) return text.length * 7.5;
	const family = getComputedStyle(document.body).fontFamily || "sans-serif";
	ruler.font = `${bold ? 600 : 400} 13px ${family}`;
	return ruler.measureText(text).width;
}

/**
 * Widths for columns the file gives none (exports, generated files): wide enough for their numbers
 * and for texts a filled neighbour would cut, as Excel shows "###" instead.
 */
function fitWidths(
	data: SheetData,
	styles: CellStyle[],
	show: (c: Cell) => Formatted,
): Map<number, number> {
	const need = new Map<number, number>();
	// a merged cell's text has the room of the merge
	const anchors = new Set(data.merges.map((m) => key(m.r1, m.c1)));
	// the first rows, then a sample spread over the rest
	const step = Math.max(1, Math.ceil((data.cells.length - FIT_ROWS) / FIT_ROWS));
	for (let r = 0; r < data.cells.length; r += r < FIT_ROWS ? 1 : step) {
		const row = data.cells[r];
		if (!row) continue;
		for (let c = 0; c < row.length; c++) {
			const cell = row[c];
			if (!cell || data.widths.has(c) || anchors.has(key(r, c))) continue;
			if (cell.t === "s" && cell.v === "") continue;
			const st = styles[cell.s];
			if (st?.wrap || st?.size) continue;
			if (cell.t === "s" && !row[c + 1]) continue; // runs on into the empty neighbour
			const text = show(cell).text;
			const longest = text.includes("\n")
				? text.split("\n").reduce((a, b) => (b.length > a.length ? b : a))
				: text;
			const w = Math.ceil(textWidth(longest, !!st?.bold) + 12 + (st?.indent ?? 0) * 9);
			if (w > (need.get(c) ?? data.defaultWidth)) need.set(c, Math.min(FIT_MAX, w));
		}
	}
	return need;
}

/** Lines a wrapped cell may make its row tall. */
const LINES_MAX = 12;

/**
 * Heights for rows the file gives none: tall enough for larger fonts and for wrapped text, as
 * Excel fits such rows when it opens the file.
 */
function fitHeights(
	data: SheetData,
	styles: CellStyle[],
	show: (c: Cell) => Formatted,
	width: (c: number) => number,
): Map<number, number> {
	const out = new Map<number, number>();
	const anchors = new Set(data.merges.map((m) => key(m.r1, m.c1)));
	for (let r = 0; r < data.cells.length; r++) {
		const row = data.cells[r];
		if (!row || data.heights.has(r)) continue;
		let h = data.defaultHeight;
		for (let c = 0; c < row.length; c++) {
			const cell = row[c];
			const st = cell && styles[cell.s];
			if (!cell || !st || (!st.wrap && !st.size) || anchors.has(key(r, c))) continue;
			const line = (st.size ?? 11) * PX_PER_PT * 1.3;
			let lines = 1;
			if (st.wrap) {
				const room = Math.max(1, width(c) - 8);
				lines = show(cell)
					.text.split("\n")
					.reduce(
						(n, part) =>
							n +
							Math.max(1, Math.ceil((textWidth(part, !!st.bold) * (st.size ?? 11)) / 11 / room)),
						0,
					);
			}
			h = Math.max(h, Math.ceil(Math.min(lines, LINES_MAX) * line + 4));
		}
		if (h !== data.defaultHeight) out.set(r, h);
	}
	return out;
}

/** Whether a colour is dark: on the dark theme such text falls back to the theme's own. */
function dark(hex: string): boolean {
	const n = Number.parseInt(hex.slice(1), 16);
	const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
	return lum < 0.45;
}

interface GridProps {
	data: SheetData;
	styles: CellStyle[];
	show: (c: Cell) => Formatted;
	sel: Selection;
	onSelect: (s: Selection) => void;
	matches: Set<number>;
}

function Grid({ data, styles, show, sel, onSelect, matches }: GridProps) {
	const { t, lang } = useT();
	const scroller = useRef<HTMLDivElement>(null);
	const [view, setView] = useState({ w: 800, h: 600, left: 0, top: 0 });
	useLayoutEffect(() => {
		const el = scroller.current!;
		const measure = () =>
			setView((v) =>
				v.w === el.clientWidth && v.h === el.clientHeight
					? v
					: { ...v, w: el.clientWidth, h: el.clientHeight },
			);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// geometry: column and row starts; the grid reaches at least to the window's edges
	const fitted = useMemo(() => {
		const widths = fitWidths(data, styles, show);
		const width = (c: number) => data.widths.get(c) ?? widths.get(c) ?? data.defaultWidth;
		return { widths, heights: fitHeights(data, styles, show, width) };
	}, [data, styles, show]);
	const layout = useMemo(() => {
		const width = (c: number) => data.widths.get(c) ?? fitted.widths.get(c) ?? data.defaultWidth;
		const height = (r: number) =>
			data.heights.get(r) ?? fitted.heights.get(r) ?? data.defaultHeight;
		let nCols = Math.max(1, data.cols);
		let w = 0;
		for (let c = 0; c < nCols; c++) w += width(c);
		while (w < view.w + 200 && nCols < COLS) w += width(nCols++);
		let nRows = Math.max(1, data.rows);
		let h = 0;
		if (nRows < 5000) {
			for (let r = 0; r < nRows; r++) h += height(r);
			while (h < view.h + 100 && nRows < 1_048_576) h += height(nRows++);
		}
		const colX = new Float64Array(nCols + 1);
		for (let c = 0; c < nCols; c++) colX[c + 1] = colX[c]! + width(c);
		const rowY = new Float64Array(nRows + 1);
		for (let r = 0; r < nRows; r++) rowY[r + 1] = rowY[r]! + height(r);
		const fr = Math.min(data.frozen.rows, nRows);
		const fc = Math.min(data.frozen.cols, nCols);
		const rowHead = Math.max(36, String(nRows).length * 8 + 14);
		return { nCols, nRows, colX, rowY, fr, fc, FW: colX[fc]!, FH: rowY[fr]!, rowHead };
	}, [data, fitted, view.w, view.h]);
	const { nCols, nRows, colX, rowY, fr, fc, FW, FH, rowHead: RH } = layout;
	const totalW = colX[nCols]!;
	const totalH = rowY[nRows]!;

	// what is in view of the scrolling part
	const c0 = Math.max(fc, find(colX, nCols, view.left + FW) - OVERSCAN);
	const c1 = Math.min(nCols - 1, find(colX, nCols, view.left + view.w - RH) + OVERSCAN);
	const r0 = Math.max(fr, find(rowY, nRows, view.top + FH) - OVERSCAN);
	const r1 = Math.min(nRows - 1, find(rowY, nRows, view.top + view.h - HEAD_H) + OVERSCAN);

	const range = norm(sel);
	// brings the moving corner into view (keys, search, a drag past the edge)
	// biome-ignore lint/correctness/useExhaustiveDependencies: on a new selection only
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const { r, c } = sel.f;
		if (c >= fc && c < nCols) {
			const x = colX[c]!;
			const w = colX[c + 1]! - x;
			if (x < el.scrollLeft + FW) el.scrollLeft = x - FW;
			else if (RH + x + w > el.scrollLeft + el.clientWidth)
				el.scrollLeft = Math.min(x - FW, RH + x + w - el.clientWidth);
		}
		if (r >= fr && r < nRows) {
			const y = rowY[r]!;
			const h = rowY[r + 1]! - y;
			if (y < el.scrollTop + FH) el.scrollTop = y - FH;
			else if (HEAD_H + y + h > el.scrollTop + el.clientHeight)
				el.scrollTop = Math.min(y - FH, HEAD_H + y + h - el.clientHeight);
		}
	}, [sel]);

	/** The cell under a pointer; -1 for the headers. */
	const cellAt = (clientX: number, clientY: number): Pos | undefined => {
		const el = scroller.current!;
		const box = el.getBoundingClientRect();
		const x = clientX - box.left;
		const y = clientY - box.top;
		if (x > el.clientWidth || y > el.clientHeight) return undefined;
		const sx = x < RH ? -1 : x - RH < FW ? x - RH : x - RH + el.scrollLeft;
		const sy = y < HEAD_H ? -1 : y - HEAD_H < FH ? y - HEAD_H : y - HEAD_H + el.scrollTop;
		return {
			c: sx < 0 ? -1 : find(colX, nCols, sx),
			r: sy < 0 ? -1 : find(rowY, nRows, sy),
		};
	};
	const lastRow = Math.max(0, data.rows - 1);
	const lastCol = Math.max(0, data.cols - 1);
	const pick = (p: Pos, extend: boolean) => {
		if (p.r < 0 && p.c < 0) onSelect({ a: { r: 0, c: 0 }, f: { r: lastRow, c: lastCol } });
		else if (p.r < 0) onSelect({ a: { r: 0, c: p.c }, f: { r: Math.max(lastRow, 0), c: p.c } });
		else if (p.c < 0) onSelect({ a: { r: p.r, c: 0 }, f: { r: p.r, c: Math.max(lastCol, 0) } });
		else {
			// a click anywhere in a merged cell picks the cell itself
			const m = data.merges.find((x) => p.r >= x.r1 && p.r <= x.r2 && p.c >= x.c1 && p.c <= x.c2);
			const at = m ? { r: m.r1, c: m.c1 } : p;
			onSelect(extend ? { a: sel.a, f: at } : { a: at, f: at });
		}
	};
	const dragging = useRef(false);
	const pointer = useRef("mouse");

	const move = (dr: number, dc: number, extend: boolean, far: boolean) => {
		const from = extend ? sel.f : sel.a;
		const limitR = Math.max(lastRow, nRows - 1);
		const limitC = Math.max(lastCol, nCols - 1);
		const r = far ? (dr > 0 ? lastRow : dr < 0 ? 0 : from.r) : from.r + dr;
		const c = far ? (dc > 0 ? lastCol : dc < 0 ? 0 : from.c) : from.c + dc;
		const p = { r: Math.max(0, Math.min(limitR, r)), c: Math.max(0, Math.min(limitC, c)) };
		onSelect(extend ? { a: sel.a, f: p } : { a: p, f: p });
	};
	const pageRows = Math.max(1, Math.floor((view.h - HEAD_H) / data.defaultHeight) - 1);

	// merged cells around the window: drawn whole, their other cells not at all
	const merges = useMemo(() => {
		return data.merges.filter(
			(m) => m.r1 <= r1 && m.c1 <= c1 && (m.r2 >= r0 || m.r1 < fr) && (m.c2 >= c0 || m.c1 < fc),
		);
	}, [data, r0, r1, c0, c1, fr, fc]);
	const covered = useMemo(() => {
		const s = new Set<number>();
		for (const m of merges)
			for (let r = m.r1; r <= Math.min(m.r2, r1); r++)
				for (let c = m.c1; c <= Math.min(m.c2, c1 + OVERFLOW_MAX); c++) s.add(key(r, c));
		return s;
	}, [merges, r1, c1]);

	const empty = (cell: Cell | undefined) => !cell || (cell.t === "s" && cell.v === "");

	/** One cell's box at (x, y) in its pane. */
	const box = (cell: Cell, r: number, c: number, x: number, y: number, w: number, h: number) => {
		const st = styles[cell.s] ?? { fmt: "General" };
		const f = empty(cell) ? { text: "" } : show(cell);
		const num = cell.t === "n";
		const align =
			st.align ?? (num ? "right" : cell.t === "b" || cell.t === "e" ? "center" : "left");
		const ink = f.color ?? st.color;
		const style: React.CSSProperties = {
			left: x,
			top: y,
			width: w,
			height: h,
			justifyContent:
				align === "right"
					? "flex-end"
					: align === "center" || align === "centerContinuous"
						? "center"
						: "flex-start",
			textAlign:
				align === "right"
					? "right"
					: align === "center" || align === "centerContinuous"
						? "center"
						: align === "justify"
							? "justify"
							: "left",
			alignItems:
				st.valign === "top" ? "flex-start" : st.valign === "center" ? "center" : "flex-end",
		};
		if (st.fill) {
			style.background = st.fill;
			style.color = ink ?? "#000";
		} else if (ink) (style as Record<string, string>)["--ink"] = ink;
		if (st.bold) style.fontWeight = 600;
		if (st.italic) style.fontStyle = "italic";
		if (st.underline || st.strike)
			style.textDecoration = [st.underline && "underline", st.strike && "line-through"]
				.filter(Boolean)
				.join(" ");
		if (st.size) style.fontSize = Math.max(8, Math.min(40, st.size * PX_PER_PT));
		if (st.indent) style[align === "right" ? "paddingRight" : "paddingLeft"] = 4 + st.indent * 9;
		if (st.wrap) {
			style.whiteSpace = "pre-wrap";
			style.overflowWrap = "anywhere";
		}
		const hitHere = matches.has(key(r, c));
		return (
			<div
				className="xl-cell"
				data-dark-ink={!st.fill && ink && dark(ink) ? "" : undefined}
				data-match={hitHere ? "" : undefined}
				key={key(r, c)}
				style={style}
			>
				{f.text}
			</div>
		);
	};

	/** Cells of rows ra…rb and columns ca…cb, placed relative to the pane's corner (ox, oy). */
	const cells = (ra: number, rb: number, ca: number, cb: number, ox: number, oy: number) => {
		const back: ReactNode[] = [];
		const front: ReactNode[] = [];
		for (let r = ra; r <= rb; r++) {
			const row = data.cells[r];
			if (!row) continue;
			const y = rowY[r]! - oy;
			const h = rowY[r + 1]! - rowY[r]!;
			if (!h) continue;
			for (let c = ca; c <= Math.min(cb, row.length - 1); c++) {
				const cell = row[c];
				if (!cell || covered.has(key(r, c))) continue;
				let w = colX[c + 1]! - colX[c]!;
				if (!w) continue;
				const st = styles[cell.s];
				// a text runs on into empty cells to its right, as in Excel
				if (cell.t === "s" && cell.v && !st?.wrap && (!st?.align || st.align === "left")) {
					let k = c + 1;
					const stop = Math.min(nCols - 1, c + OVERFLOW_MAX, c >= fc ? cb + OVERSCAN : fc - 1);
					while (k <= stop && empty(row[k]) && !covered.has(key(r, k))) k++;
					w = colX[k]! - colX[c]!;
				}
				(empty(cell) ? back : front).push(box(cell, r, c, colX[c]! - ox, y, w, h));
			}
		}
		for (const m of merges) {
			if (m.r1 > rb || m.r2 < ra || m.c1 > cb || m.c2 < ca) continue;
			// a merge across the frozen edge is drawn where it starts
			if (m.r1 < fr !== ra < fr || m.c1 < fc !== ca < fc) continue;
			const cell = data.cells[m.r1]?.[m.c1] ?? ({ t: "s", v: "", s: 0 } as Cell);
			const x = colX[m.c1]! - ox;
			const y = rowY[m.r1]! - oy;
			const w = colX[Math.min(m.c2 + 1, nCols)]! - colX[m.c1]!;
			const h = rowY[Math.min(m.r2 + 1, nRows)]! - rowY[m.r1]!;
			front.push(
				<div
					className="xl-merge"
					key={`m${key(m.r1, m.c1)}`}
					style={{ left: x, top: y, width: w, height: h }}
				>
					{box(cell, m.r1, m.c1, 0, 0, w, h)}
				</div>,
			);
		}
		return [...back, ...front];
	};

	/** Grid lines of rows ra…rb and columns ca…cb in a pane. */
	const lines = (ra: number, rb: number, ca: number, cb: number, ox: number, oy: number) => {
		const out: ReactNode[] = [];
		const top = rowY[ra]! - oy;
		const bottom = rowY[rb + 1]! - oy;
		const left = colX[ca]! - ox;
		const right = colX[cb + 1]! - ox;
		for (let c = ca; c <= cb; c++)
			out.push(
				<div
					className="xl-line"
					key={`v${c}`}
					style={{ left: colX[c + 1]! - ox - 1, top, width: 1, height: bottom - top }}
				/>,
			);
		for (let r = ra; r <= rb; r++)
			out.push(
				<div
					className="xl-line"
					key={`h${r}`}
					style={{ left, top: rowY[r + 1]! - oy - 1, width: right - left, height: 1 }}
				/>,
			);
		return out;
	};

	const colHeads = (ca: number, cb: number, ox: number) => {
		const out: ReactNode[] = [];
		for (let c = ca; c <= cb; c++) {
			const w = colX[c + 1]! - colX[c]!;
			if (!w) continue;
			out.push(
				<div
					className="xl-head"
					data-on={c >= range.c1 && c <= range.c2 ? "" : undefined}
					key={`c${c}`}
					style={{ left: colX[c]! - ox, top: 0, width: w, height: HEAD_H }}
				>
					{colName(c)}
				</div>,
			);
		}
		return out;
	};
	const rowHeads = (ra: number, rb: number, oy: number) => {
		const out: ReactNode[] = [];
		for (let r = ra; r <= rb; r++) {
			const h = rowY[r + 1]! - rowY[r]!;
			if (!h) continue;
			out.push(
				<div
					className="xl-head"
					data-on={r >= range.r1 && r <= range.r2 ? "" : undefined}
					key={`r${r}`}
					style={{ left: 0, top: rowY[r]! - oy, width: RH, height: h }}
				>
					{r + 1}
				</div>,
			);
		}
		return out;
	};

	// the selection as a frame; one merged cell selects all of it
	const anchorMerge = data.merges.find((m) => m.r1 === sel.a.r && m.c1 === sel.a.c);
	const frame =
		anchorMerge && sel.a.r === sel.f.r && sel.a.c === sel.f.c
			? anchorMerge
			: {
					r1: range.r1,
					c1: range.c1,
					r2: Math.min(range.r2, nRows - 1),
					c2: Math.min(range.c2, nCols - 1),
				};
	const selBox = (ox: number, oy: number) => {
		if (frame.r1 >= nRows || frame.c1 >= nCols) return null;
		const x = colX[frame.c1]! - ox;
		const y = rowY[frame.r1]! - oy;
		const w = colX[frame.c2 + 1]! - colX[frame.c1]!;
		const h = rowY[frame.r2 + 1]! - rowY[frame.r1]!;
		const multi = frame.r1 !== frame.r2 || frame.c1 !== frame.c2;
		return (
			<div
				className="xl-sel"
				data-range={multi && !anchorMerge ? "" : undefined}
				style={{ left: x - 1, top: y - 1, width: w + 1, height: h + 1 }}
			/>
		);
	};

	const frR = fr - 1;
	const frC = fc - 1;
	return (
		// biome-ignore lint/a11y/useSemanticElements: a table element can't hold only the cells in view
		<div
			aria-label={t("sheet.grid")}
			className="xl-scroll absolute inset-0 overflow-auto outline-none"
			onClick={(e) => {
				if (pointer.current === "mouse") return;
				const p = cellAt(e.clientX, e.clientY);
				if (p) pick(p, false);
			}}
			onCopy={(e) => {
				e.preventDefault();
				const rows = Math.min(range.r2, data.rows - 1) - range.r1 + 1;
				const cols = Math.min(range.c2, data.cols - 1) - range.c1 + 1;
				if (rows * cols > COPY_MAX) {
					notify(t("sheet.copyTooLarge", { count: fmtNumber(lang, COPY_MAX) }));
					return;
				}
				e.clipboardData.setData("text/plain", rangeText(data, range, show));
			}}
			onKeyDown={(e) => {
				const far = e.ctrlKey || e.metaKey;
				const k = e.key;
				const go = (dr: number, dc: number) => {
					e.preventDefault();
					move(dr, dc, e.shiftKey, far);
				};
				if (k === "ArrowDown") go(1, 0);
				else if (k === "ArrowUp") go(-1, 0);
				else if (k === "ArrowRight") go(0, 1);
				else if (k === "ArrowLeft") go(0, -1);
				else if (k === "Enter") go(e.shiftKey ? -1 : 1, 0);
				else if (k === "PageDown") {
					e.preventDefault();
					move(pageRows, 0, e.shiftKey, false);
				} else if (k === "PageUp") {
					e.preventDefault();
					move(-pageRows, 0, e.shiftKey, false);
				} else if (k === "Home") {
					e.preventDefault();
					const p = far ? { r: 0, c: 0 } : { r: sel.f.r, c: 0 };
					onSelect(e.shiftKey ? { a: sel.a, f: p } : { a: p, f: p });
				} else if (k === "End" && far) {
					e.preventDefault();
					const p = { r: lastRow, c: lastCol };
					onSelect(e.shiftKey ? { a: sel.a, f: p } : { a: p, f: p });
				} else if (k === "a" && far) {
					e.preventDefault();
					onSelect({ a: { r: 0, c: 0 }, f: { r: lastRow, c: lastCol } });
				}
			}}
			onPointerDown={(e) => {
				pointer.current = e.pointerType;
				if (e.pointerType !== "mouse" || e.button !== 0) return;
				const p = cellAt(e.clientX, e.clientY);
				if (!p) return;
				scroller.current!.focus({ preventScroll: true });
				e.preventDefault();
				pick(p, e.shiftKey);
				if (p.r >= 0 && p.c >= 0) {
					dragging.current = true;
					e.currentTarget.setPointerCapture(e.pointerId);
				}
			}}
			onPointerMove={(e) => {
				if (!dragging.current) return;
				const el = scroller.current!;
				const box = el.getBoundingClientRect();
				// past the edge: one row or column further
				const x = Math.max(box.left + RH + 1, Math.min(e.clientX, box.left + el.clientWidth - 1));
				const y = Math.max(
					box.top + HEAD_H + 1,
					Math.min(e.clientY, box.top + el.clientHeight - 1),
				);
				const p = cellAt(x, y);
				if (!p || p.r < 0 || p.c < 0) return;
				if (e.clientY > box.top + el.clientHeight) p.r = Math.min(nRows - 1, p.r + 1);
				if (e.clientX > box.left + el.clientWidth) p.c = Math.min(nCols - 1, p.c + 1);
				if (p.r !== sel.f.r || p.c !== sel.f.c) onSelect({ a: sel.a, f: p });
			}}
			onPointerUp={() => {
				dragging.current = false;
			}}
			onScroll={(e) => {
				const el = e.currentTarget;
				setView((v) => ({ ...v, left: el.scrollLeft, top: el.scrollTop }));
			}}
			ref={scroller}
			role="grid"
			tabIndex={0}
		>
			<div
				className="grid"
				style={{
					gridTemplateColumns: `${RH + FW}px ${Math.max(0, totalW - FW)}px`,
					gridTemplateRows: `${HEAD_H + FH}px ${Math.max(0, totalH - FH)}px`,
				}}
			>
				{/* top left: the corner, frozen columns' letters, frozen rows' numbers, frozen cells */}
				<div
					className="xl-pane sticky top-0 left-0 z-[3]"
					data-edge-b={fr ? "" : undefined}
					data-edge-r={fc ? "" : undefined}
				>
					<div className="xl-head" style={{ left: 0, top: 0, width: RH, height: HEAD_H }} />
					{fc > 0 && colHeads(0, frC, -RH)}
					{fr > 0 && rowHeads(0, frR, -HEAD_H)}
					{fr > 0 && fc > 0 && lines(0, frR, 0, frC, -RH, -HEAD_H)}
					{fr > 0 && fc > 0 && cells(0, frR, 0, frC, -RH, -HEAD_H)}
					{fr > 0 && fc > 0 && selBox(-RH, -HEAD_H)}
				</div>
				{/* top: column letters and frozen rows */}
				<div className="xl-pane sticky top-0 z-[2]" data-edge-b={fr ? "" : undefined}>
					{colHeads(c0, c1, FW)}
					{fr > 0 && lines(0, frR, c0, c1, FW, -HEAD_H)}
					{fr > 0 && cells(0, frR, c0, c1, FW, -HEAD_H)}
					{fr > 0 && selBox(FW, -HEAD_H)}
				</div>
				{/* left: row numbers and frozen columns */}
				<div className="xl-pane sticky left-0 z-[2]" data-edge-r={fc ? "" : undefined}>
					{rowHeads(r0, r1, FH)}
					{fc > 0 && lines(r0, r1, 0, frC, -RH, FH)}
					{fc > 0 && cells(r0, r1, 0, frC, -RH, FH)}
					{fc > 0 && selBox(-RH, FH)}
				</div>
				{/* the cells that scroll */}
				<div className="xl-pane relative">
					{lines(r0, r1, c0, c1, FW, FH)}
					{cells(r0, r1, c0, c1, FW, FH)}
					{selBox(FW, FH)}
				</div>
			</div>
		</div>
	);
}
