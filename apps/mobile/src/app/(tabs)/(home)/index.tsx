// Home, the start page across every workspace: what is due, what runs, what changed last.

import { fmtDate, fmtPercent, fmtRelative } from "@obtion/core/i18n";
import { todayISO } from "@obtion/core/model";
import { inbox } from "@obtion/core/placement";
import { cmpKey } from "@obtion/core/sortkey";
import { dueBy, recentlyChanged, running } from "@obtion/core/today";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { Alert, StyleSheet, Text } from "react-native";
import { type Space, useSpaces } from "../../../lib/hooks";
import { lang, t } from "../../../lib/i18n";
import { createWorkspace, refresh, useSession } from "../../../lib/session";
import { DueText, ItemRow, placeOf, Ring } from "../../../ui/item";
import { Icon, Row, Screen, Section } from "../../../ui/list";
import { SessionNotice } from "../../../ui/status";
import { C, GUTTER, palHex } from "../../../ui/theme";

const RECENT = 5;
const RUNNING = 6;

/** Which greeting fits the hour: night counts as evening. */
function dayPart(hour: number): "morning" | "day" | "evening" {
	if (hour < 5) return "evening";
	if (hour < 11) return "morning";
	return hour < 18 ? "day" : "evening";
}

type Of<T> = { space: Space; value: T };

export default function Home() {
	const session = useSession();
	const spaces = useSpaces();
	const [refreshing, setRefreshing] = useState(false);
	const today = todayISO();
	const ready = spaces.filter((s): s is Space & { ix: NonNullable<Space["ix"]> } => !!s.ix);
	const all = <T,>(list: (s: (typeof ready)[number]) => T[]): Of<T>[] =>
		ready.flatMap((space) => list(space).map((value) => ({ space, value })));
	const due = all((s) => dueBy(s.ix, today)).sort((a, b) => cmpKey(a.value.due, b.value.due));
	const runs = all((s) => running(s.ix)).sort((a, b) => b.value.touched - a.value.touched);
	const recent = all((s) => recentlyChanged(s.ix, RECENT))
		.sort((a, b) => b.value.updated - a.value.updated)
		.slice(0, RECENT);
	const waiting = ready.reduce((n, s) => n + inbox(s.ix).length, 0);
	const several = spaces.length > 1;
	const where = (s: Space, place: string) =>
		[place, several ? s.info.name : ""].filter(Boolean).join(" · ");

	const name = session?.user.name.trim().split(/\s+/)[0];
	const part = dayPart(new Date().getHours());
	const greeting = (
		name ? t(`today.greet.${part}`, { name }) : t(`today.greet.${part}Plain`)
	).replace(/\.$/, "");
	const [before, after] = t("today.inbox", { count: waiting, n: "\u0000" }).split("\u0000");

	const reload = async () => {
		setRefreshing(true);
		// a copy still loading connects by itself once loaded, from where it left off
		for (const s of spaces) if (s.repo.status.loaded) s.repo.connect();
		await refresh();
		setRefreshing(false);
	};

	return (
		<>
			<Stack.Screen options={{ title: greeting }} />
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button icon="square.and.pencil" onPress={() => router.push("/new")}>
					{t("quick.title")}
				</Stack.Toolbar.Button>
				<Stack.Toolbar.Button icon="person.crop.circle" onPress={() => router.push("/settings")}>
					{t("nav.settings")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			<Screen onRefresh={reload} refreshing={refreshing}>
				<Text style={styles.date}>
					{fmtDate(lang, today, { weekday: "long", day: "numeric", month: "long" })}
				</Text>
				<Text style={styles.summary}>
					{t("today.due", { count: due.length })}{" "}
					{runs.length > 0 && `${t("today.projects", { count: runs.length })} `}
					{waiting ? (
						<>
							{before}
							<Text onPress={() => router.navigate("/(tabs)/(inbox)/inbox")} style={styles.inbox}>
								{t("today.entries", { count: waiting })}
							</Text>
							{after}
						</>
					) : (
						t("today.inboxEmpty")
					)}
				</Text>
				<SessionNotice spaces={spaces} />
				{session && !session.spaces.length && !session.lost && (
					<Section>
						<Row
							icon={<Icon color={C.accent} name="plus.circle.fill" />}
							onPress={() =>
								Alert.prompt(
									t("space.new"),
									t("account.noSpaceHint"),
									(name) => {
										if (name?.trim()) void createWorkspace(name.trim());
									},
									"plain-text",
									t("account.noSpace"),
								)
							}
							subtitle={t("account.noSpaceHint")}
							title={<Text style={{ color: C.accent }}>{t("space.create")}</Text>}
						/>
					</Section>
				)}

				<Section prominent title={t("today.dueTitle")}>
					{due.map(({ space, value }) => (
						<ItemRow
							item={value.item}
							ix={space.ix!}
							key={`${space.info.id}/${value.item.id}`}
							repo={space.repo}
							right={<DueText due={value.due} />}
							space={space.info.id}
							subtitle={where(space, placeOf(value.item, space.ix!))}
						/>
					))}
				</Section>

				<Section prominent title={t("today.projectsTitle")}>
					{runs.slice(0, RUNNING).map(({ space, value }) => {
						const ix = space.ix!;
						const progress = ix.progressOf(value.item);
						const counted = progress && progress.total > 0 ? progress : undefined;
						const color = palHex(ix.schemaOf(value.item)?.color);
						return (
							<ItemRow
								detail={counted ? fmtPercent(lang, counted.done / counted.total) : undefined}
								icon={
									counted ? <Ring color={color} share={counted.done / counted.total} /> : undefined
								}
								item={value.item}
								ix={ix}
								key={`${space.info.id}/${value.item.id}`}
								repo={space.repo}
								space={space.info.id}
								status={false}
								subtitle={where(
									space,
									[
										counted ? t("today.open", { count: counted.total - counted.done }) : "",
										`${t("today.touched")} ${fmtRelative(lang, value.touched)}`,
									]
										.filter(Boolean)
										.join(" · "),
								)}
							/>
						);
					})}
				</Section>

				<Section prominent title={t("today.recentTitle")}>
					{recent.map(({ space, value }) => (
						<ItemRow
							detail={fmtRelative(lang, value.updated)}
							item={value}
							ix={space.ix!}
							key={`${space.info.id}/${value.id}`}
							repo={space.repo}
							space={space.info.id}
							status={false}
							subtitle={where(space, placeOf(value, space.ix!))}
						/>
					))}
				</Section>
			</Screen>
		</>
	);
}

const styles = StyleSheet.create({
	date: {
		color: C.secondary,
		fontSize: 15,
		fontWeight: "600",
		marginHorizontal: GUTTER + 4,
		marginTop: 4,
		textTransform: "capitalize",
	},
	summary: {
		color: C.label,
		fontSize: 17,
		lineHeight: 24,
		marginHorizontal: GUTTER + 4,
		marginTop: 6,
	},
	inbox: { color: C.warn, fontWeight: "600" },
});
