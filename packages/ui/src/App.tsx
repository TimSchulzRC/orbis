import { SETTINGS_ID } from "@obtion/core/model";
import {
	History,
	Inbox,
	Menu,
	PanelLeftClose,
	PanelLeftOpen,
	Search,
	SlidersHorizontal,
	Sun,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { signOut, useAccounts } from "./accounts";
import { Backdrop, ModalSurface } from "./components/ui/dialog";
import { DrawingHost } from "./drawing/Drawing";
import {
	itemPath,
	openItem,
	spaceHref,
	useDesktop,
	useLocalStorage,
	useOnChange,
	useRepo,
	useRoute,
} from "./hooks";
import { useT } from "./i18n";
import { cn } from "./lib/utils";
import { globalPage } from "./scope";
import { AgentNotice } from "./ui/AgentNotice";
import { BrandLogo } from "./ui/BrandLogo";
import { CommandPalette } from "./ui/CommandPalette";
import { PageBoundary } from "./ui/ErrorBoundary";
import { ConfirmHost } from "./ui/feedback";
import { HistoryButtons } from "./ui/HistoryButtons";
import { ICON } from "./ui/icons";
import { setShelfPinned, syncShelf, useInboxItems, useShelf } from "./ui/inbox";
import { LightboxHost } from "./ui/Lightbox";
import { Button, IconButton, PagePlaceholder } from "./ui/primitives";
import { Sidebar, SpaceTree } from "./ui/Sidebar";
import { NewSpaceDialog, SpaceScope, SpaceSelector, useReplicas } from "./ui/Spaces";
import { StatusButton } from "./ui/StatusButton";
import { openSettings } from "./ui/settings-open";
import { KEYS } from "./ui/storage";
import { TitleTips } from "./ui/TitleTips";
import { Tray } from "./ui/Tray";
import { AppToaster } from "./ui/toasts";
import { Gate } from "./views/Account";
import { Activity } from "./views/Activity";
import { GraphView } from "./views/Graph";
import { ItemPage } from "./views/ItemPage";
import { FilesPage } from "./views/Lists";
import { SettingsHost, SettingsRedirect, SpaceSettingsRedirect } from "./views/Settings";
import { Today } from "./views/Today";
import { TrashView } from "./views/Trash";
import { TypeEditorHost } from "./views/TypePage";
import { NewTypeHost } from "./views/Types";

export function App() {
	// ConfirmHost sits outside Gate: the sync may ask before the app has loaded
	return (
		<>
			<Gate>
				<Main />
			</Gate>
			<ConfirmHost />
			<AppToaster />
			<TitleTips />
		</>
	);
}

function SignedOut() {
	const { t } = useT();
	const { account } = useAccounts();
	if (!account?.lost) return null;
	return (
		<StatusBanner action={{ label: t("account.signInAgain"), run: () => void signOut() }}>
			{t("account.lost", { server: location.host })}
		</StatusBanner>
	);
}

/** A newer app version wrote data in a workspace; this one stays read-only until reloaded. */
function TooNew() {
	const { t } = useT();
	const { spaces } = useAccounts();
	if (!useReplicas(spaces.map((s) => s.id)).some((r) => r.readOnly)) return null;
	return (
		<StatusBanner action={{ label: t("format.reload"), run: () => location.reload() }}>
			{t("format.tooNew")}
		</StatusBanner>
	);
}

function StatusBanner({
	children,
	action,
}: {
	children: React.ReactNode;
	action: { label: string; run: () => void };
}) {
	return (
		<div
			className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-2 px-4 py-2 text-sm"
			role="status"
		>
			<span className="flex-1">{children}</span>
			<Button
				className="font-medium text-link hover:underline"
				onClick={action.run}
				variant="plain"
			>
				{action.label}
			</Button>
		</div>
	);
}

function Main() {
	const repo = useRepo();
	const { active, spaces } = useAccounts();
	const { t } = useT();
	const route = useRoute();
	const wide = useDesktop();
	const [palette, setPalette] = useState<string | null>(null); // the query it opens with; null: closed
	const [menu, setMenu] = useState(false);
	const [sidebar, setSidebar] = useLocalStorage(KEYS.sidebarOpen, true);
	useOnChange(route.path, () => setMenu(false));
	// leaving the page closes the tray's panel, except for "#/inbox" and pages it was open at
	useOnChange(route.path, syncShelf);
	useEffect(() => {
		const on = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			// a field may have used it already (⌘K on selected text makes a link)
			if (e.defaultPrevented) return;
			if (mod && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setPalette((p) => (p === null ? "" : null));
			}
		};
		const showPalette = (e: Event) =>
			setPalette((e as CustomEvent<string | undefined>).detail ?? "");
		window.addEventListener("keydown", on);
		window.addEventListener("obtion:palette", showPalette);
		return () => {
			window.removeEventListener("keydown", on);
			window.removeEventListener("obtion:palette", showPalette);
		};
	}, []);

	// "#/create?title=…": links to items that don't exist yet
	useOnChange(route.path, () => {
		if (route.parts[0] !== "create") return;
		const title = route.query.get("title") ?? "";
		const existing = title ? repo.resolveTitle(title) : undefined;
		if (existing) openItem(existing, { replace: true });
		else {
			const id = repo.create({ title });
			openItem(id, { replace: true, query: "?new=1" });
		}
	});

	// workspace pages wait until it is set up; global pages show whatever every workspace has
	const settings = repo.get(SETTINGS_ID);
	const global = globalPage(route.parts, route.space);
	const page = (() => {
		// don't fall back to the open workspace when the address names one the account isn't in
		if (route.space && !spaces.some((s) => s.id === route.space))
			return <PagePlaceholder>{t("app.noSpace")}</PagePlaceholder>;
		if (!global) {
			if (!repo.status.loaded) return <PagePlaceholder fill>{t("app.opening")}</PagePlaceholder>;
			if (!settings) return <PagePlaceholder fill>{t("app.syncing")}</PagePlaceholder>;
		}
		switch (route.parts[0]) {
			case undefined:
			case "inbox":
			case "review":
				// "#/inbox": Heute, with the tray's panel open (above); "#/review": with it open to sort
				return <Today />;
			case "files":
				return <FilesPage />;
			case "graph":
				return <GraphView />;
			case "activity":
				return <Activity />;
			case "trash":
				return <TrashView />;
			case "settings":
				return global || !route.space ? (
					<SettingsRedirect />
				) : (
					<SpaceSettingsRedirect space={route.space} />
				);
			case "i":
				return <ItemPage id={route.parts[1]!} isNew={route.query.get("new") === "1"} />;
			default:
				return <div className="p-8 text-muted-foreground">{t("app.notFound")}</div>;
		}
	})();
	const isGraph = route.parts[0] === "graph";
	const tray = !!settings;
	const column = useRef<HTMLDivElement>(null);
	const main = useRef<HTMLElement>(null);
	const pinned = useRoom(
		tray &&
			wide &&
			(route.parts[0] === undefined || route.parts[0] === "inbox" || route.parts[0] === "review"),
		column,
		main,
		route.path,
	);
	useEffect(() => void setShelfPinned(pinned), [pinned]);

	return (
		<div className="flex h-full">
			<Button
				className="sr-only z-50 rounded-lg border border-line bg-surface text-sm shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:px-3 focus:py-2"
				onClick={() => document.querySelector("main")?.focus()}
				variant="plain"
			>
				{t("nav.skip")}
			</Button>
			{wide && sidebar && <Sidebar onSearch={() => setPalette("")} />}

			<div className="flex min-w-0 flex-1 flex-col" data-column ref={column}>
				{!wide && (
					// iOS 26 blurs the top edge of an installed app unless a sticky, opaque, full-width box covers it
					<header className="sticky top-0 flex items-center gap-2 border-b border-line bg-bg px-3 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
						{/* only back: the bar has no room for both, and a phone has no toolbar for it */}
						<HistoryButtons />
						<a
							aria-label={t("nav.today")}
							className="tap flex items-center justify-center gap-2"
							href="#/"
						>
							<BrandLogo alt="" className="size-6" />
						</a>
						<StatusButton />
						<Button
							className="tap-row ml-1 flex flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-muted-foreground"
							onClick={() => setPalette("")}
							variant="plain"
						>
							<Search size={15} /> {t("nav.searchPlaceholder")}
						</Button>
						<Button
							aria-label={t("nav.menu")}
							className="tap p-1.5 text-muted-foreground"
							onClick={() => setMenu(true)}
							variant="plain"
						>
							<Menu size={20} />
						</Button>
					</header>
				)}
				<SignedOut />
				<TooNew />
				{/* a row of their own above the page, where a browser has its arrows: pages fill their
            width, so there is no free corner to put them in. The sidebar's button is here, not in
            the sidebar, so it stays where it is when the sidebar is closed */}
				{wide && (
					<div className="flex shrink-0 px-2 pt-2">
						<IconButton
							aria-expanded={sidebar}
							icon={sidebar ? PanelLeftClose : PanelLeftOpen}
							label={t(sidebar ? "nav.hideSidebar" : "nav.showSidebar")}
							onClick={() => setSidebar(!sidebar)}
						/>
						<HistoryButtons forward />
					</div>
				)}
				{/* pinned: main is only as tall as Today, the panel takes the rest */}
				<main
					className={cn(
						"@container min-h-0 outline-none",
						pinned ? "flex-initial" : "flex-1",
						isGraph ? "overflow-hidden" : "overflow-y-auto",
						tray && wide && !pinned && !isGraph && "pb-24",
					)}
					ref={main}
					tabIndex={-1}
				>
					{/* keyed by workspace so a switch remounts the page on the other replica */}
					<PageBoundary
						key={`${global ? "" : active?.id}${route.path === "/inbox" || route.path === "/review" ? "/" : route.path}`}
					>
						{page}
					</PageBoundary>
				</main>
				{tray && <Tray desktop={wide} pinned={pinned} />}
				{!wide && <MobileNav />}
			</div>

			{palette !== null && <CommandPalette onClose={() => setPalette(null)} query={palette} />}
			{menu && (
				<Backdrop
					onClick={(e) => {
						// only a click beside the menu closes it
						if (e.target === e.currentTarget) setMenu(false);
					}}
				>
					<MenuSheet onClose={() => setMenu(false)}>
						<div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line" />
						<MobileMenu
							onSettings={() => {
								setMenu(false);
								openSettings();
							}}
						/>
					</MenuSheet>
				</Backdrop>
			)}
			<SettingsHost />
			<NewTypeHost />
			<TypeEditorHost />
			<AgentNotice />
			<LightboxHost />
			<DrawingHost />
		</div>
	);
}

