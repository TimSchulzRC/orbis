// Signing in to an Obtion server: its address first, then email and password or a code by email,
// whichever the server offers. Passkeys and OAuth belong to the server's own web page. The same
// form connects a further server and signs in again where a server no longer takes the token.

import type { LoginMethods, ServerInfo } from "@obtion/core/api";
import * as Haptics from "expo-haptics";
import Storage from "expo-sqlite/kv-store";
import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	Image,
	Pressable,
	ScrollView,
	Settings,
	StyleSheet,
	Text,
	TextInput,
	useColorScheme,
	View,
} from "react-native";
import { hostOf, serverUrl, statusOf } from "../lib/api";
import { t } from "../lib/i18n";
import { sendCode, serverInfo, signIn, signInWithCode } from "../lib/session";
import { C, GUTTER, RADIUS } from "./theme";

const LAST_SERVER = "obtion.lastServer";

/**
 * Automated simulator runs sign in with launch arguments (`xcrun simctl launch <device> <bundle id>
 * -obtionServer <url> -obtionEmail <email> -obtionPassword <password>`). iOS keeps them for that
 * launch only, and nothing outside Xcode or simctl can set them.
 */
function launchArg(key: string): string | undefined {
	const v: unknown = Settings.get(key);
	return typeof v === "string" && v ? v : undefined;
}

function errorText(e: unknown, what: "signIn" | "code" | "server"): string {
	const status = statusOf(e);
	if (status === undefined) return what === "server" ? t("mobile.noServer") : t("account.offline");
	if (status === 429) return t("account.tooMany");
	if (what === "code") return status === 403 ? t("account.closed") : t("account.codeWrong");
	if (what === "server") return t("mobile.noServer");
	if (status === 401) return t("account.wrong");
	if (status === 403) return t("account.closed");
	return e instanceof Error ? e.message : String(e);
}

export function SignInForm({
	fixedServer,
	email: knownEmail,
	another,
	onDone,
}: {
	fixedServer?: string;
	email?: string;
	/** A further server: its address starts empty. */
	another?: boolean;
	/** Signed in. */
	onDone?: () => void;
}) {
	const dark = useColorScheme() === "dark";
	const [address, setAddress] = useState(
		fixedServer ??
			(another ? "" : (launchArg("obtionServer") ?? Storage.getItemSync(LAST_SERVER) ?? "")),
	);
	const [info, setInfo] = useState<{ server: string; info: ServerInfo } | null>(null);
	const [email, setEmail] = useState(knownEmail ?? launchArg("obtionEmail") ?? "");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [mode, setMode] = useState<"password" | "code">("password");
	const [codeSent, setCodeSent] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const run = async (fn: () => Promise<void>, what: "signIn" | "code" | "server") => {
		setBusy(true);
		setError("");
		try {
			await fn();
		} catch (e) {
			void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
			setError(errorText(e, what));
		} finally {
			setBusy(false);
		}
	};

	const withPassword = (server: string) =>
		run(async () => {
			await signIn(server, email, password);
			onDone?.();
		}, "signIn");
	const withCode = (server: string) =>
		run(async () => {
			await signInWithCode(server, email, code);
			onDone?.();
		}, "code");

	const connect = () =>
		run(async () => {
			const server = serverUrl(address);
			if (!server) throw new Error(t("mobile.noServer"));
			const answer = await serverInfo(server);
			Storage.setItemSync(LAST_SERVER, server);
			setInfo({ server, info: answer });
			setMode(answer.login.password ? "password" : "code");
		}, "server");

	// signing in again on the known server: straight to its sign-in
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, when the form opens
	useEffect(() => {
		if (another) return;
		const auto = { server: launchArg("obtionServer"), password: launchArg("obtionPassword") };
		if (!fixedServer && auto.server && auto.password && email)
			void run(async () => {
				const server = serverUrl(auto.server!);
				await serverInfo(server);
				await signIn(server, email, auto.password!);
			}, "signIn");
		else if (fixedServer || auto.server) void connect();
	}, []);

	const login: LoginMethods | undefined = info?.info.login;
	const host = info && hostOf(info.server);

	return (
		<ScrollView
			automaticallyAdjustKeyboardInsets
			contentContainerStyle={styles.content}
			keyboardShouldPersistTaps="handled"
			style={styles.screen}
		>
			<Image
				source={dark ? require("../../assets/splash-dark.png") : require("../../assets/splash.png")}
				style={styles.logo}
			/>
			<Text style={styles.title}>Obtion</Text>
			<Text style={styles.subtitle}>
				{info
					? t("mobile.signInTo", { server: host ?? "" })
					: t(another ? "mobile.connectAnother" : "mobile.connectIntro")}
			</Text>

			{!info && (
				<>
					<View style={styles.card}>
						<TextInput
							autoCapitalize="none"
							autoCorrect={false}
							autoFocus={!address}
							keyboardType="url"
							onChangeText={setAddress}
							onSubmitEditing={connect}
							placeholder="notes.example.org"
							placeholderTextColor={C.placeholder}
							returnKeyType="go"
							selectionColor={C.accent}
							style={styles.input}
							textContentType="URL"
							value={address}
						/>
					</View>
					<Button
						busy={busy}
						disabled={!address.trim()}
						label={t("mobile.continue")}
						onPress={connect}
					/>
				</>
			)}

			{info && login && !login.password && !login.emailCode && (
				<Text style={styles.error}>{t("mobile.noMethod")}</Text>
			)}

			{info && login && mode === "password" && login.password && (
				<>
					<View style={styles.card}>
						<TextInput
							autoCapitalize="none"
							autoComplete="email"
							autoCorrect={false}
							keyboardType="email-address"
							onChangeText={setEmail}
							placeholder={t("account.email")}
							placeholderTextColor={C.placeholder}
							selectionColor={C.accent}
							style={styles.input}
							textContentType="username"
							value={email}
						/>
						<View style={styles.separator} />
						<TextInput
							autoComplete="current-password"
							onChangeText={setPassword}
							onSubmitEditing={() => withPassword(info.server)}
							placeholder={t("account.password")}
							placeholderTextColor={C.placeholder}
							returnKeyType="go"
							secureTextEntry
							selectionColor={C.accent}
							style={styles.input}
							textContentType="password"
							value={password}
						/>
					</View>
					<Button
						busy={busy}
						disabled={!email.trim() || !password}
						label={t("account.signIn")}
						onPress={() => withPassword(info.server)}
					/>
					{login.emailCode && <Link label={t("account.useCode")} onPress={() => setMode("code")} />}
				</>
			)}

			{info && login && mode === "code" && login.emailCode && (
				<>
					<View style={styles.card}>
						<TextInput
							autoCapitalize="none"
							autoComplete="email"
							autoCorrect={false}
							editable={!codeSent}
							keyboardType="email-address"
							onChangeText={setEmail}
							placeholder={t("account.email")}
							placeholderTextColor={C.placeholder}
							selectionColor={C.accent}
							style={styles.input}
							textContentType="username"
							value={email}
						/>
						{codeSent && (
							<>
								<View style={styles.separator} />
								<TextInput
									autoComplete="one-time-code"
									autoFocus
									keyboardType="number-pad"
									onChangeText={setCode}
									placeholder={t("account.code")}
									placeholderTextColor={C.placeholder}
									selectionColor={C.accent}
									style={styles.input}
									textContentType="oneTimeCode"
									value={code}
								/>
							</>
						)}
					</View>
					{codeSent && <Text style={styles.hint}>{t("account.codeSent", { email })}</Text>}
					{codeSent ? (
						<Button
							busy={busy}
							disabled={!code.trim()}
							label={t("account.signIn")}
							onPress={() => withCode(info.server)}
						/>
					) : (
						<Button
							busy={busy}
							disabled={!email.trim()}
							label={t("account.sendCode")}
							onPress={() =>
								run(async () => {
									await sendCode(info.server, email);
									setCodeSent(true);
								}, "code")
							}
						/>
					)}
					{codeSent && (
						<Link
							label={t("account.codeAgain")}
							onPress={() => run(() => sendCode(info.server, email), "code")}
						/>
					)}
					{login.password && (
						<Link
							label={t("account.usePassword")}
							onPress={() => {
								setMode("password");
								setCodeSent(false);
							}}
						/>
					)}
				</>
			)}

			{error ? <Text style={styles.error}>{error}</Text> : null}

			{info && !fixedServer && (
				<Link
					label={t("mobile.otherServer")}
					onPress={() => {
						setInfo(null);
						setError("");
						setCodeSent(false);
					}}
				/>
			)}
			{info && (
				<Text style={styles.version}>{t("settings.version", { version: info.info.version })}</Text>
			)}
		</ScrollView>
	);
}

