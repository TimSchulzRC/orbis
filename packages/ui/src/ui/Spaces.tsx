// Several workspaces side by side. The selector choice is per device; each part of a page that
// belongs to one workspace sits in its SpaceScope, where useRepo and useFiles read that replica.

import type { Repo } from "@orbis/sync";
import { ChevronsUpDown, Plus } from "lucide-react";
import { Fragment, useId, useMemo, useState, useSyncExternalStore } from "react";
import {
	createSpace,
	errorText,
	replica,
	serverName,
	setShown,
	spaceById,
	spacesOn,
	useAccounts,
} from "../accounts";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { navigate, openItem, parseHash, useSpaceId } from "../hooks";
import { titleOf, tr, useT } from "../i18n";
import { cn } from "../lib/utils";
import { MoveError, moveToSpace, planToSpace } from "../move";
import { canConnect, desktop } from "../platform";
import { globalPage, ScopeContext } from "../scope";
import { ConnectServer } from "../views/Account";
import { BrandLogo } from "./BrandLogo";
import { confirmAction, notify } from "./feedback";
import { Button, Dialog, MenuItem, Popover } from "./primitives";

/** A part of the page that belongs to workspace `id`. A link clicked inside opens there. */
export function SpaceScope({ id, children }: { id: string; children: React.ReactNode }) {
	const { active } = useAccounts();
	const value = useMemo(() => ({ id, ...replica(id) }), [id]);
	const onClickCapture = (e: React.MouseEvent) => {
		const modifiedClick = e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
		if (active?.id === id || e.defaultPrevented || modifiedClick) return;
		const href = (e.target as HTMLElement).closest("a")?.getAttribute("href");
		if (!href?.startsWith("#/") || href.startsWith("#/w/")) return;
		// a page of no workspace ("#/settings", "#/review") stays one
		if (globalPage(href.slice(1).split("?")[0]!.split("/").filter(Boolean))) return;
		e.preventDefault();
		navigate(parseHash(href).rest, { space: id });
	};
	return (
		<ScopeContext.Provider value={value}>
			<div className="contents" onClickCapture={onClickCapture}>
				{children}
			</div>
		</ScopeContext.Provider>
	);
}

/** Shown only once there are several workspaces. */
export function SpaceEyebrow() {
	const { spaces } = useAccounts();
	const id = useSpaceId();
	if (spaces.length < 2) return null;
	return <p className="mb-0.5 text-[13px] text-muted-foreground">{spaceById(id ?? "")?.name}</p>;
}

/** The accounts on this device, each with what to call it: the app's own server's first, then the further ones. */
export function useServers() {
	const { t } = useT();
	const { account, remotes } = useAccounts();
	return [
		{
			server: undefined as string | undefined,
			email: account?.user.email ?? "",
			label: desktop ? t("server.local") : (account?.user.email ?? ""),
			lost: !!account?.lost,
		},
		...remotes.map((r) => ({
			server: r.url as string | undefined,
			email: r.account.user.email,
			label: t("server.accountOn", { email: r.account.user.email, server: serverName(r.url) }),
			lost: !!r.account.lost,
		})),
	];
}

/** Which workspaces are seen: the label says it ("All workspaces", one name, or the names); the menu ticks them. */
export function SpaceSelector({ className, onNew }: { className?: string; onNew: () => void }) {
	const { t } = useT();
	const boxId = useId();
	const { spaces, shown } = useAccounts();
	const servers = useServers();
	const ids = shown.map((s) => s.id);
	const label =
		shown.length === spaces.length && spaces.length > 1
			? t("space.all")
			: shown.map((s) => s.name).join(", ");
	const toggle = (id: string) => {
		const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
		if (next.length) setShown(next);
	};
	return (
		<Popover
			trigger={(p) => (
				// as wide and tall as a row of the navigation below; the logo centred over its icons
				<Button
					variant="plain"
					{...p}
					aria-label={t("space.choose")}
					className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left hover:bg-hover"
				>
					<BrandLogo className="-mx-0.5 size-5 shrink-0" />
					<span className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</span>
					<ChevronsUpDown className="shrink-0 text-faint" size={14} />
				</Button>
			)}
			triggerClass={cn("min-w-0", className)}
		>
			{(close) => (
				<div className="w-72 p-1">
					{/* per account; several at once: boxes, not a choice of one */}
					{servers.map((g) => (
						<Fragment key={g.server ?? ""}>
							<p className="truncate px-2.5 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
								{g.label}
								{g.lost && ` · ${t("account.signedOut")}`}
							</p>
							{spaces
								.filter((s) => s.server === g.server)
								.map((s) => (
									<label
										className="tap-row flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-hover"
										htmlFor={`${boxId}-${s.id}`}
										key={s.id}
									>
										<Checkbox
											checked={ids.includes(s.id)}
											className="size-4"
											disabled={ids.length === 1 && ids.includes(s.id)}
											id={`${boxId}-${s.id}`}
											onCheckedChange={() => toggle(s.id)}
										/>
										<span className="min-w-0 flex-1 truncate">{s.name}</span>
									</label>
								))}
						</Fragment>
					))}
					<div className="my-1 border-t border-line" />
					<MenuItem
						icon={<Plus size={14} />}
						onClick={() => {
							close();
							onNew();
						}}
					>
						{t("space.new")}
					</MenuItem>
				</div>
			)}
		</Popover>
	);
}

