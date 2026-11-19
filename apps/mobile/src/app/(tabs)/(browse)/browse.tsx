// Browse a workspace like the web app's sidebar: what is pinned, then every type with its list.
// The switcher at the top left picks the workspace; with all of them, each follows under its name.

import { sidebarChildren, sidebarRoots } from "@obtion/core/placement";
import { isDone } from "@obtion/core/traits";
import { router, Stack } from "expo-router";
import { StyleSheet, Text } from "react-native";
import { type Space, useShownSpaces } from "../../../lib/hooks";
import { t } from "../../../lib/i18n";
import { ItemRow, LinkRow, typeHref, useTab } from "../../../ui/item";
import { Icon, Screen, Section } from "../../../ui/list";
import { typeSymbol } from "../../../ui/look";
import { SpaceSwitcher } from "../../../ui/spaces";
import { SessionNotice } from "../../../ui/status";
import { C, GUTTER, pal } from "../../../ui/theme";

export default function Browse() {
	const spaces = useShownSpaces();
	const several = spaces.length > 1;
	return (
		<>
			<Stack.Screen
				options={{
					title: several ? t("mobile.browse") : (spaces[0]?.info.name ?? t("mobile.browse")),
				}}
			/>
			<SpaceSwitcher />
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button icon="square.and.pencil" onPress={() => router.push("/new")}>
					{t("quick.title")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			<Screen>
				<SessionNotice spaces={spaces} />
				{spaces.map((space) => (
					<Contents key={space.info.id} named={several} space={space} />
				))}
			</Screen>
		</>
	);
}

function Contents({ space, named }: { space: Space; named: boolean }) {
	const tab = useTab();
	const ix = space.ix;
	if (!ix) return null;
	return (
		<>
			{named && <Text style={styles.name}>{space.info.name}</Text>}
			<Section title={t("place.pinned")}>
				{sidebarRoots(ix).map((item) => {
					const below = sidebarChildren(item.id, ix).length;
					return (
						<ItemRow
							detail={below ? String(below) : undefined}
							item={item}
							ix={ix}
							key={item.id}
							repo={space.repo}
							right={<Icon color={C.tertiary} name="chevron.right" size={13} />}
							space={space.info.id}
							status={false}
						/>
					);
				})}
			</Section>
			<Section title={t("nav.types")}>
				{ix.typesInOrder().map((type) => {
					const open = ix
						.itemsOfType(type.id)
						.filter((i) => !i.deleted && !isDone(i, type.schema)).length;
					return (
						<LinkRow
							chevron
							detail={open ? String(open) : undefined}
							href={typeHref(tab, space.info.id, type.id)}
							icon={<Icon color={pal(type.schema.color)} name={typeSymbol(type.schema)} />}
							key={type.id}
							title={ix.typePlural(type.id)}
						/>
					);
				})}
			</Section>
		</>
	);
}

const styles = StyleSheet.create({
	name: {
		color: C.label,
		fontSize: 22,
		fontWeight: "700",
		marginHorizontal: GUTTER + 4,
		marginTop: 30,
	},
});
