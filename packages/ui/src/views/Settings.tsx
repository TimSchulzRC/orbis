// Settings in one dialog over the page: the app's (this device, the account) or one workspace's.

import type {
	InviteLink,
	InviteRequest,
	McpConnect,
	Member,
	PasskeyInfo,
	ServerInfo,
} from "@obtion/core/api";
import { listExamples, removeExamples, restoreExamples } from "@obtion/core/examples";
import { ENDONYMS, fmtBytes, fmtDate, fmtDateTime, LANGS } from "@obtion/core/i18n";
import { SETTINGS_ID, setSettings } from "@obtion/core/model";
import { resetInbox } from "@obtion/core/setup";
import {
	ArrowLeft,
	Check,
	ChevronRight,
	Copy,
	Crown,
	Eye,
	EyeOff,
	KeyRound,
	Link2,
	Plus,
	RotateCcw,
	Trash2,
	UserMinus,
	UserRound,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
	ApiError,
	activeUser,
	addPasskey,
	changePassword,
	deleteAccount,
	deleteSpace,
	errorText,
	inviteLink,
	inviteLinks,
	joinUrl,
	leaveSpace,
	linkedProviders,
	linkFailed,
	linkOAuth,
	loginOf,
	mcpToken,
	mcpTokenInfo,
	members,
	passkeys,
	removeMember,
	removePasskey,
	renameSpace,
	replica,
	revokeInvite,
	revokeMcpToken,
	type Space,
	serverInfo,
	setRole,
	signOut,
	spaceById,
	useAccounts,
} from "../accounts";
import { Checkbox } from "../components/ui/checkbox";
import {
	DialogContent,
	DialogHeader,
	Dialog as DialogRoot,
	DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { navigate, useRepo } from "../hooks";
import { setLang, useT } from "../i18n";
import { cn, toggled } from "../lib/utils";
import { setTheme, useTheme } from "../theme";
import { RulesField, WORKSPACE_RULES } from "../ui/AgentRules";
import { confirmAction, notify } from "../ui/feedback";
import { ItemIcon, TypeGlyph } from "../ui/item-look";
import {
	Button,
	Dialog,
	IconButton,
	MenuItem,
	MoreMenu,
	Popover,
	SectionAction,
	Seg,
} from "../ui/primitives";
import { SettingRow, SettingsGroup } from "../ui/SettingRows";
import { NewSpaceDialog, SpaceScope } from "../ui/Spaces";
import {
	closeSettings,
	openSettings,
	openSpaceSettings,
	useSettingsOpen,
} from "../ui/settings-open";
import { SignIn } from "./Account";

/** navigator.clipboard exists only in a secure context; opened as http://<address>, the old way copies. */
function copyText(text: string) {
	if (navigator.clipboard) return void navigator.clipboard.writeText(text);
	const area = document.createElement("textarea");
	area.value = text;
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.append(area);
	area.select();
	document.execCommand("copy");
	area.remove();
}

const COPIED_MS = 1500;

function CopyButton({ text }: { text: string }) {
	const { t } = useT();
	const [copied, setCopied] = useState(false);
	return (
		<IconButton
			icon={copied ? Check : Copy}
			iconSize={14}
			label={t("settings.copy")}
			onClick={() => {
				copyText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), COPIED_MS);
			}}
			size="sm"
		/>
	);
}

function CopyBox({ text, secret, label }: { text: string; secret?: string; label: string }) {
	const { t } = useT();
	const [revealed, setRevealed] = useState(false);
	const shown = secret && !revealed ? text.replaceAll(secret, "•".repeat(12)) : text;
	return (
		<div className="relative rounded-lg border border-line bg-surface-2">
			<pre
				aria-label={label}
				className="overflow-x-auto whitespace-pre-wrap break-all p-3 pr-20 font-mono text-xs leading-relaxed"
			>
				{shown}
			</pre>
			<div className="absolute right-1.5 top-1.5 flex">
				{secret && (
					<IconButton
						icon={revealed ? EyeOff : Eye}
						iconSize={14}
						label={revealed ? t("settings.hideToken") : t("settings.showToken")}
						onClick={() => setRevealed(!revealed)}
						size="sm"
					/>
				)}
				<CopyButton text={text} />
			</div>
		</div>
	);
}

function GroupError({ error }: { error: string }) {
	return error ? (
		<p className="px-4 py-3 text-sm text-danger" role="alert">
			{error}
		</p>
	) : null;
}

