// A sheet for a new workspace: its name and, with several servers, the one it goes on. The pages
// show it right after, and this phone sets it up once it is in sync.

import * as Haptics from "expo-haptics";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, TextInput } from "react-native";
import { hostOf, statusOf } from "../lib/api";
import { t } from "../lib/i18n";
import { createWorkspace, useSession } from "../lib/session";
import { Icon, Row, Screen, Section } from "../ui/list";
import { C, GUTTER } from "../ui/theme";

export default function NewSpace() {
	const session = useSession();
	const accounts = session?.accounts ?? [];
	const shown = session?.spaces.find((w) => w.id === session.shown);
	const usable = accounts.filter((a) => !a.lost);
	const [server, setServer] = useState(
		usable.find((a) => a.server === shown?.server)?.server ?? usable[0]?.server ?? "",
	);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const canCreate = !!name.trim() && usable.some((a) => a.server === server) && !busy;

	const create = async () => {
		if (!canCreate) return;
		setBusy(true);
		setError("");
		try {
			await createWorkspace(server, name.trim());
			void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
			router.back();
		} catch (e) {
			void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
			setError(
				statusOf(e) === undefined
					? t("account.offline")
					: e instanceof Error
						? e.message
						: String(e),
			);
			setBusy(false);
		}
	};

	return (
		<>
			<Stack.Screen options={{ title: t("space.new") }} />
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button icon="xmark" onPress={() => router.back()}>
					{t("cancel")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			<Stack.Toolbar placement="right">
				<Stack.Toolbar.Button
					disabled={!canCreate}
					icon="checkmark"
					onPress={() => void create()}
					variant="prominent"
				>
					{t("space.create")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			<Screen keyboard>
				<Section footer={t("settings.workspacesHint")}>
					<TextInput
						autoFocus
						onChangeText={setName}
						onSubmitEditing={() => void create()}
						placeholder={t("space.name")}
						placeholderTextColor={C.placeholder}
						returnKeyType="done"
						selectionColor={C.accent}
						style={styles.input}
						value={name}
					/>
				</Section>
				{accounts.length > 1 && (
					<Section title={t("settings.server")}>
						{accounts.map((a) => (
							<Row
								key={a.server}
								onPress={a.lost ? undefined : () => setServer(a.server)}
								right={
									a.server === server ? (
										<Icon color={C.accent} name="checkmark" size={17} />
									) : undefined
								}
								subtitle={a.lost ? t("account.signedOut") : a.user.email}
								title={hostOf(a.server)}
							/>
						))}
					</Section>
				)}
				{error ? <Text style={styles.error}>{error}</Text> : null}
			</Screen>
		</>
	);
}

const styles = StyleSheet.create({
	input: { color: C.label, fontSize: 17, minHeight: 52, paddingHorizontal: GUTTER },
	error: {
		color: C.red,
		fontSize: 15,
		marginHorizontal: GUTTER,
		marginTop: 16,
		textAlign: "center",
	},
});
