// The inbox across every workspace, newest first. A long press sorts an entry: give it a type,
// put it somewhere, bring it back tomorrow, pin it or delete it.

import { fmtRelative } from "@obtion/core/i18n";
import { tomorrow } from "@obtion/core/inbox";
import { type Item, setMeta } from "@obtion/core/model";
import { inbox } from "@obtion/core/placement";
import { plainText } from "@obtion/core/search";
import * as Haptics from "expo-haptics";
import { Link, router, Stack } from "expo-router";
import { useSpaces } from "../../../lib/hooks";
import { lang, t } from "../../../lib/i18n";
import { ItemRow } from "../../../ui/item";
import { Empty, Screen, Section } from "../../../ui/list";
import { typeSymbol } from "../../../ui/look";
import { SessionNotice } from "../../../ui/status";

const EXCERPT = 120;

export default function Inbox() {
	const spaces = useSpaces();
	const several = spaces.length > 1;
	const entries = spaces
		.flatMap((space) => (space.ix ? inbox(space.ix).map((item) => ({ space, item })) : []))
		.sort((a, b) => b.item.created - a.item.created);
	const loading = spaces.some((s) => !s.ix);
	return (
		<>
			<Stack.Screen options={{ title: t("nav.inbox") }} />
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button icon="square.and.pencil" onPress={() => router.push("/new")}>
					{t("quick.title")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			<Screen>
				<SessionNotice spaces={spaces} />
				{!entries.length && !loading && <Empty symbol="tray" title={t("inbox.empty")} />}
				<Section>
					{entries.map(({ space, item }) => {
						const ix = space.ix!;
						const repo = space.repo;
						const text = plainText(item.body).replace(/\s+/g, " ").trim().slice(0, EXCERPT);
						const types = [
							...ix.captureTypes(),
							...ix.typesInOrder().map((type) => type.id),
						].filter((id, i, all) => all.indexOf(id) === i);
						const give = (type: string) => {
							void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
							repo.ownStep(() => repo.setType(item.id, type));
						};
						const later = (it: Item) => {
							void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
							repo.ownStep(() => repo.change(it.id, (doc) => setMeta(doc, { later: tomorrow() })));
						};
						return (
							<ItemRow
								item={item}
								ix={ix}
								key={`${space.info.id}/${item.id}`}
								menu={
									<>
										{item.kind === "note" && (
											<Link.Menu icon="tag" title={t("triage.chooseType")}>
												{types.map((type) => (
													<Link.MenuAction
														icon={typeSymbol(ix.types.get(type)?.schema)}
														key={type}
														onPress={() => give(type)}
														title={ix.typeName(type) ?? ""}
													/>
												))}
											</Link.Menu>
										)}
										<Link.MenuAction
											icon="folder"
											onPress={() =>
												router.push({
													pathname: "/place",
													params: { space: space.info.id, id: item.id },
												})
											}
											title={t("triage.place")}
										/>
										<Link.MenuAction
											icon="moon.zzz"
											onPress={() => later(item)}
											title={t("review.later")}
										/>
									</>
								}
								repo={repo}
								space={space.info.id}
								subtitle={[fmtRelative(lang, item.created), several ? space.info.name : "", text]
									.filter(Boolean)
									.join(" · ")}
							/>
						);
					})}
				</Section>
			</Screen>
		</>
	);
}
