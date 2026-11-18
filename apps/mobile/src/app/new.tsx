// A sheet to write something down: a new note (into the inbox, or straight as a type), or with
// mode=update an update on an entry, optionally with a new status.

import { Host, Picker, Text as SwiftText } from "@expo/ui/swift-ui";
import { pickerStyle, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { statusOf, statusProp } from "@obtion/core/traits";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, useColorScheme, View } from "react-native";
import { useRepo, useSpaces } from "../lib/hooks";
import { t, titleOf } from "../lib/i18n";
import { useSession } from "../lib/session";
import { C, GUTTER, RADIUS } from "../ui/theme";

const ACCENT = { light: "#be780a", dark: "#f0b040" };
const INBOX = "";

export default function New() {
	const { mode, space, id } = useLocalSearchParams<{
		mode?: string;
		space?: string;
		id?: string;
	}>();
	return mode === "update" && space && id ? <NewUpdate id={id} space={space} /> : <NewNote />;
}

function Choice({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: { id: string; name: string }[];
	onChange: (id: string) => void;
}) {
	const dark = useColorScheme() === "dark";
	return (
		<View style={styles.choice}>
			<Text style={styles.choiceLabel}>{label}</Text>
			<Host matchContents>
				<Picker
					modifiers={[pickerStyle("menu"), tint(dark ? ACCENT.dark : ACCENT.light)]}
					onSelectionChange={(v: string) => onChange(v)}
					selection={value}
				>
					{options.map((o) => (
						<SwiftText key={o.id} modifiers={[tag(o.id)]}>
							{o.name}
						</SwiftText>
					))}
				</Picker>
			</Host>
		</View>
	);
}

function Toolbar({ canSave, onSave }: { canSave: boolean; onSave: () => void }) {
	return (
		<>
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button icon="xmark" onPress={() => router.back()}>
					{t("cancel")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button
					disabled={!canSave}
					icon="checkmark"
					onPress={onSave}
					variant="prominent"
				>
					{t("mobile.save")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
		</>
	);
}

function NewNote() {
	const session = useSession();
	const spaces = useSpaces();
	const [spaceId, setSpaceId] = useState(session?.active ?? spaces[0]?.info.id ?? "");
	const space = spaces.find((s) => s.info.id === spaceId) ?? spaces[0];
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [type, setType] = useState(INBOX);
	const ix = space?.ix;
	const capture = ix ? ix.captureTypes() : [];
	const types = ix
		? [...capture, ...ix.typesByName().map((x) => x.id)].filter((x, i, all) => all.indexOf(x) === i)
		: [];
	const canSave = !!space && !!(title.trim() || body.trim());
	const save = () => {
		if (!space || !canSave) return;
		space.repo.ownStep(() =>
			space.repo.create({
				title: title.trim(),
				body: body.trim() ? body : undefined,
				...(type && ix?.types.has(type) ? { type } : {}),
			}),
		);
		void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
		router.back();
	};
	return (
		<>
			<Stack.Screen options={{ title: t("quick.title") }} />
			<Toolbar canSave={canSave} onSave={save} />
			<ScrollView
				automaticallyAdjustKeyboardInsets
				contentContainerStyle={styles.content}
				contentInsetAdjustmentBehavior="automatic"
				keyboardShouldPersistTaps="handled"
				style={styles.sheet}
			>
				<View style={styles.card}>
					<TextInput
						autoFocus
						multiline
						onChangeText={(v) => setTitle(v.replace(/\n/g, " "))}
						placeholder={t("item.title")}
						placeholderTextColor={C.placeholder}
						scrollEnabled={false}
						style={styles.title}
						submitBehavior="blurAndSubmit"
						value={title}
					/>
					<View style={styles.separator} />
					<TextInput
						multiline
						onChangeText={setBody}
						placeholder={t("mobile.writeHere")}
						placeholderTextColor={C.placeholder}
						scrollEnabled={false}
						style={styles.body}
						value={body}
					/>
				</View>
				<View style={styles.card}>
					{spaces.length > 1 && (
						<Choice
							label={t("space.general")}
							onChange={(v) => {
								setSpaceId(v);
								setType(INBOX);
							}}
							options={spaces.map((s) => ({ id: s.info.id, name: s.info.name }))}
							value={space?.info.id ?? ""}
						/>
					)}
					{ix && (
						<Choice
							label={t("triage.type")}
							onChange={setType}
							options={[
								{ id: INBOX, name: t("settings.captureDefault") },
								...types.map((x) => ({ id: x, name: ix.typeName(x) ?? "" })),
							]}
							value={type}
						/>
					)}
				</View>
			</ScrollView>
		</>
	);
}

const KEEP = "";

function NewUpdate({ space, id }: { space: string; id: string }) {
	const repo = useRepo(space);
	const [text, setText] = useState("");
	const [status, setStatus] = useState(KEEP);
	const item = repo.get(id);
	const ix = repo.index();
	const schema = ix.schemaOf(item);
	const prop = statusProp(schema);
	const current = item ? statusOf(item, schema)?.option.id : undefined;
	const save = () => {
		if (!item || !text.trim()) return;
		const option = status !== KEEP && status !== current ? status : undefined;
		repo.ownStep(() =>
			repo.addUpdate(item.id, text.trim(), prop && option ? { prop: prop.id, option } : undefined),
		);
		void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
		router.back();
	};
	return (
		<>
			<Stack.Screen
				options={{
					title: item ? t("updates.titleOf", { title: titleOf(item) }) : t("updates.title"),
				}}
			/>
			<Toolbar canSave={!!text.trim()} onSave={save} />
			<ScrollView
				automaticallyAdjustKeyboardInsets
				contentContainerStyle={styles.content}
				contentInsetAdjustmentBehavior="automatic"
				keyboardShouldPersistTaps="handled"
				style={styles.sheet}
			>
				<View style={styles.card}>
					<TextInput
						autoFocus
						multiline
						onChangeText={setText}
						placeholder={t("updates.placeholder")}
						placeholderTextColor={C.placeholder}
						scrollEnabled={false}
						style={[styles.body, { minHeight: 140 }]}
						value={text}
					/>
				</View>
				{prop && (
					<View style={styles.card}>
						<Choice
							label={t("updates.status")}
							onChange={setStatus}
							options={[
								{ id: KEEP, name: t("updates.keepStatus") },
								...(prop.options ?? [])
									.filter((o) => o.id !== current)
									.map((o) => ({ id: o.id, name: o.name })),
							]}
							value={status}
						/>
					</View>
				)}
			</ScrollView>
		</>
	);
}

const styles = StyleSheet.create({
	sheet: { backgroundColor: C.background },
	content: { gap: 16, padding: GUTTER },
	card: {
		backgroundColor: C.card,
		borderCurve: "continuous",
		borderRadius: RADIUS,
		overflow: "hidden",
	},
	title: {
		color: C.label,
		fontSize: 22,
		fontWeight: "600",
		paddingHorizontal: GUTTER,
		paddingVertical: 14,
	},
	separator: { backgroundColor: C.separator, height: StyleSheet.hairlineWidth, marginLeft: GUTTER },
	body: {
		color: C.label,
		fontSize: 17,
		lineHeight: 24,
		minHeight: 110,
		paddingHorizontal: GUTTER,
		paddingVertical: 12,
	},
	choice: {
		alignItems: "center",
		flexDirection: "row",
		justifyContent: "space-between",
		minHeight: 52,
		paddingHorizontal: GUTTER,
	},
	choiceLabel: { color: C.label, fontSize: 17 },
});
