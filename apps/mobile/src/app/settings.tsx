// The account, the server and the workspaces with how far each is in sync; signing out.

import type { ServerInfo } from "@obtion/core/api";
import Constants from "expo-constants";
import { router, Stack } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Text } from "react-native";
import { useSpaces } from "../lib/hooks";
import { t } from "../lib/i18n";
import { pendingChanges, serverInfo, setActive, signOut, useSession } from "../lib/session";
import { Icon, Row, Screen, Section } from "../ui/list";
import { C } from "../ui/theme";

export default function Settings() {
	const session = useSession();
	const spaces = useSpaces();
	const [info, setInfo] = useState<ServerInfo | null>(null);
	useEffect(() => {
		if (session) serverInfo(session.server).then(setInfo, () => setInfo(null));
	}, [session]);
	if (!session) return null;
	const out = () => {
		const pending = pendingChanges();
		Alert.alert(
			t("account.signOut"),
			pending ? t("sync.unsynced.body", { count: pending }) : t("mobile.signOutHint"),
			[
				{ text: t("cancel"), style: "cancel" },
				{
					text: t("account.signOut"),
					style: "destructive",
					onPress: () => {
						router.dismissAll();
						void signOut();
					},
				},
			],
		);
	};
	return (
		<>
			<Stack.Screen options={{ title: t("nav.settings") }} />
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button onPress={() => router.back()} variant="done">
					{t("mobile.done")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			<Screen>
				<Section title={t("account.title")}>
					<Row
						icon={<Icon color={C.accent} name="person.crop.circle.fill" size={30} />}
						subtitle={session.user.email}
						title={session.user.name || session.user.email}
					/>
				</Section>
				<Section title={t("settings.server")}>
					<Row detail={session.server.replace(/^https?:\/\//, "")} title={t("settings.server")} />
					<Row
						detail={
							info ? info.version : session.lost ? t("account.signedOut") : t("sync.offlineNone")
						}
						title={t("mobile.serverVersion")}
					/>
				</Section>
				<Section footer={t("mobile.workspacesHint")} title={t("settings.workspaces")}>
					{spaces.map((s) => {
						const { online, synced, pending } = s.repo.status;
						const state = !online
							? pending
								? t("sync.offline", { count: pending })
								: t("sync.offlineNone")
							: pending
								? t("sync.pending", { count: pending })
								: synced
									? t("sync.ok")
									: t("sync.catchingUp");
						const active = s.info.id === session.active;
						return (
							<Row
								icon={
									<Icon
										color={online ? C.ok : C.tertiary}
										name={online ? "checkmark.icloud" : "icloud.slash"}
									/>
								}
								key={s.info.id}
								onPress={() => setActive(s.info.id)}
								right={active ? <Icon color={C.accent} name="checkmark" size={17} /> : undefined}
								subtitle={state}
								title={s.info.name}
							/>
						);
					})}
				</Section>
				<Section>
					<Row
						destructive
						onPress={out}
						title={<Text style={{ color: C.red }}>{t("account.signOut")}</Text>}
					/>
				</Section>
				<Text style={{ color: C.tertiary, fontSize: 12, marginTop: 20, textAlign: "center" }}>
					{t("mobile.appVersion", { version: Constants.expoConfig?.version ?? "" })}
				</Text>
			</Screen>
		</>
	);
}
