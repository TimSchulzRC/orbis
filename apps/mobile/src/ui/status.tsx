// Above the lists: a server no longer takes this phone's sign-in (sign in again), or the first sync
// still runs.

import { router } from "expo-router";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { hostOf } from "../lib/api";
import type { Space } from "../lib/hooks";
import { t } from "../lib/i18n";
import { useSession } from "../lib/session";
import { Empty, Icon } from "./list";
import { C, GUTTER, RADIUS } from "./theme";

/** A page of a workspace the account no longer has. */
export function SpaceGone() {
	return <Empty symbol="folder.badge.questionmark" title={t("app.noSpace")} />;
}

export function SessionNotice({ spaces }: { spaces: Space[] }) {
	const session = useSession();
	const lost = session?.accounts.filter((a) => a.lost) ?? [];
	if (lost.length)
		return lost.map((a) => (
			<Pressable
				key={a.server}
				onPress={() => router.push({ pathname: "/reauth", params: { server: a.server } })}
				style={styles.card}
			>
				<Icon color={C.red} name="exclamationmark.triangle.fill" size={20} />
				<View style={styles.texts}>
					<Text style={styles.title}>{t("account.lostTitle")}</Text>
					<Text style={styles.text}>{t("account.lost", { server: hostOf(a.server) })}</Text>
				</View>
				<Icon color={C.tertiary} name="chevron.right" size={13} />
			</Pressable>
		));
	const loading = spaces.some((s) => !s.ix && !s.repo.status.synced);
	if (!loading) return null;
	return (
		<View style={styles.loading}>
			<ActivityIndicator />
			<Text style={styles.text}>
				{spaces.some((s) => s.repo.status.online) ? t("sync.catchingUp") : t("sync.reconnecting")}
			</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	card: {
		alignItems: "center",
		backgroundColor: C.card,
		borderCurve: "continuous",
		borderRadius: RADIUS,
		flexDirection: "row",
		gap: 12,
		marginHorizontal: GUTTER,
		marginTop: 16,
		padding: GUTTER,
	},
	texts: { flex: 1, gap: 2 },
	title: { color: C.label, fontSize: 17, fontWeight: "600" },
	text: { color: C.secondary, fontSize: 15 },
	loading: {
		alignItems: "center",
		flexDirection: "row",
		gap: 10,
		justifyContent: "center",
		marginTop: 24,
	},
});
