// An entry's page: where it lives, its title, properties and text, what sits below it, its
// updates and who links to it. The pencil opens the text in a full-screen editor.

import { fmtBytes, fmtDateTime } from "@obtion/core/i18n";
import { META_TYPE } from "@obtion/core/model";
import type { Repo } from "@obtion/sync";
import { router, Stack, useIsPreview, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import {
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
import { C, GUTTER } from "../../../../../ui/theme";

const SAVE_MS = 600;

export default function ItemPage() {
	const { space, id, edit } = useLocalSearchParams<{ space: string; id: string; edit?: string }>();
	const repo = useRepo(space);
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
				<Text style={styles.meta}>
					{t("page.createdOn", { date: fmtDateTime(lang, item.created) })} ·{" "}
					{t("mobile.editedOn", { date: fmtDateTime(lang, item.updated) })}
				</Text>
			</Screen>
		</>
	);
}

/** The title in place: saved when editing ends (links to it follow the new title). */
function TitleField({ id, title, repo }: { id: string; title: string; repo: Repo }) {
	const [text, setText] = useState(title);
	const focused = useRef(false);
	const latest = useRef({ text, title });
	latest.current = { text, title };
	useEffect(() => {
		if (!focused.current) setText(title);
	}, [title]);
	const save = () => {
		const { text: now, title: was } = latest.current;
		if (now.trim() !== was) repo.ownStep(() => repo.setTitle(id, now.trim()));
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
			onChangeText={(v) => setText(v.replace(/\n/g, " "))}
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
	const save = (next: string) => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		if (next === saved.current) return;
		saved.current = next;
		repo.setBody(id, next);
	};
	// a change from elsewhere arrives while nothing is unsaved here: take it
	useEffect(() => {
		if (body !== saved.current && latest.current === saved.current) {
			saved.current = body;
			setText(body);
		}
	}, [body]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: saves once, when the editor goes
	useEffect(() => () => save(latest.current), []);
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
	meta: {
		color: C.tertiary,
		fontSize: 12,
		marginHorizontal: GUTTER + 4,
		marginTop: 28,
		textAlign: "center",
	},
	editor: { backgroundColor: C.plain, flex: 1 },
	editorInput: {
		color: C.label,
		flex: 1,
		fontSize: 17,
		lineHeight: 25,
		paddingHorizontal: GUTTER + 4,
	},
});
