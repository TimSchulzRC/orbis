// A page's Markdown as native text: headings, lists with checkboxes that tick, quotes, code,
// tables, [[links]] to other entries, ```query blocks as live lists and ```excalidraw blocks by name.

import { DRAWING_INFO } from "@orbis/core/drawing";
import type { Index } from "@orbis/core/graph";
import { type Item, todayISO, wikiLinkRe } from "@orbis/core/model";
import { readBlock, runQuery, tabDef } from "@orbis/core/query";
import { dueOf, isDone, statusProp } from "@orbis/core/traits";
import type { Repo } from "@orbis/sync";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { Marked, type Token, type TokenizerExtension, type Tokens } from "marked";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { t, titleOf } from "../lib/i18n";
import { toggleTask } from "../lib/text";
import { DueText, itemHref, StatusCircle } from "./item";
import { Icon } from "./list";
import { lookOf } from "./look";
import { C } from "./theme";

interface WikiToken {
	type: "wikilink";
	raw: string;
	embed: boolean;
	target: string;
	label?: string;
}

const wikilink: TokenizerExtension = {
	name: "wikilink",
	level: "inline",
	start(src) {
		const i = src.indexOf("[[");
		return i > 0 && src[i - 1] === "!" ? i - 1 : i;
	},
	tokenizer(src) {
		const m = wikiLinkRe(true).exec(src);
		if (!m) return;
		return {
			type: "wikilink",
			raw: m[0],
			embed: m[1] === "!",
			target: m[2]!.trim(),
			label: m[4]?.slice(1).trim() || undefined,
		} satisfies WikiToken;
	},
};

const marked = new Marked({ gfm: true, extensions: [wikilink] });

interface Ctx {
	space: string;
	tab: string;
	ix: Index;
	repo: Repo;
	item: Item;
	/** The text the page shows, its blocks, and where each checkbox stands in them. */
	body: string;
	tokens: Token[];
	tasks: Map<Tokens.ListItem, TaskAt>;
}

/** Where a checkbox stands: its top-level block of the text, and its place among that block's. */
interface TaskAt {
	block: number;
	n: number;
}

/**
 * Numbers each block's checkboxes in the order they stand in the text, nested ones included.
 * (Counting while rendering would not: nested lists render after their parent's later items.)
 */
function taskOrder(tokens: Token[]): Map<Tokens.ListItem, TaskAt> {
	const order = new Map<Tokens.ListItem, TaskAt>();
	for (const [block, top] of tokens.entries()) {
		let n = 0;
		const walk = (list: Token[]) => {
			for (const tok of list) {
				if (tok.type === "list")
					for (const li of (tok as Tokens.List).items) {
						if (li.task) order.set(li, { block, n: n++ });
						walk(li.tokens);
					}
				else if ("tokens" in tok && tok.tokens) walk(tok.tokens);
			}
		};
		walk([top]);
	}
	return order;
}

/**
 * Ticks the checkbox inside its own top-level block of the text (blocks are the lexer's tokens, whose
 * sources make up the text): a code block elsewhere that looks like it never counts. The lexer
 * reads Windows line ends as plain ones, and so does the text it writes back.
 */
function tickIn(source: string, tokens: Token[], at: TaskAt, raw: string): string {
	const body = source.replace(/\r\n?/g, "\n");
	if (tokens.map((x) => x.raw).join("") !== body) return source; // the blocks do not add up: leave it
	const start = tokens.slice(0, at.block).reduce((n, x) => n + x.raw.length, 0);
	const end = start + (tokens[at.block]?.raw.length ?? 0);
	const block = body.slice(start, end);
	const ticked = toggleTask(block, at.n, raw);
	return ticked === block ? source : body.slice(0, start) + ticked + body.slice(end);
}

export function Markdown({ body, space, tab, ix, repo, item }: Omit<Ctx, "tasks" | "tokens">) {
	const tokens = useMemo(() => marked.lexer(body), [body]);
	const tasks = useMemo(() => taskOrder(tokens), [tokens]);
	const ctx: Ctx = { space, tab, ix, repo, item, body, tokens, tasks };
	return <View style={styles.doc}>{blocks(tokens, ctx)}</View>;
}

