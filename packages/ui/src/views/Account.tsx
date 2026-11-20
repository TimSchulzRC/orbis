// Before the app: signing in or creating an account on this server, joining by an invite link
// (#/join/<code>). In the desktop app also connecting a further server (ConnectServer). Gate.tsx
// puts them in front of the app.

import type { InviteInfo, ServerInfo } from "@orbis/core/api";
import { KeyRound } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useId, useState } from "react";
import {
	ApiError,
	answers,
	baseOf,
	errorText,
	invite,
	joinInvite,
	loginOf,
	oauthFailed,
	parseServer,
	sendCode,
	serverInfo,
	serverName,
	signIn,
	signInWithCode,
	signInWithOAuth,
	signInWithPasskey,
	signUp,
	useAccounts,
} from "../accounts";
import { Input } from "../components/ui/input";
import { navigate } from "../hooks";
import { getLang, useT } from "../i18n";
import { BrandLogo } from "../ui/BrandLogo";
import { Button } from "../ui/primitives";

export function AuthCard({
	title,
	intro,
	children,
}: {
	title: string;
	intro?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex h-full items-center justify-center overflow-y-auto p-6">
			<div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-sm">
				<BrandLogo alt="" className="mb-4 size-10" />
				<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
				{intro && <p className="mt-2 text-sm text-muted-foreground">{intro}</p>}
				{children}
			</div>
		</div>
	);
}

const input = "mt-1 block bg-surface";

