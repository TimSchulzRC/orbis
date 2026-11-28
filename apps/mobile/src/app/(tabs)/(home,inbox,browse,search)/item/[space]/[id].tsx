// An entry's page: where it lives, its title and when it changed, properties and text, what sits
// below it, its updates and who links to it. The pencil opens the text in a full-screen editor.

import { dateOf } from "@orbis/core/date";
import { mergeText } from "@orbis/core/diff";
import { fmtBytes, fmtDate, fmtRecent } from "@orbis/core/i18n";
import { type Item, META_TYPE } from "@orbis/core/model";
import type { Repo } from "@orbis/sync";
import { router, Stack, useIsPreview, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import {
	Alert,
	KeyboardAvoidingView,
	Pressable,
	Share,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRepo } from "../../../../../lib/hooks";
import { lang, t, titleOf } from "../../../../../lib/i18n";
import { confirmDelete, typeHref, useTab } from "../../../../../ui/item";
import { Empty, Icon, Row, Screen, Section } from "../../../../../ui/list";
import { lookOf, typeSymbol } from "../../../../../ui/look";
import { Markdown } from "../../../../../ui/markdown";
import { Below, Mentions, Path, Updates } from "../../../../../ui/page";
import { Properties } from "../../../../../ui/props";
import { SpaceGone } from "../../../../../ui/status";
import { C, GUTTER } from "../../../../../ui/theme";

const SAVE_MS = 600;

export default function ItemPage() {
	const { space, id, edit } = useLocalSearchParams<{ space: string; id: string; edit?: string }>();
	const repo = useRepo(space);
	if (!repo) return <SpaceGone />;
	return <Page edit={edit} id={id} repo={repo} space={space} />;
}

function Page({ space, id, edit, repo }: { space: string; id: string; edit?: string; repo: Repo }) {
	const tab = useTab();
	// the page as a long press preview: no title or toolbar to set (it would change the list's)
	const preview = useIsPreview();
	const [editing, setEditing] = useState(edit === "1");
	const [scrolled, setScrolled] = useState(false);
	const ix = repo.index();
	const item = repo.get(id);
	if (!item)
		return (
			<>
				<Stack.Screen options={{ title: "" }} />
				<Empty
					symbol={repo.status.synced ? "questionmark.circle" : "icloud.and.arrow.down"}
					title={repo.status.synced ? t("item.missing") : t("item.loading")}
				/>
			</>
		);
	if (editing) return <BodyEditor id={id} onDone={() => setEditing(false)} repo={repo} />;

	const look = lookOf(item, ix);
	const props = { item, ix, repo, space, tab };
	const types = ix.typesByName();
	const isType = item.type === META_TYPE;
	return (
		<>
			{!preview && (
				<>
					<Stack.Screen options={{ title: scrolled ? titleOf(item) : "" }} />
					<Stack.Toolbar placement="right">
						{item.kind === "note" && !isType && (
							<Stack.Toolbar.Button icon="square.and.pencil" onPress={() => setEditing(true)}>
								{t("mobile.editText")}
							</Stack.Toolbar.Button>
						)}
						<Stack.Toolbar.Menu icon="ellipsis">
							{item.kind === "note" && !isType && (
								<Stack.Toolbar.Menu icon="tag" title={t("triage.type")}>
									<Stack.Toolbar.MenuAction
										icon="doc.text"
										isOn={!item.type}
										onPress={() => repo.ownStep(() => repo.setType(item.id, null))}
									>
										{t("kind.note")}
									</Stack.Toolbar.MenuAction>
									{types.map((type) => (
										<Stack.Toolbar.MenuAction
											icon={typeSymbol(type.schema)}
											isOn={item.type === type.id}
											key={type.id}
											onPress={() => repo.ownStep(() => repo.setType(item.id, type.id))}
										>
											{type.schema.name}
										</Stack.Toolbar.MenuAction>
									))}
								</Stack.Toolbar.Menu>
							)}
							<Stack.Toolbar.MenuAction
								icon="folder"
								onPress={() => router.push({ pathname: "/place", params: { space, id } })}
							>
								{t("triage.place")}
							</Stack.Toolbar.MenuAction>
							<Stack.Toolbar.MenuAction
								icon={item.pinned ? "pin.slash" : "pin"}
								onPress={() => repo.ownStep(() => repo.pin(item.id, !item.pinned))}
							>
								{item.pinned ? t("item.unpin") : t("item.pin")}
							</Stack.Toolbar.MenuAction>
							{isType && (
								<Stack.Toolbar.MenuAction
									icon="list.bullet"
									onPress={() => router.push(typeHref(tab, space, item.id))}
								>
									{ix.typePlural(item.id)}
								</Stack.Toolbar.MenuAction>
							)}
							<Stack.Toolbar.MenuAction
								icon="square.and.arrow.up"
								onPress={() =>
									void Share.share({
										message: [titleOf(item), item.body.trim()].filter(Boolean).join("\n\n"),
									})
								}
							>
								{t("mobile.share")}
							</Stack.Toolbar.MenuAction>
							{!item.deleted && (
								<Stack.Toolbar.MenuAction
									destructive
									icon="trash"
									onPress={() => confirmDelete(repo, item, () => router.back())}
								>
									{t("item.delete")}
								</Stack.Toolbar.MenuAction>
							)}
						</Stack.Toolbar.Menu>
					</Stack.Toolbar>
				</>
			)}
			<Screen
				keyboard
				onScroll={(e) => setScrolled(e.nativeEvent.contentOffset.y > 40)}
				scrollEventThrottle={64}
			>
				<View style={styles.head}>
					<Path {...props} />
					<View style={styles.kind}>
						<Icon color={look.color} name={look.symbol} size={15} />
						<Text style={[styles.kindText, { color: look.color }]}>{look.kind}</Text>
					</View>
					<TitleField id={id} repo={repo} title={item.title} />
					<Text style={styles.dates}>{datesOf(item)}</Text>
				</View>
				{item.deleted && (
					<Section>
						<Row
							icon={<Icon color={C.red} name="trash" />}
							onPress={() => repo.ownStep(() => repo.restore(item.id))}
							subtitle={t("item.inTrash")}
							title={<Text style={{ color: C.accent }}>{t("item.restore")}</Text>}
						/>
					</Section>
				)}
				<Properties {...props} />
				{item.file && (
					<Section>
						<Row detail={item.file.name} title={t("kind.file")} />
						<Row detail={fmtBytes(lang, item.file.size)} title={t("file.size")} />
					</Section>
				)}
				{item.kind === "note" && (
					<Pressable onPress={() => !isType && setEditing(true)} style={styles.body}>
						{item.body.trim() ? (
							<Markdown body={item.body} item={item} ix={ix} repo={repo} space={space} tab={tab} />
						) : (
							!isType && !preview && <Text style={styles.placeholder}>{t("mobile.writeHere")}</Text>
						)}
					</Pressable>
				)}
				<Below {...props} />
				<Updates {...props} />
				<Mentions {...props} />
			</Screen>
		</>
	);
}

const LONG_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };

