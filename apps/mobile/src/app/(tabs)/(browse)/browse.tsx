// Browse a workspace like the web app's sidebar: what is pinned, then every type with its list.
// With several workspaces the menu at the top switches between them.

import { sidebarChildren, sidebarRoots } from "@obtion/core/placement";
import { isDone } from "@obtion/core/traits";
import { router, Stack } from "expo-router";
import { useSpaces } from "../../../lib/hooks";
import { t } from "../../../lib/i18n";
import { setActive, useSession } from "../../../lib/session";
import { ItemRow, LinkRow, typeHref, useTab } from "../../../ui/item";
import { Icon, Screen, Section } from "../../../ui/list";
import { typeSymbol } from "../../../ui/look";
import { SessionNotice } from "../../../ui/status";
import { C, pal } from "../../../ui/theme";

export default function Browse() {
	const session = useSession();
	const spaces = useSpaces();
	const tab = useTab();
	const space = spaces.find((s) => s.info.id === session?.active) ?? spaces[0];
	const ix = space?.ix;
	return (
		<>
			<Stack.Screen options={{ title: space?.info.name ?? t("mobile.browse") }} />
			<Stack.Toolbar placement="right">
				{spaces.length > 1 && (
					<Stack.Toolbar.Menu icon="square.stack.3d.up" title={t("settings.workspaces")}>
						{spaces.map((s) => (
							<Stack.Toolbar.MenuAction
								isOn={s.info.id === space?.info.id}
								key={s.info.id}
								onPress={() => setActive(s.info.id)}
							>
								{s.info.name}
							</Stack.Toolbar.MenuAction>
						))}
					</Stack.Toolbar.Menu>
				)}
				<Stack.Toolbar.Button icon="square.and.pencil" onPress={() => router.push("/new")}>
					{t("quick.title")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			<Screen>
				<SessionNotice spaces={spaces} />
				{space && ix && (
					<>
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
				)}
			</Screen>
		</>
	);
}