export function Field({
	label,
	...p
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
	const inputId = useId();
	return (
		<label className="mt-4 block text-sm font-medium" htmlFor={inputId}>
			{label}
			<Input id={inputId} {...p} className={input} />
		</label>
	);
}

/** What to say when signing in with a provider failed and came back here. */
const oauthErrorKey = (failed: string) =>
	failed === "closed"
		? "account.closed"
		: failed === "notLinked"
			? "account.notLinked"
			: "account.oauthFailed";

/** Passkeys work only where the browser has them (and in a secure context: HTTPS or localhost). */
const canPasskey = () =>
	typeof window !== "undefined" && !!window.PublicKeyCredential && window.isSecureContext;

/**
 * `inviteCode`: a new account joins that workspace. `email`: re-confirming who is signed in (sign-in
 * only; `hasPassword` and `hasPasskey` then limit the offered ways to the ones this account has).
 * `server`: a further server (desktop app); code or password only, since passkeys and OAuth belong
 * to that server's own page.
 */
export function SignIn({
	inviteCode,
	onDone,
	email: fixedEmail,
	hasPassword,
	hasPasskey,
	server,
}: {
	inviteCode?: string;
	onDone?: () => void;
	email?: string;
	hasPassword?: boolean;
	hasPasskey?: boolean;
	server?: string;
}) {
	const { t } = useT();
	const [info, setInfo] = useState<ServerInfo | null>(null);
	const [mode, setMode] = useState<"in" | "up">("in");
	// by code (when the server sends them) or by password
	const [withPassword, setWithPassword] = useState(false);
	const [codeSent, setCodeSent] = useState(false);
	const [name, setName] = useState("");
	const [email, setEmail] = useState(fixedEmail ?? "");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [error, setError] = useState(oauthFailed && !server ? t(oauthErrorKey(oauthFailed)) : "");
	const [busy, setBusy] = useState(false);
	// asked once, when the form opens
	const gotServer = useEffectEvent((i: ServerInfo) => {
		setInfo(i);
		if (!fixedEmail && (i.firstAccount || inviteCode)) setMode("up");
		// confirming an account with a password: with that, as the password manager knows it
		if (!loginOf(i).emailCode || (fixedEmail && hasPassword && loginOf(i).password))
			setWithPassword(true);
	});
	const offline = useEffectEvent(() => setError(t("account.offline")));
	useEffect(() => {
		serverInfo(server)
			.then((i) => gotServer(i))
			.catch(() => offline());
	}, [server]);
	const login = server ? { ...loginOf(info), passkey: false, oauth: [] } : loginOf(info);
	// confirming an account without a password: no password to ask for
	const byPassword = login.password && !(fixedEmail && hasPassword === false);
	const byEmail = login.emailCode || byPassword;
	const ctx = { invite: inviteCode, lang: getLang() };
	const canSignUp =
		!fixedEmail &&
		!!info &&
		(info.firstAccount || info.signup === "open" || (info.signup === "invite" && !!inviteCode));
	const run = async (what: "signIn" | "code", action: () => Promise<unknown>) => {
		setBusy(true);
		setError("");
		try {
			await action();
			return true;
		} catch (err) {
			setError(errorText(err, t, what));
			return false;
		} finally {
			setBusy(false);
		}
	};
	const account = { name, email, password, invite: inviteCode, lang: getLang() };
	// a new account with a password, where codes are on: its address proves itself with a code first
	const signUpWithCode = withPassword && mode === "up" && login.emailCode;
	const sendAgain = () =>
		run("code", () => (signUpWithCode ? signUp(account, server) : sendCode(email, ctx, server)));
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (codeSent && signUpWithCode) {
			if (await run("code", () => signUp({ ...account, code }, server))) onDone?.();
		} else if (withPassword) {
			let verify = false;
			const ok = await run("signIn", async () => {
				if (mode === "up") verify = (await signUp(account, server)) === "verify";
				else await signIn(email, password, server, inviteCode);
			});
			if (ok && verify) setCodeSent(true);
			else if (ok) onDone?.();
		} else if (!codeSent) {
			if (await run("code", () => sendCode(email, ctx, server))) setCodeSent(true);
		} else if (
			await run("code", () =>
				signInWithCode(email, code, mode === "up" ? name : undefined, ctx, server),
			)
		)
			onDone?.();
	};
	const passkey = async () => {
		setBusy(true);
		setError("");
		try {
			await signInWithPasskey();
			onDone?.();
		} catch (err) {
			// closed by the person (NotAllowedError): nothing to say
			const closed = err instanceof Error && err.name === "NotAllowedError";
			if (!closed)
				setError(
					err instanceof ApiError && err.status === 429
						? t("account.tooMany")
						: t("account.passkeyFailed"),
				);
		} finally {
			setBusy(false);
		}
	};
	const withPasskey = login.passkey && canPasskey() && mode === "in" && hasPasskey !== false;
	const others = withPasskey || login.oauth.length > 0;
	const signInLabel =
		mode === "up" ? t("account.signUp") : fixedEmail ? t("account.confirm") : t("account.signIn");
	if (codeSent)
		return (
			<form className="mt-2" onSubmit={submit}>
				<p className="mt-4 text-sm">{t("account.codeSent", { email })}</p>
				<Field
					autoComplete="one-time-code"
					autoFocus
					inputMode="numeric"
					label={t("account.code")}
					onChange={(e) => setCode(e.target.value)}
					required
					value={code}
				/>
				{error && (
					<p className="mt-3 text-sm text-danger" role="alert">
						{error}
					</p>
				)}
				<Button
					className="mt-6 w-full"
					disabled={busy || !code.trim()}
					type="submit"
					variant="primary"
				>
					{signInLabel}
				</Button>
				<div className="mt-3 flex justify-between text-sm">
					<Button
						className="text-link hover:underline"
						onClick={() => {
							setCodeSent(false);
							setCode("");
							setError("");
						}}
						type="button"
						variant="plain"
					>
						{t("account.back")}
					</Button>
					<Button
						className="text-link hover:underline"
						disabled={busy}
						onClick={() => void sendAgain()}
						type="button"
						variant="plain"
					>
						{t("account.codeAgain")}
					</Button>
				</div>
			</form>
		);
	return (
		<form className="mt-2" onSubmit={submit}>
			{info?.firstAccount && (
				<p className="mt-3 rounded-lg border border-line bg-surface-2 p-3 text-sm text-muted-foreground">
					{t("account.firstHint")}
				</p>
			)}
			{others && (
				<div className="mt-4 flex flex-col gap-2">
					{withPasskey && (
						<Button
							className="w-full"
							disabled={busy || !info}
							onClick={() => void passkey()}
							type="button"
							variant="outline"
						>
							<KeyRound size={16} /> {t("account.passkey")}
						</Button>
					)}
					{login.oauth.map((p) => (
						<Button
							className="w-full"
							disabled={busy || !info}
							key={p.id}
							onClick={() => void run("signIn", () => signInWithOAuth(p.id, ctx))}
							type="button"
							variant="outline"
						>
							{t("account.oauth", { provider: p.name })}
						</Button>
					))}
					{byEmail && (
						<p className="mt-2 text-center text-xs text-muted-foreground">
							{t(fixedEmail && withPassword ? "account.orPassword" : "account.or")}
						</p>
					)}
				</div>
			)}
			{byEmail && (
				<>
					{mode === "up" && (
						<Field
							autoComplete="name"
							label={t("account.name")}
							onChange={(e) => setName(e.target.value)}
							value={name}
						/>
					)}
					{fixedEmail ? (
						// the address is given: not a field to edit, but password managers still need it as the username
						<input
							autoComplete="username"
							hidden
							name="username"
							readOnly
							type="email"
							value={fixedEmail}
						/>
					) : (
						<Field
							autoComplete="username"
							autoFocus={!!server}
							label={t("account.email")}
							name="username"
							onChange={(e) => setEmail(e.target.value)}
							required
							type="email"
							value={email}
						/>
					)}
					{withPassword && (
						<Field
							autoComplete={mode === "up" ? "new-password" : "current-password"}
							autoFocus={!!fixedEmail}
							label={t("account.password")}
							minLength={mode === "up" ? 8 : undefined}
							name="password"
							onChange={(e) => setPassword(e.target.value)}
							required
							type="password"
							value={password}
						/>
					)}
				</>
			)}
			{error && (
				<p className="mt-3 text-sm text-danger" role="alert">
					{error}
				</p>
			)}
			{byEmail && (
				<Button className="mt-6 w-full" disabled={busy || !info} type="submit" variant="primary">
					{withPassword ? signInLabel : t("account.sendCode")}
				</Button>
			)}
			{login.emailCode && byPassword && (
				<Button
					className="mt-3 w-full text-center text-sm text-link hover:underline"
					onClick={() => {
						setWithPassword(!withPassword);
						setError("");
					}}
					type="button"
					variant="plain"
				>
					{withPassword ? t("account.useCode") : t("account.usePassword")}
				</Button>
			)}
			{canSignUp && !info?.firstAccount && (
				<Button
					className="mt-3 w-full text-center text-sm text-link hover:underline"
					onClick={() => {
						setMode(mode === "up" ? "in" : "up");
						setError("");
					}}
					type="button"
					variant="plain"
				>
					{mode === "up" ? t("account.haveAccount") : t("account.create")}
				</Button>
			)}
		</form>
	);
}