/** When the entry last changed and when it was made, as in the web app: the change reads relative
 * up to yesterday, older ones as a date. */
function datesOf(item: Pick<Item, "created" | "updated">): string {
	const long = (ts: number) => fmtDate(lang, dateOf(ts), LONG_DATE);
	const recent = fmtRecent(lang, item.updated);
	const edited = recent
		? `${t("item.edited")} ${recent}`
		: t("page.editedOn", { date: long(item.updated) });
	return `${edited} · ${t("page.createdOn", { date: long(item.created) })}`;
}

/** The title in place: saved when editing ends (links to it follow the new title). */
function TitleField({ id, title, repo }: { id: string; title: string; repo: Repo }) {
	const [text, setText] = useState(title);
	const focused = useRef(false);
	// typed and not saved yet: only that is ever written (a title is never trimmed just by looking)
	const dirty = useRef(false);
	const latest = useRef(text);
	latest.current = text;
	useEffect(() => {
		if (!focused.current && !dirty.current) setText(title);
	}, [title]);
	const save = () => {
		if (!dirty.current) return;
		dirty.current = false;
		const next = latest.current.trim();
		if (next !== repo.get(id)?.title) repo.ownStep(() => repo.setTitle(id, next));
	};
	// leaving the page while still typing keeps the title too
	// biome-ignore lint/correctness/useExhaustiveDependencies: saves once, when the page goes
	useEffect(() => () => save(), []);
	return (
		<TextInput
			autoFocus={!title}
			blurOnSubmit
			multiline
			onBlur={() => {
				focused.current = false;
				save();
			}}
			onChangeText={(v) => {
				dirty.current = true;
				setText(v.replace(/\n/g, " "));
			}}
			onFocus={() => {
				focused.current = true;
			}}
			placeholder={t("untitled")}
			placeholderTextColor={C.placeholder}
			returnKeyType="done"
			scrollEnabled={false}
			selectionColor={C.accent}
			style={styles.title}
			submitBehavior="blurAndSubmit"
			value={text}
		/>
	);
}