function Button({
	label,
	onPress,
	busy,
	disabled,
}: {
	label: string;
	onPress: () => void;
	busy: boolean;
	disabled?: boolean;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			disabled={busy || disabled}
			onPress={onPress}
			style={({ pressed }) => [
				styles.button,
				(disabled || pressed) && { opacity: disabled ? 0.4 : 0.75 },
			]}
		>
			{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{label}</Text>}
		</Pressable>
	);
}

function Link({ label, onPress }: { label: string; onPress: () => void }) {
	return (
		<Pressable hitSlop={8} onPress={onPress} style={styles.link}>
			<Text style={styles.linkText}>{label}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	screen: { backgroundColor: C.background, flex: 1 },
	content: { gap: 14, paddingBottom: 40, paddingHorizontal: GUTTER + 8, paddingTop: 96 },
	logo: { alignSelf: "center", height: 96, width: 96 },
	title: { color: C.label, fontSize: 34, fontWeight: "700", textAlign: "center" },
	subtitle: {
		color: C.secondary,
		fontSize: 17,
		lineHeight: 23,
		marginBottom: 10,
		textAlign: "center",
	},
	card: {
		backgroundColor: C.card,
		borderCurve: "continuous",
		borderRadius: RADIUS,
		overflow: "hidden",
	},
	input: { color: C.label, fontSize: 17, minHeight: 52, paddingHorizontal: GUTTER },
	separator: { backgroundColor: C.separator, height: StyleSheet.hairlineWidth, marginLeft: GUTTER },
	button: {
		alignItems: "center",
		backgroundColor: C.accent,
		borderCurve: "continuous",
		borderRadius: 26,
		justifyContent: "center",
		minHeight: 52,
	},
	buttonText: { color: "#fff", fontSize: 17, fontWeight: "600" },
	link: { alignItems: "center", paddingVertical: 6 },
	linkText: { color: C.accent, fontSize: 16 },
	hint: { color: C.secondary, fontSize: 14, textAlign: "center" },
	error: { color: C.red, fontSize: 15, textAlign: "center" },
	version: { color: C.tertiary, fontSize: 12, marginTop: 12, textAlign: "center" },
});