/**
 * Connect a further server (desktop app): its address (or an invite link of it) first, then
 * signing in there. `onDone` gets its address.
 */
export function ConnectServer({
	initial = "",
	onDone,
}: {
	initial?: string;
	onDone: (server: string) => void;
}) {
	const { t } = useT();
	const [text, setText] = useState(initial);
	const [target, setTarget] = useState<{ url: string; invite?: string } | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<div>
			<Field
				autoCapitalize="off"
				autoFocus
				label={t("server.address")}
				// another address: sign in there anew
				onChange={(e) => {
					setText(e.target.value);
					setError("");
					setTarget(null);
				}}
				onKeyDown={(e) => {
					if (e.key !== "Enter" || target || busy) return;
					e.preventDefault();
					void go();
				}}
				placeholder="https://"
				spellCheck={false}
				value={text}
			/>
			{target ? (
				<SignIn
					inviteCode={target.invite}
					key={target.url}
					onDone={() => onDone(target.url)}
					server={target.url}
				/>
			) : (
				<>
					<p className="mt-1 text-xs text-muted-foreground">{t("server.addressHint")}</p>
					{error && (
						<p className="mt-3 text-sm text-danger" role="alert">
							{error}
						</p>
					)}
					<Button
						className="mt-6 w-full"
						disabled={!text.trim() || busy}
						onClick={() => void go()}
						variant="primary"
					>
						{t("server.continue")}
					</Button>
				</>
			)}
		</div>
	);
	async function go() {
		const s = parseServer(text);
		if (!s) return setError(t("server.invalid"));
		if (s.url === baseOf()) return setError(t("server.ownServer"));
		setBusy(true);
		// there, and does it let this app in? A server that answers but sends no CORS headers for it
		// is older than the desktop app or does not list it (ORBIS_APP_ORIGINS): say so, not "offline"
		const ok = await serverInfo(s.url).then(
			() => "ok" as const,
			async () => ((await answers(s.url)) ? ("closed" as const) : ("gone" as const)),
		);
		setBusy(false);
		if (ok === "ok") setTarget(s);
		else
			setError(
				t(ok === "closed" ? "server.notForApp" : "server.unreachable", {
					server: serverName(s.url),
				}),
			);
	}
}

/** Joining a workspace by its invite link: with the account signed in here, or a new one. */
export function Join({ code }: { code: string }) {
	const { t } = useT();
	const [invitation, setInvitation] = useState<InviteInfo | null | undefined>();
	const [error, setError] = useState("");
	const { account } = useAccounts();
	useEffect(() => {
		invite(code).then(setInvitation, () => setInvitation(null));
	}, [code]);
	const done = () => navigate("/", { replace: true });
	if (invitation === undefined) return null;
	if (invitation === null)
		return (
			<AuthCard intro={t("account.inviteInvalidHint")} title={t("account.inviteInvalid")}>
				<a className="mt-4 block text-sm text-link hover:underline" href="#/inbox">
					{t("nav.inbox")}
				</a>
			</AuthCard>
		);
	return (
		<AuthCard
			intro={t(invitation.role === "owner" ? "account.joinIntroOwner" : "account.joinIntro", {
				by: invitation.by,
				server: serverName(),
			})}
			title={t("account.joinTitle", { workspace: invitation.workspace })}
		>
			{account && !account.lost ? (
				<>
					<p className="mt-4 text-sm">{t("account.joinAs", { email: account.user.email })}</p>
					{error && <p className="mt-3 text-sm text-danger">{error}</p>}
					<Button
						className="mt-6 w-full"
						onClick={() => joinInvite(code).then(done, (e) => setError(errorText(e, t, "space")))}
						variant="primary"
					>
						{t("account.join")}
					</Button>
				</>
			) : (
				<SignIn inviteCode={code} onDone={done} />
			)}
		</AuthCard>
	);
}
