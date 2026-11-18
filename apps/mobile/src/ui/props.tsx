// An entry's properties as a settings-style card: the name on the left, a native control on the
// right (SwiftUI menu pickers, the compact date picker, a switch, text fields). Empty ones wait
// behind "More", as on the web.

import { DatePicker, Host, Picker, Text as SwiftText } from "@expo/ui/swift-ui";
import { datePickerStyle, labelsHidden, pickerStyle, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { dayOf, timeOf } from "@obtion/core/date";
import type { Index } from "@obtion/core/graph";
import { fmtShortDate } from "@obtion/core/i18n";
import { numberText, parseNumber } from "@obtion/core/input";
import { type Item, optionNames, type PropDef, todayISO, type Value } from "@obtion/core/model";
import { dueProp, hasValue, optionIds, visibleProps } from "@obtion/core/traits";
import type { Repo } from "@obtion/sync";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
	ActionSheetIOS,
	Linking,
	Pressable,
	StyleSheet,
	Switch,
	Text,
	TextInput,
	useColorScheme,
	View,
} from "react-native";
import { lang, t, titleOf } from "../lib/i18n";
import { itemHref } from "./item";
import { Icon, Row, Section } from "./list";
import { C } from "./theme";

const ACCENT = { light: "#be780a", dark: "#f0b040" };

interface Props {
	item: Item;
	ix: Index;
	repo: Repo;
	space: string;
	tab: string;
}

export function Properties({ item, ix, repo, space, tab }: Props) {
	const [more, setMore] = useState(false);
	const schema = ix.schemaOf(item);
	if (!schema) return null;
	const due = dueProp(schema)?.id;
	const all = visibleProps(item, schema, ix);
	const shown = all.filter(
		(p) => more || p.kind === "status" || p.id === due || hasValue(item, p, ix),
	);
	const hidden = all.length - shown.length;
	const set = (p: PropDef, value: Value | null) => {
		void Haptics.selectionAsync();
		repo.ownStep(() => repo.setProp(item.id, p.id, value));
	};
	return (
		<Section>
			{shown.map((p) => (
				<Row
					key={p.id}
					right={
						<Control
							item={item}
							ix={ix}
							onChange={(v) => set(p, v)}
							prop={p}
							space={space}
							tab={tab}
						/>
					}
					title={<Text style={styles.name}>{p.name}</Text>}
				/>
			))}
			{hidden > 0 && (
				<Row
					onPress={() => setMore(true)}
					title={<Text style={styles.more}>{`${t("props.showMore")} (${hidden})`}</Text>}
				/>
			)}
			{more && all.some((p) => !hasValue(item, p, ix)) && (
				<Row
					onPress={() => setMore(false)}
					title={<Text style={styles.more}>{t("props.showLess")}</Text>}
				/>
			)}
		</Section>
	);
}

function Control({
	prop,
	item,
	ix,
	onChange,
	space,
	tab,
}: {
	prop: PropDef;
	item: Item;
	ix: Index;
	onChange: (v: Value | null) => void;
	space: string;
	tab: string;
}) {
	const value = item.props[prop.id];
	switch (prop.kind) {
		case "status":
			return <Choice onChange={onChange} prop={prop} value={value} />;
		case "select":
			return prop.multiple ? (
				<Multi onChange={onChange} prop={prop} value={value} />
			) : (
				<Choice onChange={onChange} prop={prop} value={value} />
			);
		case "date":
			return <DateField onChange={onChange} prop={prop} value={value} />;
		case "checkbox":
			return <Switch onValueChange={(on) => onChange(on || null)} value={value === true} />;
		case "number":
			return (
				<Field
					keyboardType="decimal-pad"
					onSave={(text) => onChange(text.trim() ? (parseNumber(lang, text) ?? null) : null)}
					value={typeof value === "number" ? numberText(lang, value) : ""}
				/>
			);
		case "url":
			return (
				<View style={styles.inline}>
					<Field
						keyboardType="url"
						onSave={(text) => onChange(text.trim() || null)}
						value={typeof value === "string" ? value : ""}
					/>
					{typeof value === "string" && value && (
						<Pressable hitSlop={8} onPress={() => void Linking.openURL(value)}>
							<Icon color={C.accent} name="arrow.up.right.square" size={20} />
						</Pressable>
					)}
				</View>
			);
		case "text":
			return (
				<Field
					onSave={(text) => onChange(text.trim() || null)}
					value={typeof value === "string" ? value : ""}
				/>
			);
		case "relation": {
			const targets = ix.items(ix.relValues(item, prop.id, prop.symmetric));
			if (!targets.length) return <Text style={styles.value}>{t("props.empty")}</Text>;
			return (
				<Pressable
					onPress={() => {
						if (targets.length === 1) return router.push(itemHref(tab, space, targets[0]!.id));
						ActionSheetIOS.showActionSheetWithOptions(
							{
								options: [...targets.map((x) => titleOf(x)), t("cancel")],
								cancelButtonIndex: targets.length,
							},
							(i) => {
								const x = targets[i];
								if (x) router.push(itemHref(tab, space, x.id));
							},
						);
					}}
					style={styles.relation}
				>
					<Text numberOfLines={2} style={[styles.value, { color: C.accent }]}>
						{targets.map((x) => titleOf(x)).join(", ")}
					</Text>
				</Pressable>
			);
		}
		case "computed": {
			if (prop.computed?.fn === "count")
				return (
					<Text style={styles.value}>{String(ix.countDescendants(item.id, prop.computed.of))}</Text>
				);
			const p = ix.progress(item.id, prop.computed?.of);
			return (
				<Text style={styles.value}>
					{p.total
						? `${p.done}/${p.total} · ${Math.round((p.done / p.total) * 100)} %`
						: t("props.empty")}
				</Text>
			);
		}
		default:
			return <Text style={styles.value}>{String(value ?? t("props.empty"))}</Text>;
	}
}