function SpaceGroup({ space }: { space: Space }) {
	const { t } = useT();
	const [name, setName] = useState(space.name);
	const [error, setError] = useState("");
	const owner = space.role === "owner";
	const fail = (e: unknown) => setError(errorText(e, t, "space"));
	const remove = async () => {
		const yes = await confirmAction({
			title: t("space.deleteConfirm", { name: space.name }),
			body: t("space.deleteHint"),
			yes: t("space.delete"),
			danger: true,
		});
		if (yes) await deleteSpace(space).catch(fail);
	};
	return (
		<SettingsGroup title={t("space.general")}>
			<SettingRow
				control={
					owner ? (
						<form
							className="flex items-center gap-2"
							onSubmit={(e) => (e.preventDefault(), void renameSpace(space, name).catch(fail))}
						>
							<Input
								aria-label={t("space.name")}
								className="h-8 w-44 bg-bg py-1"
								onChange={(e) => setName(e.target.value)}
								value={name}
							/>
							<Button
								disabled={!name.trim() || name === space.name}
								type="submit"
								variant="outline"
							>
								{t("space.rename")}
							</Button>
						</form>
					) : (
						<span className="text-sm">{space.name}</span>
					)
				}
				hint={t("space.intro", { server: location.host })}
				title={t("space.name")}
			/>
			<SettingRow
				control={
					<Button onClick={() => void leaveSpace(space).catch(fail)} variant="outline">
						{t("space.leave")}
					</Button>
				}
				hint={t("space.leaveHint")}
				title={t("space.leave")}
			/>
			<SettingRow
				control={
					owner && (
						<Button onClick={() => void remove()} variant="danger-outline">
							{t("space.delete")}
						</Button>
					)
				}
				hint={t(owner ? "space.deleteHint" : "space.deleteOwner")}
				title={t("space.delete")}
			/>
			<GroupError error={error} />
		</SettingsGroup>
	);
}

function MembersGroup({ space, onRemoved }: { space: Space; onRemoved: () => void }) {
	const { t } = useT();
	const [list, setList] = useState<Member[]>([]);
	const [error, setError] = useState("");
	const load = () => members(space).then(setList, () => {});
	useEffect(() => void load(), [space.id]);
	const owner = space.role === "owner";
	const me = activeUser();
	const fail = (e: unknown) => setError(errorText(e, t, "space"));
	const who = (member: Member) => member.name || member.email;
	const changeRole = async (member: Member) => {
		const role = member.role === "owner" ? "member" : "owner";
		const yes = await confirmAction({
			title: t(`space.make.${role}.confirm`, { name: who(member) }),
			body: t(`space.make.${role}.hint`, { name: who(member) }),
			yes: t(`space.make.${role}`),
		});
		if (yes) await setRole(space, member.id, role).then(load, fail);
	};
	const remove = async (member: Member) => {
		const yes = await confirmAction({
			title: t("space.removeConfirm", { name: who(member), workspace: space.name }),
			body: t("space.removeHint", { name: who(member) }),
			yes: t("space.remove"),
			danger: true,
		});
		// their invite links went with them
		if (yes) await removeMember(space, member.id).then(() => (void load(), onRemoved()), fail);
	};
	return (
		<SettingsGroup hint={owner ? undefined : t("space.inviteOwners")} title={t("space.memberList")}>
			<ul aria-label={t("space.memberList")} className="divide-y divide-line">
				{list.map((member) => (
					<li className="flex min-h-14 items-center gap-3 px-4 py-2.5" key={member.id}>
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm font-medium">{who(member)}</p>
							{member.name && (
								<p className="truncate text-xs text-muted-foreground">{member.email}</p>
							)}
						</div>
						<span className="shrink-0 text-xs text-muted-foreground">
							{t(`space.role.${member.role}`)}
						</span>
						{owner && member.id !== me ? (
							<MoreMenu
								iconSize={14}
								label={t("space.memberMenu", { name: who(member) })}
								size="sm"
							>
								{(close) => (
									<>
										<MenuItem
											icon={member.role === "owner" ? <UserRound size={14} /> : <Crown size={14} />}
											onClick={() => (close(), void changeRole(member))}
										>
											{t(`space.make.${member.role === "owner" ? "member" : "owner"}`)}
										</MenuItem>
										<MenuItem
											danger
											icon={<UserMinus size={14} />}
											onClick={() => (close(), void remove(member))}
										>
											{t("space.remove")}
										</MenuItem>
									</>
								)}
							</MoreMenu>
						) : (
							owner && <span className="w-7 shrink-0" />
						)}
					</li>
				))}
			</ul>
			<GroupError error={error} />
		</SettingsGroup>
	);
}