function blocks(tokens: Token[], ctx: Ctx): ReactNode[] {
	// biome-ignore lint/suspicious/noArrayIndexKey: parsed Markdown has no ids; it is rebuilt with the text
	return tokens.map((tok, i) => <Fragment key={i}>{block(tok, ctx)}</Fragment>);
}

function block(tok: Token, ctx: Ctx): ReactNode {
	switch (tok.type) {
		case "space":
		case "def":
			return null;
		case "heading": {
			const h = tok as Tokens.Heading;
			return (
				<Text style={[styles.text, HEADINGS[h.depth - 1] ?? HEADINGS[2]]}>
					{inline(h.tokens, ctx)}
				</Text>
			);
		}
		case "paragraph":
			return <Text style={styles.text}>{inline((tok as Tokens.Paragraph).tokens, ctx)}</Text>;
		case "text": {
			const x = tok as Tokens.Text;
			return <Text style={styles.text}>{x.tokens ? inline(x.tokens, ctx) : x.text}</Text>;
		}
		case "list":
			return <List ctx={ctx} list={tok as Tokens.List} />;
		case "blockquote":
			return <View style={styles.quote}>{blocks((tok as Tokens.Blockquote).tokens, ctx)}</View>;
		case "code": {
			const code = tok as Tokens.Code;
			if (code.lang?.startsWith("query"))
				return <QueryBlock ctx={ctx} src={`${code.lang.slice(5)}\n${code.text}`.trim()} />;
			if (code.lang?.trim() === DRAWING_INFO)
				return <DrawingBlock ctx={ctx} id={code.text.trim()} />;
			return (
				<View style={styles.code}>
					<Text selectable style={styles.mono}>
						{code.text}
					</Text>
				</View>
			);
		}
		case "hr":
			return <View style={styles.hr} />;
		case "table": {
			const table = tok as Tokens.Table;
			return (
				<View style={styles.table}>
					{[table.header, ...table.rows].map((row, r) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: parsed Markdown has no ids; it is rebuilt with the text
						<View key={r} style={[styles.tr, r === 0 && styles.th]}>
							{row.map((cell, c) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: parsed Markdown has no ids; it is rebuilt with the text
								<Text key={c} style={[styles.td, r === 0 && { fontWeight: "600" }]}>
									{inline(cell.tokens, ctx)}
								</Text>
							))}
						</View>
					))}
				</View>
			);
		}
		case "html":
			return <Text style={styles.text}>{(tok as Tokens.HTML).text}</Text>;
		default:
			return "tokens" in tok && tok.tokens ? (
				<Text style={styles.text}>{inline(tok.tokens, ctx)}</Text>
			) : null;
	}
}

function List({ list, ctx }: { list: Tokens.List; ctx: Ctx }) {
	return (
		<View style={styles.list}>
			{list.items.map((li, i) => {
				let marker: ReactNode;
				if (li.task) {
					const at = ctx.tasks.get(li);
					marker = (
						<Pressable
							hitSlop={8}
							onPress={() => {
								// only the text this page shows: changed meanwhile, the tap counts for nothing
								const now = ctx.repo.get(ctx.item.id)?.body;
								if (now !== ctx.body || !at) return;
								const next = tickIn(now, ctx.tokens, at, li.raw);
								if (next === now) return;
								void Haptics.selectionAsync();
								ctx.repo.ownStep(() => ctx.repo.setBody(ctx.item.id, next));
							}}
						>
							<Icon
								color={li.checked ? C.ok : C.faint}
								name={li.checked ? "checkmark.square.fill" : "square"}
								size={20}
							/>
						</Pressable>
					);
				} else
					marker = (
						<Text style={styles.marker}>
							{list.ordered ? `${(Number(list.start) || 1) + i}.` : "•"}
						</Text>
					);
				const content = li.tokens.filter((x) => x.type !== "checkbox");
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: parsed Markdown has no ids; it is rebuilt with the text
					<View key={i} style={styles.li}>
						<View style={styles.markerBox}>{marker}</View>
						<View style={[styles.liBody, li.task && li.checked && styles.checked]}>
							{blocks(content, ctx)}
						</View>
					</View>
				);
			})}
		</View>
	);
}