/** One option: SwiftUI's menu picker. A status or a select with a default is never empty. */
function Choice({
	prop,
	value,
	onChange,
}: {
	prop: PropDef;
	value: Value | undefined;
	onChange: (v: Value | null) => void;
}) {
	const dark = useColorScheme() === "dark";
	const options = prop.options ?? [];
	const current =
		typeof value === "string" && options.some((o) => o.id === value) ? value : (prop.default ?? "");
	const clearable = prop.kind !== "status" && !prop.default;
	return (
		<Host matchContents>
			<Picker
				modifiers={[pickerStyle("menu"), tint(dark ? ACCENT.dark : ACCENT.light)]}
				onSelectionChange={(v: string) => onChange(v === "" ? null : v)}
				selection={current}
			>
				{clearable && <SwiftText modifiers={[tag("")]}>{t("props.empty")}</SwiftText>}
				{options.map((o) => (
					<SwiftText key={o.id} modifiers={[tag(o.id)]}>
						{o.name}
					</SwiftText>
				))}
			</Picker>
		</Host>
	);
}

/** Several options: an action sheet adds or removes one at a time. */
function Multi({
	prop,
	value,
	onChange,
}: {
	prop: PropDef;
	value: Value | undefined;
	onChange: (v: Value | null) => void;
}) {
	const options = prop.options ?? [];
	const ids = optionIds(value);
	const names = value === undefined ? [] : optionNames(prop, value);
	return (
		<Pressable
			onPress={() =>
				ActionSheetIOS.showActionSheetWithOptions(
					{
						title: prop.name,
						options: [
							...options.map((o) => (ids.includes(o.id) ? `✓ ${o.name}` : o.name)),
							t("cancel"),
						],
						cancelButtonIndex: options.length,
					},
					(i) => {
						const o = options[i];
						if (!o) return;
						const next = ids.includes(o.id) ? ids.filter((x) => x !== o.id) : [...ids, o.id];
						onChange(next.length ? next : null);
					},
				)
			}
			style={styles.relation}
		>
			<Text numberOfLines={2} style={[styles.value, names.length > 0 && { color: C.accent }]}>
				{names.length ? names.join(", ") : t("props.empty")}
			</Text>
		</Pressable>
	);
}

const pad = (n: number) => String(n).padStart(2, "0");

function toDate(v: string): Date {
	const [y, m, d] = dayOf(v).split("-").map(Number);
	const [hh, mm] = (timeOf(v) ?? "00:00").split(":").map(Number);
	return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
}

function fromDate(d: Date, withTime: boolean): string {
	const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	return withTime ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

/** The compact date picker; a time only when the value has one. Ranges are shown, not edited. */
function DateField({
	prop,
	value,
	onChange,
}: {
	prop: PropDef;
	value: Value | undefined;
	onChange: (v: Value | null) => void;
}) {
	const v = typeof value === "string" ? value : "";
	if (!v)
		return (
			<Pressable hitSlop={8} onPress={() => onChange(todayISO())}>
				<Text style={[styles.value, { color: C.accent }]}>
					{t("props.set", { name: prop.name })}
				</Text>
			</Pressable>
		);
	if (v.includes("/"))
		return (
			<Text style={styles.value}>
				{v
					.split("/")
					.map((x) => (x ? fmtShortDate(lang, dayOf(x)) : "…"))
					.join(" – ")}
			</Text>
		);
	const withTime = !!timeOf(v);
	return (
		<View style={styles.inline}>
			<Host matchContents>
				<DatePicker
					displayedComponents={withTime ? ["date", "hourAndMinute"] : ["date"]}
					modifiers={[datePickerStyle("compact"), labelsHidden()]}
					onDateChange={(d) => onChange(fromDate(d, withTime))}
					selection={toDate(v)}
				/>
			</Host>
			<Pressable
				accessibilityLabel={t("props.removeValue")}
				hitSlop={10}
				onPress={() => onChange(null)}
			>
				<Icon color={C.tertiary} name="xmark.circle.fill" size={18} />
			</Pressable>
		</View>
	);
}

/** Text that saves when editing ends. */
function Field({
	value,
	onSave,
	keyboardType,
}: {
	value: string;
	onSave: (text: string) => void;
	keyboardType?: "url" | "decimal-pad";
}) {
	const [text, setText] = useState(value);
	const [focused, setFocused] = useState(false);
	useEffect(() => {
		if (!focused) setText(value);
	}, [value, focused]);
	return (
		<TextInput
			autoCapitalize={keyboardType === "url" ? "none" : "sentences"}
			autoCorrect={keyboardType !== "url"}
			keyboardType={keyboardType}
			onBlur={() => setFocused(false)}
			onChangeText={setText}
			onEndEditing={() => {
				if (text !== value) onSave(text);
			}}
			onFocus={() => setFocused(true)}
			placeholder={t("props.empty")}
			placeholderTextColor={C.placeholder}
			returnKeyType="done"
			style={styles.field}
			value={text}
		/>
	);
}

const styles = StyleSheet.create({
	name: { color: C.label, fontSize: 17 },
	more: { color: C.accent, fontSize: 17 },
	value: { color: C.secondary, fontSize: 17, textAlign: "right" },
	inline: { alignItems: "center", flexDirection: "row", gap: 8 },
	relation: { flexShrink: 1, maxWidth: "62%" },
	field: {
		color: C.secondary,
		fontSize: 17,
		// half the row: the property's name stays whole ("Zusammenfassung"), the value scrolls
		maxWidth: "50%",
		minWidth: 90,
		padding: 0,
		textAlign: "right",
	},
});