function InviteLinksGroup({ space, version }: { space: Space; version: number }) {
	const { t, lang } = useT();
	const [links, setLinks] = useState<InviteLink[]>([]);
	const [error, setError] = useState("");
	const fail = (e: unknown) => setError(errorText(e, t, "space"));
	const load = () => inviteLinks(space).then(setLinks, fail);
	useEffect(() => void load(), [space.id, version]);
	const day = (ts: number) => fmtDate(lang, new Date(ts).toISOString());
	const create = (opts: InviteRequest) => inviteLink(space, opts).then(load, fail);
	const revoke = async (link: InviteLink) => {
		const yes = await confirmAction({
			title: t("space.revokeConfirm"),
			body: t("space.revokeHint", {
				role: t(`space.role.${link.role}`),
				created: day(link.created),
			}),
			yes: t("space.revoke"),
			danger: true,
		});
		if (yes) await revokeInvite(space, link.code).then(load, fail);
	};
	const newLink = (
		<Popover
			align="right"
			trigger={(props) => (
				<SectionAction {...props} icon={Link2}>
					{t("space.inviteNew")}
				</SectionAction>
			)}
		>
			{(close) => (
				<>
					<MenuItem
						icon={<UserRound size={14} />}
						onClick={() => (close(), void create({ role: "member" }))}
					>
						{t("space.inviteNew.member")}
					</MenuItem>
					<MenuItem
						icon={<Crown size={14} />}
						onClick={() => (close(), void create({ role: "owner" }))}
					>
						{t("space.inviteNew.owner")}
					</MenuItem>
				</>
			)}
		</Popover>
	);
	return (
		<SettingsGroup action={newLink} hint={t("space.inviteHint")} title={t("space.invites")}>
			{links.length ? (
				<ul aria-label={t("space.invites")} className="divide-y divide-line">
					{links.map((link) => (
						<li className="flex items-center gap-2 py-2.5 pl-4 pr-2" key={link.code}>
							<div className="min-w-0 flex-1">
								<code className="block truncate font-mono text-xs">{joinUrl(link.code)}</code>
								<p className="mt-0.5 truncate text-xs text-muted-foreground">
									{t(`space.role.${link.role}`)} ·{" "}
									{t(link.by ? "space.inviteBy" : "space.inviteMade", {
										by: link.by,
										created: day(link.created),
										expires: day(link.expires),
									})}
								</p>
							</div>
							<CopyButton text={joinUrl(link.code)} />
							<Button onClick={() => void revoke(link)} small>
								{t("space.revoke")}
							</Button>
						</li>
					))}
				</ul>
			) : (
				<p className="px-4 py-3 text-sm text-muted-foreground">{t("space.invitesNone")}</p>
			)}
			<GroupError error={error} />
		</SettingsGroup>
	);
}

function AccountGroup() {
	const { t } = useT();
	const { account } = useAccounts();
	const [deleting, setDeleting] = useState(false);
	const [changing, setChanging] = useState(false);
	const [info, setInfo] = useState<ServerInfo | null>(null);
	useEffect(() => void serverInfo().then(setInfo, () => {}), []);
	if (!account) return null;
	const login = loginOf(info);
	return (
		<SettingsGroup title={t("account.title")}>
			<SettingRow
				control={
					<Button onClick={() => void signOut()} variant="outline">
						{t("account.signOut")}
					</Button>
				}
				hint={
					t("account.thisServer", { server: location.host }) +
					(account.lost ? ` · ${t("account.signedOut")}` : "")
				}
				title={account.user.email}
			/>
			{/* an account that signs in by code, passkey or provider has no password to change */}
			{account.password !== false && (
				<SettingRow
					control={
						<Button onClick={() => setChanging(true)} variant="outline">
							{t("account.changePassword")}
						</Button>
					}
					hint={t("account.changePasswordHint")}
					title={t("account.password")}
				/>
			)}
			{login.passkey && !account.lost && <Passkeys />}
			{login.oauth.length > 0 && !account.lost && <Providers providers={login.oauth} />}
			<SettingRow
				control={
					<Button onClick={() => setDeleting(true)} variant="danger-outline">
						{t("account.delete")}
					</Button>
				}
				hint={t("account.deleteHint")}
				title={t("account.delete")}
			/>
			{changing && <ChangePasswordDialog onClose={() => setChanging(false)} />}
			{deleting && <DeleteAccountDialog onClose={() => setDeleting(false)} />}
		</SettingsGroup>
	);
}

const MIN_PASSWORD = 8;

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
	const { t } = useT();
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [repeat, setRepeat] = useState("");
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const [error, setError] = useState("");
	if (done)
		return (
			<Dialog onClose={onClose} title={t("account.changePassword")}>
				<p className="text-sm" role="status">
					{t("account.passwordChanged")}
				</p>
				<div className="mt-4 flex gap-2">
					<Button onClick={onClose}>{t("close")}</Button>
				</div>
			</Dialog>
		);
	return (
		<Dialog
			onClose={() => {
				if (!busy) onClose();
			}}
			title={t("account.changePassword")}
		>
			<form
				onSubmit={async (e) => {
					e.preventDefault();
					if (busy) return;
					if (next !== repeat) return setError(t("account.passwordMismatch"));
					setBusy(true);
					setError("");
					try {
						await changePassword(current, next);
						setDone(true);
					} catch (err) {
						setError(errorText(err, t, "password"));
					}
					setBusy(false);
				}}
			>
				<p className="mb-4 text-sm text-muted-foreground">{t("account.changePasswordHint")}</p>
				<label className="block text-sm">
					{t("account.currentPassword")}
					<Input
						autoComplete="current-password"
						className="mt-1 block"
						disabled={busy}
						onChange={(e) => setCurrent(e.target.value)}
						required
						type="password"
						value={current}
					/>
				</label>
				<label className="mt-3 block text-sm">
					{t("account.newPassword")}
					<Input
						autoComplete="new-password"
						className="mt-1 block"
						disabled={busy}
						minLength={MIN_PASSWORD}
						onChange={(e) => setNext(e.target.value)}
						required
						type="password"
						value={next}
					/>
				</label>
				<label className="mt-3 block text-sm">
					{t("account.repeatPassword")}
					<Input
						autoComplete="new-password"
						className="mt-1 block"
						disabled={busy}
						minLength={MIN_PASSWORD}
						onChange={(e) => setRepeat(e.target.value)}
						required
						type="password"
						value={repeat}
					/>
				</label>
				{error && (
					<p className="mt-3 text-sm text-danger" role="alert">
						{error}
					</p>
				)}
				<div className="mt-4 flex gap-2">
					<Button disabled={busy} onClick={onClose} type="button" variant="outline">
						{t("cancel")}
					</Button>
					<Button disabled={busy || !current || !next || !repeat} type="submit">
						{t("account.changePassword")}
					</Button>
				</div>
			</form>
		</Dialog>
	);
}