function inline(tokens: Token[] | undefined, ctx: Ctx): ReactNode[] {
	// biome-ignore lint/suspicious/noArrayIndexKey: parsed Markdown has no ids; it is rebuilt with the text
	return (tokens ?? []).map((tok, i) => <Fragment key={i}>{span(tok, ctx)}</Fragment>);
}

function span(tok: Token, ctx: Ctx): ReactNode {
	switch (tok.type) {
		case "text": {
			const x = tok as Tokens.Text;
			return x.tokens ? inline(x.tokens, ctx) : x.text;
		}
		case "escape":
			return (tok as Tokens.Escape).text;
		case "strong":
			return (
				<Text style={{ fontWeight: "700" }}>{inline((tok as Tokens.Strong).tokens, ctx)}</Text>
			);
		case "em":
			return <Text style={{ fontStyle: "italic" }}>{inline((tok as Tokens.Em).tokens, ctx)}</Text>;
		case "del":
			return (
				<Text style={{ textDecorationLine: "line-through" }}>
					{inline((tok as Tokens.Del).tokens, ctx)}
				</Text>
			);
		case "codespan":
			return <Text style={styles.codespan}>{(tok as Tokens.Codespan).text}</Text>;
		case "br":
			return "\n";
		case "link": {
			const link = tok as Tokens.Link;
			return (
				<Text onPress={() => void Linking.openURL(link.href)} style={styles.link}>
					{inline(link.tokens, ctx)}
				</Text>
			);
		}
		case "image":
			return (
				<Text style={styles.link}>{(tok as Tokens.Image).text || (tok as Tokens.Image).href}</Text>
			);
		case "wikilink": {
			const w = tok as unknown as WikiToken;
			const id = ctx.ix.resolveTitle(w.target);
			const target = id ? ctx.ix.get(id) : undefined;
			const label = w.label ?? (target ? titleOf(target) : w.target);
			if (!target) return <Text style={styles.missing}>{label}</Text>;
			return (
				<Text
					onPress={() => router.push(itemHref(ctx.tab, ctx.space, target.id))}
					style={styles.wiki}
				>
					{w.embed ? `▸ ${label}` : label}
				</Text>
			);
		}
		case "checkbox":
			return null;
		case "html":
			return (tok as Tokens.HTML).text;
		default:
			return "text" in tok ? String(tok.text) : null;
	}
}

const QUERY_ROWS = 25;

/** A ```query block: its entries as a small live list. */
function QueryBlock({ src, ctx }: { src: string; ctx: Ctx }) {
	const { ix } = ctx;
	const { def } = readBlock(src, ix);
	const tabs = def.tabs ?? [];
	const [chosen, choose] = useState(0);
	const tab = tabs[chosen] ?? tabs[0];
	const result = runQuery(tab ? { ...tabDef(def.where, tab), limit: def.limit } : def, {
		ix,
		thisId: ctx.item.id,
		today: todayISO(),
	});
	const shown = result.items.slice(0, QUERY_ROWS);
	return (
		<View style={styles.query}>
			{def.title ? <Text style={styles.queryTitle}>{def.title}</Text> : null}
			{tabs.length > 1 && (
				<View style={styles.tabs}>
					{tabs.map((x, i) => (
						<Pressable
							accessibilityRole="tab"
							accessibilityState={{ selected: x === tab }}
							key={x.id}
							onPress={() => choose(i)}
							style={[styles.tab, x === tab && styles.tabOn]}
						>
							<Text style={[styles.tabText, x === tab && styles.tabTextOn]}>
								{x.name || t(`view.${x.kind}`)}
							</Text>
						</Pressable>
					))}
				</View>
			)}
			{shown.length === 0 && <Text style={styles.queryEmpty}>{t("view.emptyFiltered")}</Text>}
			{shown.map((x) => {
				const look = lookOf(x, ix);
				const schema = ix.schemaOf(x);
				return (
					<Pressable
						key={x.id}
						onPress={() => router.push(itemHref(ctx.tab, ctx.space, x.id))}
						style={({ pressed }) => [styles.queryRow, pressed && { opacity: 0.5 }]}
					>
						<StatusCircle item={x} ix={ix} repo={ctx.repo} />
						{!statusProp(schema) && <Icon color={look.color} name={look.symbol} size={18} />}
						<Text numberOfLines={1} style={[styles.queryText, isDone(x, schema) && styles.checked]}>
							{titleOf(x)}
						</Text>
						<DueText done={isDone(x, schema)} due={dueOf(x, schema)} />
					</Pressable>
				);
			})}
			{result.total > shown.length && (
				<Text style={styles.queryEmpty}>
					{t("mobile.more", { count: result.total - shown.length })}
				</Text>
			)}
		</View>
	);
}