const TRAY_BAR_PX = 88;
/** Room for two entries; with less, pinning would not gain anything over the cards. */
const MIN_PANEL_PX = 220;

/**
 * Whether the tray's panel fits below the page. Unpinned, Today shows the newest entries instead
 * (data-shelf-cards); they don't count, or the panel would never come back.
 */
function useRoom(
	on: boolean,
	column: React.RefObject<HTMLDivElement | null>,
	main: React.RefObject<HTMLElement | null>,
	path: string,
) {
	const [room, setRoom] = useState(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new `path` renders a new page element to observe
	useLayoutEffect(() => {
		const page = main.current?.firstElementChild as HTMLElement | null | undefined;
		if (!on || !column.current || !page) return;
		const measure = () => {
			const cards = page.querySelector<HTMLElement>("[data-shelf-cards]");
			const height =
				page.offsetHeight -
				(cards ? cards.offsetHeight + Number.parseFloat(getComputedStyle(cards).marginTop) : 0);
			// what stands above the page in the column (the history buttons, a banner) takes room too
			const above = main.current!.offsetTop - column.current!.offsetTop;
			setRoom(column.current!.clientHeight - above - height - TRAY_BAR_PX >= MIN_PANEL_PX);
		};
		const ro = new ResizeObserver(measure);
		ro.observe(column.current);
		ro.observe(page);
		return () => ro.disconnect();
	}, [on, column, main, path]);
	return on && room;
}

function MenuSheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
	const { t } = useT();
	return (
		<ModalSurface onClose={onClose} title={t("nav.menu")}>
			<nav
				aria-label={t("nav.menu")}
				aria-modal="true"
				className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface p-3 pb-safe shadow-2xl"
				role="dialog"
			>
				<IconButton
					className="float-right -mr-1 -mt-1"
					icon={X}
					label={t("close")}
					onClick={onClose}
				/>
				{children}
			</nav>
		</ModalSurface>
	);
}