/**
 * For what needs a recent sign-in: signing in again with a way this account already has keeps
 * everything on this device. `onDone` lets what asked for it go on.
 */
function Reauth({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
	const { t } = useT();
	const { account } = useAccounts();
	// the passkey button only for an account that has one; offered when the list fails
	const [hasPasskey, setHasPasskey] = useState<boolean | undefined>(false);
	useEffect(
		() =>
			void passkeys().then(
				(list) => setHasPasskey(list.length > 0),
				() => setHasPasskey(undefined),
			),
		[],
	);
	const userId = account?.user.id;
	// a passkey of another account signs that one in instead: then nothing goes on
	const done = () => (activeUser() === userId ? onDone() : onClose());
	if (!account) return null;
	return (
		<Dialog onClose={onClose} title={t("account.reauth")}>
			<p className="text-sm text-muted-foreground">{t("account.reauthHint")}</p>
			<p className="mt-3 truncate text-sm font-medium">{account.user.email}</p>
			<SignIn
				email={account.user.email}
				hasPasskey={hasPasskey}
				hasPassword={account.password !== false}
				onDone={done}
			/>
		</Dialog>
	);
}

function Passkeys() {
	const { t } = useT();
	const [list, setList] = useState<PasskeyInfo[] | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [reauth, setReauth] = useState(false);
	const load = () => passkeys().then(setList, () => setList([]));
	useEffect(() => void load(), []);
	const add = async () => {
		setBusy(true);
		setError("");
		try {
			await addPasskey();
			notify(t("account.passkeyAdded"));
			await load();
		} catch (err) {
			const closed = err instanceof Error && err.name === "NotAllowedError";
			if (err instanceof ApiError && err.status === 403) setReauth(true);
			else if (!closed) setError(t("account.passkeyFailed"));
		} finally {
			setBusy(false);
		}
	};
	const supported = !!window.PublicKeyCredential && window.isSecureContext;
	return (
		<SettingRow
			control={
				<Button disabled={busy || !supported} onClick={() => void add()} variant="outline">
					<KeyRound size={14} /> {t("account.addPasskey")}
				</Button>
			}
			hint={t(supported ? "account.passkeysHint" : "account.passkeysUnsupported")}
			title={t("account.passkeys")}
		>
			{list && list.length > 0 && (
				<ul className="divide-y divide-line rounded-lg border border-line text-sm">
					{list.map((passkey) => (
						<li className="flex items-center gap-2 py-1.5 pl-3 pr-1.5" key={passkey.id}>
							<KeyRound className="shrink-0 text-muted-foreground" size={14} />
							<span className="min-w-0 flex-1 truncate">
								{passkey.name || t("account.passkey")}
							</span>
							<span className="shrink-0 text-xs text-muted-foreground">
								{new Date(passkey.createdAt).toLocaleDateString()}
							</span>
							<Button
								aria-label={t("account.removePasskey")}
								className="tap rounded-md p-1.5 text-muted-foreground hover:bg-hover"
								onClick={() =>
									void removePasskey(passkey.id).then(load, () => setError(t("account.offline")))
								}
								title={t("account.removePasskey")}
								variant="plain"
							>
								<Trash2 size={14} />
							</Button>
						</li>
					))}
				</ul>
			)}
			{error && (
				<p className="text-sm text-danger" role="alert">
					{error}
				</p>
			)}
			{reauth && (
				<Reauth onClose={() => setReauth(false)} onDone={() => (setReauth(false), void add())} />
			)}
		</SettingRow>
	);
}

function Providers({ providers }: { providers: { id: string; name: string }[] }) {
	const { t } = useT();
	const [linked, setLinked] = useState<string[] | null>(null);
	const [error, setError] = useState(
		linkFailed ? t(linkFailed === "taken" ? "account.linkTaken" : "account.linkFailed") : "",
	);
	const [reauth, setReauth] = useState<string | null>(null);
	useEffect(() => void linkedProviders().then(setLinked, () => setLinked([])), []);
	const link = (id: string) => {
		setError("");
		// 403: needs a recent sign-in, then go on
		void linkOAuth(id).catch((e: unknown) =>
			e instanceof ApiError && e.status === 403 ? setReauth(id) : setError(t("account.linkFailed")),
		);
	};
	return (
		<>
			{providers.map((provider) => (
				<SettingRow
					control={
						linked?.includes(provider.id) ? (
							<span className="text-xs text-muted-foreground">{t("account.linked")}</span>
						) : (
							<Button disabled={!linked} onClick={() => link(provider.id)} variant="outline">
								{t("account.link")}
							</Button>
						)
					}
					hint={t("account.providers")}
					key={provider.id}
					title={provider.name}
				/>
			))}
			<GroupError error={error} />
			{reauth && (
				<Reauth onClose={() => setReauth(null)} onDone={() => (setReauth(null), link(reauth))} />
			)}
		</>
	);
}

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
	const { t } = useT();
	const { account } = useAccounts();
	// without a password: a recent sign-in is the proof
	const withPassword = account?.password !== false;
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [reauth, setReauth] = useState(false);
	const remove = async () => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await deleteAccount(withPassword ? password : undefined);
		} catch (err) {
			if (
				!withPassword &&
				err instanceof ApiError &&
				err.status === 403 &&
				err.message === "sign in again"
			)
				setReauth(true);
			else setError(errorText(err, t, "deleteAccount"));
			setBusy(false);
		}
	};
	if (reauth) return <Reauth onClose={onClose} onDone={() => (setReauth(false), void remove())} />;
	return (
		<Dialog
			onClose={() => {
				if (!busy) onClose();
			}}
			title={t("account.delete")}
		>
			<form onSubmit={(e) => (e.preventDefault(), void remove())}>
				<p className="mb-4 text-sm text-muted-foreground">{t("account.deleteHint")}</p>
				{withPassword && (
					<label className="block text-sm">
						{t("account.password")}
						<Input
							autoComplete="current-password"
							className="mt-1 block"
							disabled={busy}
							onChange={(e) => setPassword(e.target.value)}
							required
							type="password"
							value={password}
						/>
					</label>
				)}
				{error && (
					<p className="mt-3 text-sm text-danger" role="alert">
						{error}
					</p>
				)}
				<div className="mt-4 flex gap-2">
					<Button disabled={busy} onClick={onClose} type="button" variant="outline">
						{t("cancel")}
					</Button>
					<Button disabled={busy || (withPassword && !password)} type="submit" variant="danger">
						{t("account.delete")}
					</Button>
				</div>
			</form>
		</Dialog>
	);
}