/** A ```excalidraw block: the phone does not draw the scene; it names it and shows its words. */
function DrawingBlock({ id, ctx }: { id: string; ctx: Ctx }) {
	const words = ctx.item.drawings?.[id]?.text.trim();
	return (
		<View style={[styles.query, styles.drawing]}>
			<Icon color={C.accent} name="scribble" size={18} />
			<View style={styles.drawingBody}>
				<Text style={styles.queryText}>{t("drawing.name")}</Text>
				{words ? (
					<Text numberOfLines={3} style={styles.drawingWords}>
						{words}
					</Text>
				) : null}
			</View>
		</View>
	);
}

const H = StyleSheet.create({
	h1: { fontSize: 26, fontWeight: "700", lineHeight: 32, marginTop: 10 },
	h2: { fontSize: 22, fontWeight: "700", lineHeight: 28, marginTop: 8 },
	h3: { fontSize: 19, fontWeight: "600", lineHeight: 25, marginTop: 6 },
	h4: { fontSize: 17, fontWeight: "600", lineHeight: 23, marginTop: 4 },
});
const HEADINGS = [H.h1, H.h2, H.h3, H.h4, H.h4, H.h4];

const styles = StyleSheet.create({
	doc: { gap: 10 },
	text: { color: C.label, fontSize: 17, lineHeight: 25 },
	list: { gap: 6 },
	li: { flexDirection: "row", gap: 8 },
	markerBox: { alignItems: "flex-end", minWidth: 20, paddingTop: 2 },
	marker: { color: C.secondary, fontSize: 17, lineHeight: 22 },
	liBody: { flex: 1, gap: 6 },
	checked: { opacity: 0.5 },
	quote: { borderLeftColor: C.accent, borderLeftWidth: 3, gap: 8, paddingLeft: 12 },
	code: { backgroundColor: C.fill, borderRadius: 10, padding: 12 },
	mono: { color: C.label, fontFamily: "Menlo", fontSize: 14, lineHeight: 20 },
	codespan: { backgroundColor: C.fill, fontFamily: "Menlo", fontSize: 15 },
	hr: { backgroundColor: C.separator, height: StyleSheet.hairlineWidth, marginVertical: 8 },
	table: {
		borderColor: C.separator,
		borderRadius: 8,
		borderWidth: StyleSheet.hairlineWidth,
		overflow: "hidden",
	},
	tr: {
		borderTopColor: C.separator,
		borderTopWidth: StyleSheet.hairlineWidth,
		flexDirection: "row",
	},
	th: { backgroundColor: C.fill, borderTopWidth: 0 },
	td: { color: C.label, flex: 1, fontSize: 14, padding: 8 },
	link: { color: C.link },
	wiki: { color: C.accent, fontWeight: "500" },
	missing: { color: C.secondary, textDecorationLine: "underline", textDecorationStyle: "dotted" },
	query: {
		backgroundColor: C.card,
		borderRadius: 16,
		gap: 2,
		paddingHorizontal: 12,
		paddingVertical: 8,
	},
	tabs: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingBottom: 4 },
	tab: { backgroundColor: C.fill, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
	tabOn: { backgroundColor: C.accent },
	tabText: { color: C.secondary, fontSize: 13, fontWeight: "500" },
	tabTextOn: { color: "#fff" },
	queryTitle: { color: C.secondary, fontSize: 13, fontWeight: "600", paddingVertical: 4 },
	queryRow: { alignItems: "center", flexDirection: "row", gap: 10, minHeight: 40 },
	queryText: { color: C.label, flex: 1, fontSize: 16 },
	queryEmpty: { color: C.secondary, fontSize: 14, paddingVertical: 6 },
	drawing: { alignItems: "center", flexDirection: "row", gap: 10, minHeight: 52 },
	drawingBody: { flex: 1, gap: 2 },
	drawingWords: { color: C.secondary, fontSize: 14 },
});
