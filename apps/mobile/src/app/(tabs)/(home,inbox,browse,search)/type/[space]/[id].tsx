// A type's entries ("Tasks"): running ones first, then open, done ones folded away. The search
// field filters by title, "+" adds one.

import { dueOf, isDone, statusOf, statusProp } from "@obtion/core/traits";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { useRepo } from "../../../../../lib/hooks";
import { t, titleOf } from "../../../../../lib/i18n";
import { DueText, ItemRow, itemHref, placeOf, useTab } from "../../../../../ui/item";
import { Empty, Row, Screen, Section } from "../../../../../ui/list";

const GROUPS = ["active", "todo", "done"] as const;

export default function TypePage() {
	const { space, id } = useLocalSearchParams<{ space: string; id: string }>();
	const repo = useRepo(space);
	const tab = useTab();
	const [filter, setFilter] = useState("");
	const [showDone, setShowDone] = useState(false);
	const ix = repo.index();
	const type = ix.types.get(id);
	if (!type) return <Empty symbol="questionmark.folder" title={t("item.missing")} />;
	const schema = type.schema;
	const q = filter.trim().toLowerCase();
	const entries = ix
		.itemsOfType(id)
		.filter((i) => !i.deleted && (!q || titleOf(i).toLowerCase().includes(q)))
		.sort((a, b) => b.updated - a.updated);
	const hasStatus = !!statusProp(schema);
	const add = () =>
		Alert.prompt(t("below.addOf", { name: schema.name }), undefined, (title) => {
			if (!title?.trim()) return;
			let created = "";
			repo.ownStep(() => {
				created = repo.create({ title: title.trim(), type: id });
			});
			void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
			router.push(itemHref(tab, space, created));
		});
	const row = (item: (typeof entries)[number]) => (
		<ItemRow
			item={item}
			ix={ix}
			key={item.id}
			repo={repo}
			right={<DueText done={isDone(item, schema)} due={dueOf(item, schema)} />}
			space={space}
			subtitle={placeOf(item, ix)}
		/>
	);
	return (
		<>
			<Stack.Screen options={{ title: ix.typePlural(id) }} />
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button icon="plus" onPress={add}>
					{t("type.addNew")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			<Stack.SearchBar
				hideWhenScrolling
				onCancelButtonPress={() => setFilter("")}
				onChangeText={(e) => setFilter(e.nativeEvent.text)}
				placeholder={t("nav.searchPlaceholder")}
			/>
			<Screen>
				{!entries.length && (
					<Empty symbol={q ? "magnifyingglass" : "tray"} title={t("view.emptyFiltered")} />
				)}
				{hasStatus ? (
					GROUPS.map((group) => {
						const list = entries.filter((i) => statusOf(i, schema)?.group === group);
						if (!list.length) return null;
						const folded = group === "done" && !showDone && !q;
						return (
							<Section key={group} title={`${t(`group.${group}`)} · ${list.length}`}>
								{folded ? (
									<Row
										chevron
										onPress={() => setShowDone(true)}
										title={t("mobile.showDone", { count: list.length })}
									/>
								) : (
									list.map(row)
								)}
							</Section>
						);
					})
				) : (
					<Section>{entries.map(row)}</Section>
				)}
				{showDone && !q && (
					<Section>
						<Row onPress={() => setShowDone(false)} title={t("mobile.hideDone")} />
					</Section>
				)}
			</Screen>
		</>
	);
}
