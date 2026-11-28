// The servers this phone is connected to, each with its account, its workspaces and how far each is
// in sync, and signing out of it; below, a new workspace and another server.

import type { ServerInfo } from "@orbis/core/api";
import Constants from "expo-constants";
import { router, Stack } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Text } from "react-native";
import { hostOf } from "../lib/api";
import { type Space, useSpaces } from "../lib/hooks";
import { t } from "../lib/i18n";
import { type Account, pendingChanges, serverInfo, signOut, useSession } from "../lib/session";
import { Icon, Row, Screen, Section } from "../ui/list";
import { C } from "../ui/theme";

export default function Settings() {
	const session = useSession();
	const spaces = useSpaces();
	const servers = session?.accounts.map((a) => a.server).join() ?? "";
	const [infos, setInfos] = useState<Record<string, ServerInfo>>({});
	useEffect(() => {
		for (const server of servers.split(",").filter(Boolean))
			serverInfo(server).then(
				(info) => setInfos((known) => ({ ...known, [server]: info })),
				() => undefined,
			);
	}, [servers]);
	if (!session) return null;
	return (
		<>
			<Stack.Screen options={{ title: t("nav.settings") }} />
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button onPress={() => router.back()} variant="done">
					{t("mobile.done")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			<Screen>
				{session.accounts.map((a) => (
					<Server
						account={a}
						info={infos[a.server]}
						key={a.server}
						last={session.accounts.length === 1}
						spaces={spaces.filter((s) => s.info.server === a.server)}
					/>
				))}
				<Section footer={t("mobile.workspacesHint")}>
					<Row
						icon={<Icon color={C.accent} name="plus.circle.fill" />}
						onPress={() => router.push("/new-space")}
						title={<Text style={{ color: C.accent }}>{t("space.new")}</Text>}
					/>
					<Row
						icon={<Icon color={C.accent} name="server.rack" />}
						onPress={() => router.push("/connect")}
						title={<Text style={{ color: C.accent }}>{t("mobile.connectServer")}</Text>}
					/>
				</Section>
				<Text style={{ color: C.tertiary, fontSize: 12, marginTop: 20, textAlign: "center" }}>
					{t("mobile.appVersion", { version: Constants.expoConfig?.version ?? "" })}
				</Text>
			</Screen>
		</>
	);
}

function Server({
	account,
	info,
	spaces,
	last,
}: {
	account: Account;
	info: ServerInfo | undefined;
	spaces: Space[];
	/** The only server: signing out of it leads to the sign-in. */
	last: boolean;
}) {
	const { server, user, lost } = account;
	const out = () => {
		const pending = pendingChanges(server);
		Alert.alert(
			t("account.signOut"),
			pending
				? t("sync.unsynced.body", { count: pending })
				: t("mobile.signOutHint", { server: hostOf(server) }),
			[
				{ text: t("cancel"), style: "cancel" },
				{
					text: t("account.signOut"),
					style: "destructive",
					onPress: () => {
						if (last) router.dismissAll();
						void signOut(server);
					},
				},
			],
		);
	};
	return (
		<Section title={hostOf(server)}>
			<Row
				icon={<Icon color={C.accent} name="person.crop.circle.fill" size={30} />}
				subtitle={user.email}
				title={user.name || user.email}
			/>
			<Row
				detail={info ? info.version : lost ? t("account.signedOut") : t("sync.offlineNone")}
				title={t("mobile.serverVersion")}
			/>
			{lost && (
				<Row
					onPress={() => router.push({ pathname: "/reauth", params: { server } })}
					title={<Text style={{ color: C.accent }}>{t("account.signInAgain")}</Text>}
				/>
			)}
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
				return (
					<Row
						icon={
							<Icon
								color={online ? C.ok : C.tertiary}
								name={online ? "checkmark.icloud" : "icloud.slash"}
							/>
						}
						key={s.info.id}
						subtitle={state}
						title={s.info.name}
					/>
				);
			})}
			<Row destructive onPress={out} title={t("account.signOut")} />
		</Section>
	);
}
