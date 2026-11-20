// The parts of an entry's page below its properties: what sits below it, its updates and the
// pages that link to it.

import type { Index } from "@orbis/core/graph";
import { fmtDateTime } from "@orbis/core/i18n";
import type { Item } from "@orbis/core/model";
import { belowOf } from "@orbis/core/placement";
import { dueOf, hasUpdates, isDone, progressSpec, statusProp } from "@orbis/core/traits";
import type { Repo } from "@orbis/sync";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import { ActionSheetIOS, Alert, StyleSheet, Text, View } from "react-native";
import { lang, t, titleOf } from "../lib/i18n";
import { DueText, ItemRow, itemHref } from "./item";
import { Icon, Row, Section } from "./list";
import { C } from "./theme";

interface PageProps {
	item: Item;
	ix: Index;
	repo: Repo;
	space: string;
	tab: string;
}

/** The type a new entry below gets first: what the progress counts, else what is below already. */
function likelyType(item: Item, ix: Index): string | null {
	const of = progressSpec(ix.schemaOf(item))?.of;
	if (of && ix.types.has(of)) return of;
	const counts = new Map<string, number>();
	for (const c of belowOf(item.id, ix))
		if (c.type && ix.types.has(c.type)) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Asks for the type (most likely first), then the title, and makes the entry below `item`. */
export function addBelow({ item, ix, repo, space, tab }: PageProps) {
	const first = likelyType(item, ix);
	const types: (string | null)[] = [
		...(first ? [first] : []),
		null,
		...ix
			.typesByName()
			.map((x) => x.id)
			.filter((id) => id !== first),
	];
	const nameOf = (type: string | null) => (type ? (ix.typeName(type) ?? "") : t("kind.note"));
	const ask = (type: string | null) =>
		Alert.prompt(t("below.addOf", { name: nameOf(type) }), undefined, (title) => {
			if (!title?.trim()) return;
			let id = "";
			repo.ownStep(() => {
				id = repo.create({ title: title.trim(), parents: [item.id], ...(type ? { type } : {}) });
			});
			void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
			// a task stays in the list (add the next one); a note or page opens to write in
			if (!statusProp(type ? ix.types.get(type)?.schema : undefined))
				router.push(itemHref(tab, space, id));
		});
	ActionSheetIOS.showActionSheetWithOptions(
		{
			title: t("below.add"),
			options: [...types.map(nameOf), t("cancel")],
			cancelButtonIndex: types.length,
		},
		(i) => {
			if (i < types.length) ask(types[i]!);
		},
	);
}

export function Below(props: PageProps) {
	const { item, ix, repo, space } = props;
	const [showDone, setShowDone] = useState(false);
	const below = belowOf(item.id, ix);
	const done = below.filter((c) => isDone(c, ix.schemaOf(c)));
	const open = below.filter((c) => !done.includes(c));
	const progress = progressSpec(ix.schemaOf(item)) ? ix.progressOf(item) : undefined;
	const title = (
		<View style={styles.head}>
			<Text style={styles.headText}>
				{t("below.title")}
				{below.length ? ` · ${below.length}` : ""}
			</Text>
			{progress && progress.total > 0 && (
				<Text style={styles.headDetail}>
					{progress.done}/{progress.total}
				</Text>
			)}
		</View>
	);
	const row = (c: Item) => (
		<ItemRow
			item={c}
			ix={ix}
			key={c.id}
			repo={repo}
			right={<DueText done={isDone(c, ix.schemaOf(c))} due={dueOf(c, ix.schemaOf(c))} />}
			space={space}
			subtitle={c.type ? undefined : t("kind.note")}
		/>
	);
	return (
		<Section title={title}>
			{open.map(row)}
			{done.length > 0 &&
				(showDone ? (
					done.map(row)
				) : (
					<Row
						chevron
						icon={<Icon color={C.ok} name="checkmark.circle" />}
						key="done"
						onPress={() => setShowDone(true)}
						title={t("mobile.showDone", { count: done.length })}
					/>
				))}
			<Row
				icon={<Icon color={C.accent} name="plus.circle.fill" />}
				key="add"
				onPress={() => addBelow(props)}
				title={<Text style={{ color: C.accent }}>{t("below.add")}</Text>}
			/>
		</Section>
	);
}

export function Updates({ item, ix, repo, space }: PageProps) {
	const schema = ix.schemaOf(item);
	if (!hasUpdates(schema)) return null;
	const prop = statusProp(schema);
	const list = [...item.updates].sort((a, b) => b.at - a.at);
	return (
		<Section title={t("updates.title")}>
			<Row
				icon={<Icon color={C.accent} name="square.and.pencil" />}
				key="write"
				onPress={() =>
					router.push({ pathname: "/new", params: { mode: "update", space, id: item.id } })
				}
				title={
					<Text style={{ color: C.accent }}>
						{list.length ? t("updates.newOne") : t("updates.first")}
					</Text>
				}
			/>
			{list.map((u) => {
				const status = u.status ? prop?.options?.find((o) => o.id === u.status) : undefined;
				return (
					<Row
						key={u.id}
						onLongPress={() =>
							Alert.alert(t("updates.deleteAsk"), u.text, [
								{ text: t("cancel"), style: "cancel" },
								{
									text: t("updates.deleteYes"),
									style: "destructive",
									onPress: () => repo.ownStep(() => repo.removeUpdate(item.id, u.id)),
								},
							])
						}
						subtitle={[
							fmtDateTime(lang, u.at),
							status ? t("updates.statusTo", { name: status.name }) : "",
						]
							.filter(Boolean)
							.join(" · ")}
						title={u.text}
						titleLines={12}
					/>
				);
			})}
		</Section>
	);
}

export function Mentions({ item, ix, repo, space }: PageProps) {
	const seen = new Set<string>();
	const from = ix
		.backlinks(item.id)
		.map((b) => ix.get(b.from))
		.filter((x): x is Item => !!x && !x.deleted && !seen.has(x.id) && !!seen.add(x.id));
	return (
		<Section title={t("item.linkedFrom")}>
			{from.map((x) => (
				<ItemRow item={x} ix={ix} key={x.id} repo={repo} space={space} status={false} />
			))}
		</Section>
	);
}

/** "Work › Relaunch": tap a step to open it. */
export function Path({ item, ix, space, tab }: PageProps) {
	const path = ix
		.homePath(item.id)
		.map((id) => ix.get(id))
		.filter((x): x is Item => !!x);
	if (!path.length) return null;
	return (
		<Text numberOfLines={1} style={styles.path}>
			{path.map((p, i) => (
				<Text key={p.id}>
					{i > 0 ? "  ›  " : ""}
					<Text onPress={() => router.push(itemHref(tab, space, p.id))}>{titleOf(p)}</Text>
				</Text>
			))}
		</Text>
	);
}

const styles = StyleSheet.create({
	head: {
		alignItems: "baseline",
		flexDirection: "row",
		justifyContent: "space-between",
		marginBottom: 7,
		marginHorizontal: 16,
	},
	headText: { color: C.secondary, fontSize: 13, textTransform: "uppercase" },
	headDetail: { color: C.secondary, fontSize: 13, fontVariant: ["tabular-nums"] },
	path: { color: C.secondary, fontSize: 15 },
});