/**
 * Without `onChange` the chips edit the sidebar selector's choice; with it a page's own choice
 * (`value`, null for all). From "All", a chip shows that workspace only; then chips toggle one by
 * one, and none left is "All" again.
 */
export function SpaceFilter({
	className,
	value,
	onChange,
}: {
	className?: string;
	value?: string[] | null;
	onChange?: (ids: string[] | null) => void;
}) {
	const { t } = useT();
	const { spaces, shown, allSeen } = useAccounts();
	if (spaces.length < 2) return null;
	const chosen = onChange ? (value ?? null) : allSeen ? null : shown.map((s) => s.id);
	const choose =
		onChange ??
		((ids: string[] | null) => (ids ? setShown(ids, true) : setShown(spaces.map((s) => s.id))));
	const pick = (id: string) => {
		if (!chosen) return choose([id]);
		const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
		choose(next.length ? next : null);
	};
	const on = (id: string) => !!chosen?.includes(id);
	const chip = (pressed: boolean) =>
		cn(
			"shrink-0 whitespace-nowrap rounded-full border px-3 py-1",
			pressed
				? "border-focus bg-surface text-fg"
				: "border-line text-muted-foreground hover:bg-hover hover:text-fg",
		);
	return (
		<fieldset
			aria-label={t("space.choose")}
			className={cn(
				"-mx-4 mb-4 flex min-w-0 gap-1 overflow-x-auto px-4 text-sm [scrollbar-width:none] md:mx-0 md:px-0",
				className,
			)}
		>
			<Button
				aria-pressed={!chosen}
				className={chip(!chosen)}
				onClick={() => choose(null)}
				variant="plain"
			>
				{t("inbox.all")}
			</Button>
			{spaces.map((s) => (
				<Button
					aria-pressed={on(s.id)}
					className={chip(on(s.id))}
					key={s.id}
					onClick={() => pick(s.id)}
					variant="plain"
				>
					{s.name}
				</Button>
			))}
		</fieldset>
	);
}

/** The replicas of these workspaces, re-rendering when any of them changes. */
export function useReplicas(ids: string[]): Repo[] {
	const repos = ids.map((id) => replica(id).repo);
	// a new subscription only when the list of workspaces changes, not with every new array
	const key = ids.join("\n");
	const subscribe = useMemo(() => {
		const subscribed = key ? key.split("\n").map((id) => replica(id).repo) : [];
		return (l: () => void) => {
			const offs = subscribed.map((r) => r.subscribe(l));
			return () => {
				for (const off of offs) off();
			};
		};
	}, [key]);
	useSyncExternalStore(subscribe, () => repos.map((r) => r.getVersion()).join());
	return repos;
}

/** "Anderer Server …" in the choice of servers: one connected here first. */
const OTHER = "+";

/**
 * A new workspace: its name, whether it starts with the examples (set up in the app's language)
 * and, in the desktop app, where it goes – on this device or on a server: one connected already,
 * or another one, connected here first with a new account or an existing one. An account that
 * already has workspaces there brings them along and creates none; otherwise the form stays open
 * with that server chosen.
 */