/** The text as Markdown source over the whole page, saved while typing. */
function BodyEditor({ id, repo, onDone }: { id: string; repo: Repo; onDone: () => void }) {
	const item = repo.get(id);
	const body = item?.body ?? "";
	const [text, setText] = useState(body);
	const saved = useRef(body);
	const latest = useRef(text);
	latest.current = text;
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const open = useRef(true);
	/**
	 * `saved` is the text the draft started from. Changed elsewhere meanwhile (another device, an
	 * agent), the draft's own edits go onto that text instead of replacing it.
	 */
	const asking = useRef(false);
	/** Too far apart to merge: the user keeps one of the two (the other stays in the history). */
	const choose = (next: string, current: string) => {
		if (asking.current) return;
		asking.current = true;
		const settle = (text: string) => {
			asking.current = false;
			saved.current = text;
			latest.current = text;
			if (text !== repo.get(id)?.body) repo.setBody(id, text);
			if (open.current) setText(text);
		};
		Alert.alert(t("mobile.clash.title"), t("mobile.clash.body"), [
			{ text: t("mobile.clash.mine"), onPress: () => settle(next) },
			{ text: t("mobile.clash.theirs"), onPress: () => settle(current) },
		]);
	};
	const save = (next: string) => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		if (next === saved.current || asking.current) return;
		const current = repo.get(id)?.body ?? "";
		const merged = mergeText(saved.current, next, current);
		if (merged === undefined) return choose(next, current);
		saved.current = merged;
		latest.current = merged; // closing right after (Done) must not save the draft over it
		if (merged !== current) repo.setBody(id, merged);
		if (merged !== next && open.current) setText(merged);
	};
	// a change from elsewhere arrives while nothing is unsaved here: take it
	useEffect(() => {
		if (body !== saved.current && latest.current === saved.current) {
			saved.current = body;
			setText(body);
		}
	}, [body]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: saves once, when the editor goes
	useEffect(
		() => () => {
			open.current = false;
			save(latest.current);
		},
		[],
	);
	const finish = () => {
		save(text);
		onDone();
	};
	const top = useHeaderHeight();
	const { bottom } = useSafeAreaInsets();
	return (
		<>
			<Stack.Screen options={{ title: item ? titleOf(item) : "" }} />
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button onPress={finish} variant="done">
					{t("mobile.done")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			{/* The text view scrolls itself and keeps the caret in view, as in Notes. In a ScrollView
			    with keyboard insets the focus pushed the text up under the navigation bar. */}
			<KeyboardAvoidingView behavior="padding" style={styles.editor}>
				<TextInput
					autoFocus
					multiline
					onChangeText={(v) => {
						setText(v);
						if (timer.current) clearTimeout(timer.current);
						timer.current = setTimeout(() => save(v), SAVE_MS);
					}}
					placeholder={t("mobile.writeHere")}
					placeholderTextColor={C.placeholder}
					selectionColor={C.accent}
					style={[styles.editorInput, { paddingTop: top + 8, paddingBottom: bottom + 24 }]}
					value={text}
				/>
			</KeyboardAvoidingView>
		</>
	);
}

const styles = StyleSheet.create({
	head: { gap: 6, marginHorizontal: GUTTER + 4, marginTop: 8 },
	kind: { alignItems: "center", flexDirection: "row", gap: 6 },
	kindText: { fontSize: 15, fontWeight: "600" },
	title: { color: C.label, fontSize: 30, fontWeight: "700", lineHeight: 36, padding: 0 },
	body: { marginHorizontal: GUTTER + 4, marginTop: 22, minHeight: 60 },
	placeholder: { color: C.placeholder, fontSize: 17 },
	dates: { color: C.secondary, fontSize: 13 },
	editor: { backgroundColor: C.plain, flex: 1 },
	editorInput: {
		color: C.label,
		flex: 1,
		fontSize: 17,
		lineHeight: 25,
		paddingHorizontal: GUTTER + 4,
	},
});