function WorkspacesGroup() {
	const { t } = useT();
	const { spaces } = useAccounts();
	const [creating, setCreating] = useState(false);
	return (
		<SettingsGroup hint={t("settings.workspacesHint")} title={t("settings.workspaces")}>
			{spaces.map((space) => (
				<Button
					className="tap-row flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-hover"
					key={space.id}
					onClick={() => openSpaceSettings(space.id)}
					variant="plain"
				>
					<span className="min-w-0 flex-1 truncate font-medium">{space.name}</span>
					<span className="shrink-0 text-xs text-muted-foreground">
						{t(`space.role.${space.role}`)}
					</span>
					<ChevronRight className="shrink-0 text-faint" size={15} />
				</Button>
			))}
			<Button
				className="tap-row flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-muted-foreground hover:bg-hover hover:text-fg"
				onClick={() => setCreating(true)}
				variant="plain"
			>
				<Plus size={15} /> {t("space.new")}
			</Button>
			{creating && <NewSpaceDialog onClose={() => setCreating(false)} />}
		</SettingsGroup>
	);
}

/** The file stores of every workspace on this device, re-rendering when any of them changes. */
function useAllFiles() {
	const { spaces } = useAccounts();
	const ids = spaces.map((space) => space.id).join();
	const list = useMemo(() => spaces.map((space) => replica(space.id).files), [ids]);
	const subscribe = useMemo(
		() => (onChange: () => void) => {
			const offs = list.map((files) => files.subscribe(onChange));
			return () => offs.forEach((off) => off());
		},
		[list],
	);
	useSyncExternalStore(subscribe, () => list.map((files) => files.getVersion()).join());
	return list;
}

function DeviceFilesGroup() {
	const { t, lang } = useT();
	const all = useAllFiles();
	const mode = all[0]?.mode ?? "online";
	const sum = (field: "originals" | "total" | "bytes" | "downloading" | "uploading") =>
		all.reduce((n, files) => n + files.status[field], 0);
	// one choice for all workspaces
	const setMode = (next: "online" | "local") => {
		for (const files of all) files.setMode(next), next === "online" && void files.dropOriginals();
	};
	const status = [
		t("settings.filesStatus", {
			local: sum("originals"),
			total: sum("total"),
			size: fmtBytes(lang, sum("bytes")),
		}),
		sum("downloading") > 0 && t("settings.downloading", { count: sum("downloading") }),
		sum("uploading") > 0 && t("settings.uploading", { count: sum("uploading") }),
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<SettingsGroup title={t("settings.files")}>
			<SettingRow
				control={
					<Seg
						label={t("settings.originals")}
						onChange={setMode}
						options={(["online", "local"] as const).map((m) => ({
							value: m,
							label: t("settings.mode." + m),
						}))}
						value={mode}
					/>
				}
				hint={t("settings.mode." + mode + "Hint")}
				title={t("settings.originals")}
			>
				<DeviceFilesMeter local={sum("originals")} status={status} total={sum("total")} />
			</SettingRow>
		</SettingsGroup>
	);
}