export function NewSpaceForm({
	name: initial = "",
	onCancel,
	onDone,
}: {
	name?: string;
	onCancel?: () => void;
	onDone?: () => void;
}) {
	const { t } = useT();
	const nameId = useId();
	const examplesId = useId();
	const { remotes } = useAccounts();
	const [name, setName] = useState(initial);
	const [examples, setExamples] = useState(true);
	const [where, setWhere] = useState<"local" | "server">("local");
	const [server, setServer] = useState(remotes[0]?.url ?? OTHER);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const connecting = canConnect && where === "server" && server === OTHER;
	const create = (srv?: string) => {
		setBusy(true);
		setError("");
		return createSpace(name, examples, srv).then(onDone, (err) => {
			setError(errorText(err, t, "space"));
			setBusy(false);
		});
	};
	const submit = () => name.trim() && !busy && void create(where === "server" ? server : undefined);
	return (
		<div>
			{!connecting && (
				<label className="block text-sm font-medium" htmlFor={nameId}>
					{t("space.name")}
					<Input
						autoFocus
						className="mt-1 block bg-surface"
						id={nameId}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key !== "Enter") return;
							e.preventDefault();
							submit();
						}}
						value={name}
					/>
				</label>
			)}
			{!connecting && (
				<label
					className="mt-4 flex cursor-pointer gap-3 rounded-xl border border-line p-3 hover:bg-hover"
					htmlFor={examplesId}
				>
					<Checkbox
						checked={examples}
						className="mt-0.5 size-4 shrink-0"
						id={examplesId}
						onCheckedChange={(checked) => setExamples(checked === true)}
					/>
					<span>
						<span className="block text-sm font-medium">{t("setup.examples")}</span>
						<span className="block text-xs text-muted-foreground">{t("setup.examplesHint")}</span>
					</span>
				</label>
			)}
			{canConnect && (
				<fieldset className="mt-4">
					<legend className="mb-1.5 text-sm font-medium">{t("server.where")}</legend>
					<div className="grid gap-2 sm:grid-cols-2">
						{(["local", "server"] as const).map((w) => (
							<Button
								aria-pressed={where === w}
								className={cn(
									"flex flex-col justify-start rounded-xl border p-3 text-left",
									where === w ? "border-focus bg-surface" : "border-line hover:bg-hover",
								)}
								key={w}
								onClick={() => {
									setWhere(w);
									setError("");
								}}
								variant="plain"
							>
								<p className="text-sm font-medium">
									{t(w === "local" ? "server.local" : "server.remote")}
								</p>
								<p className="text-xs text-muted-foreground">
									{t(w === "local" ? "server.localHint" : "server.remoteHint")}
								</p>
							</Button>
						))}
					</div>
				</fieldset>
			)}
			{canConnect && where === "server" && remotes.length > 0 && (
				<label className="mt-4 block text-sm font-medium">
					{t("server.which")}
					<NativeSelect
						className="mt-1 block w-full bg-surface"
						onChange={(e) => setServer(e.target.value)}
						value={server}
					>
						{remotes.map((r) => (
							<option key={r.url} value={r.url}>
								{t("server.accountOn", { email: r.account.user.email, server: serverName(r.url) })}
							</option>
						))}
						<option value={OTHER}>{t("server.other")}</option>
					</NativeSelect>
				</label>
			)}
			{error && <p className="mt-3 text-sm text-danger">{error}</p>}
			{connecting ? (
				<ConnectServer
					onDone={(url) => {
						// the account's workspaces there came along: no new one unasked
						const there = spacesOn(url);
						if (there[0]) {
							navigate("/", { space: there[0].id });
							onDone?.();
						} else setServer(url);
					}}
				/>
			) : (
				<div className="mt-5 flex justify-end gap-2">
					{onCancel && <Button onClick={onCancel}>{t("cancel")}</Button>}
					<Button
						className={onCancel ? undefined : "w-full"}
						disabled={busy || !name.trim()}
						onClick={submit}
						variant="primary"
					>
						{t("space.create")}
					</Button>
				</div>
			)}
		</div>
	);
}

export function NewSpaceDialog({ onClose }: { onClose: () => void }) {
	const { t } = useT();
	return (
		<Dialog onClose={onClose} title={t("space.new")}>
			<NewSpaceForm onCancel={onClose} onDone={onClose} />
		</Dialog>
	);
}

/** What changes when the page moves to `workspace`, one line each. */
function previewLines(
	plan: Awaited<ReturnType<typeof planToSpace>>,
	from: string,
	workspace: string,
) {
	return [
		plan.items > 1 &&
			tr(plan.files ? "move.preview.itemsFiles" : "move.preview.items", {
				count: plan.items,
				files: plan.files,
			}),
		plan.copiedTypes.length &&
			tr("move.preview.types", {
				count: plan.copiedTypes.length,
				names: plan.copiedTypes.join(", "),
				workspace,
			}),
		plan.freeProps.length &&
			tr("move.preview.free", { count: plan.freeProps.length, names: plan.freeProps.join(", ") }),
		plan.droppedLinks &&
			tr("move.preview.links", { count: plan.droppedLinks, from: spaceById(from)?.name ?? "" }),
	].filter(Boolean);
}

/** Asks first if something changes on the way (a type copied, values that become free properties, links left behind). The moved item's id there, unless it stayed. */
export async function moveTo(
	id: string,
	from: string,
	to: string,
	parent?: string,
): Promise<string | undefined> {
	const workspace = spaceById(to)?.name ?? "";
	try {
		const plan = await planToSpace(id, from, to);
		if (plan.copiedTypes.length || plan.freeProps.length || plan.droppedLinks) {
			const lines = previewLines(plan, from, workspace);
			const item = replica(from).repo.get(id);
			const title = item ? titleOf(item) : tr("untitled");
			if (
				!(await confirmAction({
					title: tr("move.preview.title", { title, workspace }),
					body: lines.map((l) => `– ${l}`).join("\n"),
					yes: tr("move.confirm"),
				}))
			)
				return;
		}
		const moved = await moveToSpace(id, from, to, parent);
		notify.action(tr("move.done", { workspace }), tr("move.open"), () =>
			openItem(moved, { space: to }),
		);
		return moved;
	} catch (e) {
		notify(
			e instanceof MoveError ? tr(`move.error.${e.message}`) : String((e as Error).message ?? e),
		);
	}
}