function MobileMenu({ onSettings }: { onSettings: () => void }) {
	const { t } = useT();
	const { shown } = useAccounts();
	const [creating, setCreating] = useState(false);
	const row = "flex min-h-11 items-center gap-3 rounded-lg px-3 text-[15px] hover:bg-hover";
	const inbox = useInboxItems().length;
	return (
		<>
			<div className="mb-2 flex px-0.5">
				<SpaceSelector className="flex-1" onNew={() => setCreating(true)} />
			</div>
			{creating && <NewSpaceDialog onClose={() => setCreating(false)} />}
			<a className={row} href="#/">
				<Sun className="text-muted-foreground" size={18} /> {t("nav.today")}
			</a>
			<a className={row} href="#/inbox">
				<Inbox className="text-muted-foreground" size={18} />{" "}
				<span className="flex-1">{t("nav.inbox")}</span>
				{inbox > 0 && <span className="text-xs tabular-nums text-muted-foreground">{inbox}</span>}
			</a>
			{shown.map((s) => (
				<SpaceScope id={s.id} key={s.id}>
					<div className="mx-3 mt-3 border-t border-line" />
					<SpaceTree space={s} touch />
				</SpaceScope>
			))}
			<div className="my-2 border-t border-line" />
			<a className={row} href="#/activity">
				<History className="text-muted-foreground" size={18} /> {t("nav.activity")}
			</a>
			<a className={row} href="#/trash">
				<Trash2 className="text-muted-foreground" size={18} /> {t("nav.trash")}
			</a>
			<Button className={cn(row, "w-full text-left")} onClick={onSettings} variant="plain">
				<SlidersHorizontal className="text-muted-foreground" size={18} /> {t("nav.settings")}
			</Button>
		</>
	);
}