function DeviceFilesMeter({
	local,
	total,
	status,
}: {
	local: number;
	total: number;
	status: string;
}) {
	const { t } = useT();
	const share = total ? local / total : 0;
	return (
		<div className="space-y-1.5">
			<div className="flex items-baseline justify-between gap-3 text-xs">
				<span className="text-muted-foreground">{t("settings.onDevice")}</span>
				<span className="tabular-nums text-muted-foreground">{status}</span>
			</div>
			<div
				aria-label={t("settings.onDevice")}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={Math.round(share * 100)}
				className="h-1 overflow-hidden rounded-full bg-surface-2 dark:bg-hover"
				role="progressbar"
			>
				<div
					className="h-full rounded-full bg-foreground/60 transition-[width]"
					style={{ width: `${share * 100}%` }}
				/>
			</div>
		</div>
	);
}

/** Which build the server runs, to tell the dev, nightly and stable instances apart. */
function Version() {
	const { t } = useT();
	const [info, setInfo] = useState<{ version: string; commit: string }>();
	useEffect(() => {
		serverInfo().then(setInfo, () => {});
	}, []);
	if (!info?.version) return null;
	return (
		<p className="text-center text-xs text-muted-foreground">
			{t("settings.version", { version: info.version + (info.commit ? ` (${info.commit})` : "") })}
		</p>
	);
}

/** Mounted once in the app. */
export function SettingsHost() {
	const open = useSettingsOpen();
	return open ? <SettingsDialog onClose={closeSettings} space={open.space} /> : null;
}

/** With `space`, that workspace's settings; a workspace that is gone (left, deleted) shows the app's. */
function SettingsDialog({ space: id, onClose }: { space: string | null; onClose: () => void }) {
	const { t } = useT();
	useAccounts(); // a workspace renamed or gone shows at once
	const space = id ? spaceById(id) : undefined;
	const previous = useRef<HTMLElement | null>(document.activeElement as HTMLElement);
	return (
		<DialogRoot
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			open
		>
			<DialogContent
				aria-describedby={undefined}
				className="flex h-[min(46rem,88vh)] flex-col gap-0 overflow-hidden rounded-2xl bg-bg p-0 sm:max-w-2xl"
				onCloseAutoFocus={(e) => {
					e.preventDefault();
					if (previous.current?.isConnected) previous.current.focus({ preventScroll: true });
				}}
				showCloseButton={false}
			>
				<DialogHeader className="flex-row items-center gap-2 border-b border-line px-5 py-3 text-left">
					{space && (
						<IconButton
							className="-ml-2"
							icon={ArrowLeft}
							label={t("nav.settings")}
							onClick={openSettings}
						/>
					)}
					<DialogTitle className="min-w-0 flex-1 truncate text-base">
						{space ? `${t("space.settings")} · ${space.name}` : t("nav.settings")}
					</DialogTitle>
					<IconButton icon={X} label={t("close")} onClick={onClose} />
				</DialogHeader>
				{/* a new key for each view, so it starts scrolled to the top */}
				<div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" key={space?.id ?? ""}>
					{space ? (
						<SpaceScope id={space.id}>
							<SpaceSettings space={space} />
						</SpaceScope>
					) : (
						<AppSettings />
					)}
				</div>
			</DialogContent>
		</DialogRoot>
	);
}

function AppSettings() {
	const { t, lang } = useT();
	const theme = useTheme();
	return (
		<div className="space-y-7">
			<SettingsGroup title={t("settings.general")}>
				<SettingRow
					control={
						<Seg
							label={t("settings.language")}
							onChange={setLang}
							options={LANGS.map((language) => ({ value: language, label: ENDONYMS[language] }))}
							value={lang}
						/>
					}
					hint={t("settings.languageHint")}
					title={t("settings.language")}
				/>
				<SettingRow
					control={
						<Seg
							label={t("settings.theme")}
							onChange={setTheme}
							options={(["system", "light", "dark"] as const).map((choice) => ({
								value: choice,
								label: t("theme." + choice),
							}))}
							value={theme.choice}
						/>
					}
					hint={t("settings.themeHint")}
					title={t("settings.theme")}
				/>
			</SettingsGroup>
			<DeviceFilesGroup />
			<AccountGroup />
			<WorkspacesGroup />
			<Version />
		</div>
	);
}

/** "#/settings": Heute with the settings open over it. */
export function SettingsRedirect() {
	useEffect(() => {
		navigate("/", { replace: true });
		openSettings();
	}, []);
	return null;
}

/** "#/w/<id>/settings": that workspace with its settings open over it. */
export function SpaceSettingsRedirect({ space }: { space: string }) {
	useEffect(() => {
		navigate("/", { space, replace: true });
		openSpaceSettings(space);
	}, [space]);
	return null;
}

