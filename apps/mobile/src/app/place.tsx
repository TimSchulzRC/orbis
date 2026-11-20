// "Put it in…": choose the page an entry belongs under. Giving it a place sorts it out of the
// inbox; pinned pages and the last edited come first.

import type { Item } from "@orbis/core/model";
import { canPlaceIn } from "@orbis/core/placement";
import type { Repo } from "@orbis/sync";
import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { useRepo } from "../lib/hooks";
import { t, titleOf } from "../lib/i18n";
import { Empty, Icon, Row, Screen, Section } from "../ui/list";
import { lookOf } from "../ui/look";
import { SpaceGone } from "../ui/status";
import { C, GUTTER } from "../ui/theme";

const LIMIT = 60;

export default function Place() {
	const { space, id } = useLocalSearchParams<{ space: string; id: string }>();
	const repo = useRepo(space);
	if (!repo) return <SpaceGone />;
	return <Places id={id} repo={repo} />;
}

function Places({ id, repo }: { id: string; repo: Repo }) {
	const [q, setQ] = useState("");
	const ix = repo.index();
	const item = repo.get(id);
	if (!item) return <Empty symbol="questionmark.circle" title={t("item.missing")} />;
	const query = q.trim().toLowerCase();
	const candidates = ix.live
		.filter(
			(x) =>
				x.kind === "note" &&
				x.id !== id &&
				canPlaceIn(item, x, ix) &&
				(!query || titleOf(x).toLowerCase().includes(query)),
		)
		.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updated - a.updated)
		.slice(0, LIMIT);
	const place = (parent: Item) => {
		if (!repo.addParent(item.id, parent.id)) return;
		void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
		router.back();
	};
	return (
		<>
			<Stack.Screen options={{ title: t("triage.placeIn") }} />
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button icon="xmark" onPress={() => router.back()}>
					{t("cancel")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			<Screen>
				<View style={styles.search}>
					<Icon color={C.secondary} name="magnifyingglass" size={17} />
					<TextInput
						autoCorrect={false}
						clearButtonMode="while-editing"
						onChangeText={setQ}
						placeholder={t("nav.searchPlaceholder")}
						placeholderTextColor={C.placeholder}
						selectionColor={C.accent}
						style={styles.input}
						value={q}
					/>
				</View>
				<Section>
					{candidates.map((x) => {
						const look = lookOf(x, ix);
						return (
							<Row
								icon={<Icon color={look.color} name={look.symbol} />}
								key={x.id}
								onPress={() => place(x)}
								subtitle={[look.kind, ix.pathText(ix.homePath(x.id).slice(-2))]
									.filter(Boolean)
									.join(" · ")}
								title={titleOf(x)}
							/>
						);
					})}
				</Section>
			</Screen>
		</>
	);
}

const styles = StyleSheet.create({
	search: {
		alignItems: "center",
		backgroundColor: C.fill,
		borderRadius: 12,
		flexDirection: "row",
		gap: 8,
		marginHorizontal: GUTTER,
		marginTop: 8,
		paddingHorizontal: 10,
	},
	input: { color: C.label, flex: 1, fontSize: 17, paddingVertical: 9 },
});