/** Where old addresses lead now. Remove once no saved link or bookmark uses them. */
/** With exactly one workspace shown, its first two types join the bar; with several they stay in the menu. */
function MobileNav() {
	const { t } = useT();
	const { shown, active } = useAccounts();
	const one = shown.length === 1 ? shown[0]! : undefined;
	const [oneRepo] = useReplicas(one ? [one.id] : []);
	const route = useRoute();
	const ix = oneRepo?.index();
	const inbox = useInboxItems().length;
	const shelf = useShelf().open;
	const entries: {
		key: string;
		label: string;
		icon: React.ReactNode;
		href: string;
		active?: boolean;
		dot?: boolean;
	}[] = [
		{
			key: "today",
			label: t("nav.today"),
			icon: <Sun size={20} />,
			href: "#/",
			active: route.path === "/" && !shelf,
		},
		{
			key: "inbox",
			label: t("nav.inbox"),
			icon: <Inbox size={20} />,
			href: "#/inbox",
			active: shelf,
			dot: inbox > 0,
		},
		...(ix
			? ix
					.typesInOrder()
					.slice(0, 2)
					.map((type) => {
						const Icon = ICON[type.schema.icon] ?? ICON.circle!;
						return {
							key: type.id,
							label: ix.typePlural(type.id),
							icon: <Icon size={20} />,
							href: spaceHref(one!.id, itemPath(type.id)),
							active:
								active?.id === one!.id && route.parts[0] === "i" && route.parts[1] === type.id,
						};
					})
			: []),
	];
	return (
		<nav
			aria-label={t("nav.main")}
			className="grid border-t border-line bg-surface pb-safe"
			style={{ gridTemplateColumns: `repeat(${entries.length}, minmax(0, 1fr))` }}
		>
			{entries.map((e) => (
				<a
					className={cn(
						"relative flex flex-col items-center gap-0.5 py-2 text-[11px]",
						e.active ? "text-fg" : "text-muted-foreground",
					)}
					href={e.href}
					key={e.key}
				>
					{e.icon}
					<span className="max-w-full truncate px-1">{e.label}</span>
					{e.dot && (
						<span
							className="absolute right-[22%] top-1 size-1.5 rounded-full"
							style={{ background: "var(--t-inbox)" }}
						/>
					)}
				</a>
			))}
		</nav>
	);
}