function SpaceSettings({ space }: { space: Space }) {
	const repo = useRepo();
	const { t, lang } = useT();
	// an MCP token is made on request (each is a new one, shown once)
	const [connect, setConnect] = useState<McpConnect | null>(null);
	const [tokenFailed, setTokenFailed] = useState(false);
	// when the user's token was made; null without one, undefined while unknown (offline)
	const [tokenCreated, setTokenCreated] = useState<number | null>();
	const [tokenError, setTokenError] = useState("");
	const [removed, setRemoved] = useState(0);
	useEffect(
		() =>
			void mcpTokenInfo(space).then(
				(info) => setTokenCreated(info.created),
				() => {},
			),
		[space.id],
	);
	const newToken = () =>
		mcpToken(space).then(
			(c) => (setConnect(c), setTokenCreated(Date.now()), setTokenError("")),
			() => setTokenFailed(true),
		);
	const removeToken = async () => {
		const yes = await confirmAction({
			title: t("settings.removeTokenConfirm"),
			body: t("settings.removeTokenHint"),
			yes: t("settings.removeToken"),
			danger: true,
		});
		if (!yes) return;
		await revokeMcpToken(space).then(
			() => (setConnect(null), setTokenCreated(null), setTokenError("")),
			(e) => setTokenError(errorText(e, t, "space")),
		);
	};
	const status = repo.status;
	const ix = repo.index();
	const capture = repo.get(SETTINGS_ID)?.settings?.captureTypes ?? [];
	const types = [...ix.types.values()].sort((a, b) => a.schema!.name.localeCompare(b.schema!.name));
	const without = (id: string) => capture.filter((other) => other !== id);
	const toggleCapture = (id: string) =>
		repo.change(SETTINGS_ID, (doc) =>
			setSettings(doc, { captureTypes: capture.includes(id) ? without(id) : [...capture, id] }),
		);
	// the first capture type is the one "c" files to in the inbox
	const setFirst = (id: string) =>
		repo.change(SETTINGS_ID, (doc) => setSettings(doc, { captureTypes: [id, ...without(id)] }));
	const chosen = capture.filter((id) => ix.types.has(id));

	return (
		<div className="space-y-7">
			<SpaceGroup space={space} />
			<MembersGroup onRemoved={() => setRemoved((n) => n + 1)} space={space} />
			{space.role === "owner" && <InviteLinksGroup space={space} version={removed} />}
			<ExamplesGroup />

			<SettingsGroup title={t("settings.capture")}>
				<SettingRow hint={t("settings.captureHint")} title={t("settings.captureTypes")}>
					<div className="flex flex-wrap gap-1.5">
						{types.map((type) => (
							<Button
								aria-pressed={capture.includes(type.id)}
								className={cn(
									"tap-y inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
									capture.includes(type.id)
										? "border-focus text-fg"
										: "border-line text-muted-foreground",
								)}
								key={type.id}
								onClick={() => toggleCapture(type.id)}
								variant="plain"
							>
								<TypeGlyph schema={type.schema} size={12} /> {type.schema!.name}
							</Button>
						))}
					</div>
				</SettingRow>
				{chosen.length > 0 && (
					<SettingRow
						control={
							<NativeSelect
								aria-label={t("settings.captureDefault")}
								className="tap-row rounded-md border border-line bg-bg px-2 py-1 text-sm"
								onChange={(e) => setFirst(e.target.value)}
								value={chosen[0]}
							>
								{chosen.map((id) => (
									<option key={id} value={id}>
										{ix.types.get(id)!.schema!.name}
									</option>
								))}
							</NativeSelect>
						}
						hint={t("settings.captureDefaultHint")}
						title={t("settings.captureDefault")}
					/>
				)}
			</SettingsGroup>

			<SettingsGroup title={t("settings.agent")}>
				<SettingRow
					control={
						!connect && (
							<Button onClick={() => void newToken()} variant="outline">
								{t("settings.newToken")}
							</Button>
						)
					}
					hint={t("settings.agentIntro")}
					title={t("settings.mcpToken")}
				>
					{tokenFailed && !connect && (
						<p className="text-sm text-muted-foreground">{t("settings.connectOffline")}</p>
					)}
					{tokenCreated != null && (
						<div className={cn("flex flex-wrap items-center gap-2", connect && "mb-4")}>
							<p className="min-w-0 flex-1 text-sm text-muted-foreground">
								{t("settings.tokenActive", { created: fmtDateTime(lang, tokenCreated) })}
							</p>
							<Button onClick={() => void removeToken()} variant="danger-outline">
								<Trash2 size={14} /> {t("settings.removeToken")}
							</Button>
						</div>
					)}
					{tokenError && (
						<p className="text-sm text-danger" role="alert">
							{tokenError}
						</p>
					)}
					{connect && (
						<div className="space-y-4">
							<div>
								<div className="mb-1 text-sm font-medium">Claude Code</div>
								<CopyBox label="Claude Code" secret={connect.token} text={connect.claudeCode} />
							</div>
							<div>
								<div className="mb-1 text-sm font-medium">{t("settings.otherClients")}</div>
								<CopyBox
									label="MCP JSON"
									secret={connect.token}
									text={JSON.stringify(connect.json, null, 2)}
								/>
							</div>
							<p className="text-sm text-muted-foreground">
								{t("settings.mirror")}{" "}
								<code className="rounded bg-surface-2 px-1 font-mono text-xs">{connect.vault}</code>
							</p>
						</div>
					)}
				</SettingRow>
				<div id={WORKSPACE_RULES}>
					<SettingRow hint={t("rules.workspaceHint")} title={t("rules.title")}>
						<RulesField
							id={SETTINGS_ID}
							label={t("rules.title")}
							placeholder={t("rules.placeholder")}
							value={repo.get(SETTINGS_ID)?.rules ?? ""}
						/>
					</SettingRow>
				</div>
			</SettingsGroup>

			<SettingsGroup title={t("settings.sync")}>
				<SettingRow
					control={
						<span className="text-sm text-muted-foreground">
							{status.online ? t("settings.connected") : t("settings.offline")}
						</span>
					}
					title={t("settings.server")}
				/>
				{status.pending > 0 && (
					<SettingRow
						control={
							<span className="text-sm tabular-nums text-muted-foreground">{status.pending}</span>
						}
						title={t("settings.pending")}
					/>
				)}
				<SettingRow
					hint={t("settings.counts", {
						items: ix.live.filter((item) => item.kind === "note").length,
						files: ix.live.filter((item) => item.kind === "file").length,
						types: ix.types.size,
					})}
					title={t("settings.onDevice")}
				/>
				<SettingRow
					hint={`${t("settings.position")} #${status.lastSeq}`}
					title={t("settings.advanced")}
				>
					<div className="flex flex-wrap gap-2">
						<Button onClick={() => repo.resetLocal()} variant="outline">
							{t("settings.redownload")}
						</Button>
						<Button onClick={() => resetInbox(repo.writer)} variant="outline">
							<RotateCcw size={14} /> {t("inbox.reset")}
						</Button>
					</div>
				</SettingRow>
			</SettingsGroup>
		</div>
	);
}

/** Examples someone changed or uses are not preselected. */
function ExamplesGroup() {
	const repo = useRepo();
	const { t } = useT();
	const ix = repo.index();
	const list = listExamples(ix);
	const [chosen, setChosen] = useState<Set<string> | null>(null); // while the preview is open
	if (!list.length) return null;
	const toggle = (id: string) => setChosen((current) => toggled(current!, id));
	const remove = () => {
		const ids = removeExamples(repo.writer, ix, [...chosen!]);
		setChosen(null);
		notify.undo(
			t("examples.removed", {
				count: ids.filter((id) => !list.find((example) => example.id === id)?.isType).length,
			}),
			() => restoreExamples(repo.writer, ids),
		);
	};
	const entries = list.filter((example) => !example.isType).length;
	const picked = chosen
		? list.filter((example) => !example.isType && chosen.has(example.id)).length
		: 0;
	return (
		<SettingsGroup title={t("examples.title")}>
			<SettingRow
				control={
					<Button
						onClick={() =>
							setChosen(
								new Set(
									list
										.filter((example) => !example.changed && !example.inUse)
										.map((example) => example.id),
								),
							)
						}
						variant="outline"
					>
						{t("examples.remove")}
					</Button>
				}
				hint={t("examples.intro", { count: entries })}
				title={t("examples.fromSetup")}
			/>
			{chosen && (
				<Dialog onClose={() => setChosen(null)} title={t("examples.dialogTitle")} wide>
					<p className="text-sm text-muted-foreground">{t("examples.preview")}</p>
					<ul className="mt-3 max-h-[50vh] overflow-y-auto rounded-lg border border-line p-1">
						{list.map((example) => {
							const item = ix.get(example.id);
							return (
								<li key={example.id}>
									<label
										className={cn(
											"tap-row flex items-center gap-2 rounded-md px-2 py-1 text-sm",
											example.inUse ? "text-muted-foreground" : "cursor-pointer hover:bg-hover",
										)}
									>
										<Checkbox
											checked={chosen.has(example.id)}
											className="size-4 shrink-0"
											disabled={example.inUse}
											onCheckedChange={() => toggle(example.id)}
										/>
										{example.isType ? (
											<TypeGlyph schema={item?.schema} size={14} />
										) : (
											item && <ItemIcon item={item} size={14} />
										)}
										<span className="min-w-0 truncate">{example.title || t("untitled")}</span>
										{example.isType && (
											<span className="text-xs text-muted-foreground">{t("examples.type")}</span>
										)}
										{example.inUse ? (
											<span className="ml-auto shrink-0 text-xs text-muted-foreground">
												{t("examples.inUse")}
											</span>
										) : (
											example.changed && (
												<span className="ml-auto shrink-0 rounded-full border border-line px-1.5 text-xs text-muted-foreground">
													{t("examples.changed")}
												</span>
											)
										)}
									</label>
								</li>
							);
						})}
					</ul>
					<div className="mt-4 flex flex-wrap justify-end gap-2">
						<Button onClick={() => setChosen(null)} variant="ghost">
							{t("cancel")}
						</Button>
						<Button disabled={!picked} onClick={remove} variant="danger">
							{t("examples.confirm", { count: picked })}
						</Button>
					</div>
				</Dialog>
			)}
		</SettingsGroup>
	);
}
