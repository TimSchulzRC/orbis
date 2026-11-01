import { Backdrop, ModalSurface } from "./components/ui/dialog";
import { BrandLogo } from "./ui/BrandLogo";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { History, Menu, Search, Inbox, SlidersHorizontal, Sun, Trash2, X } from "lucide-react";
import { SETTINGS_ID } from "@obtion/core/model";
import { useRepo, useRoute, useDesktop, itemPath, spaceHref, navigate, openItem } from "./hooks";
import { useT } from "./i18n";
import { cn } from "./lib/utils";
import { Button, IconButton, PagePlaceholder } from "./ui/primitives";
import { AgentNotice } from "./ui/AgentNotice";
import { ConfirmHost } from "./ui/feedback";
import { AppToaster } from "./ui/toasts";
import { TitleTips } from "./ui/TitleTips";
import { LightboxHost } from "./ui/Lightbox";
import { PageBoundary } from "./ui/ErrorBoundary";
import { Sidebar, SpaceTree } from "./ui/Sidebar";
import { StatusButton } from "./ui/StatusButton";
import { CommandPalette } from "./ui/CommandPalette";
import { CaptureSheet } from "./ui/Capture";
import { ItemPage } from "./views/ItemPage";
import { SearchView } from "./views/Search";
import { FilesPage } from "./views/Lists";
import { Review } from "./views/Review";
import { Today } from "./views/Today";
import { Tray } from "./ui/Tray";
import { entryKey, setShelfPinned, syncShelf, useInboxItems, useShelf } from "./ui/inbox";
import { TypesView } from "./views/Types";
import { GraphView } from "./views/Graph";
import { Activity } from "./views/Activity";
import { TrashView } from "./views/Trash";
import { SettingsHost, SettingsRedirect, SpaceSettingsPage } from "./views/Settings";
import { ICON } from "./ui/icons";
import { NewSpaceDialog, SpaceScope, SpaceSelector, useReplicas } from "./ui/Spaces";
import { globalPage } from "./scope";
import { Gate } from "./views/Account";
import { activeSpace, signOut, useAccounts } from "./accounts";
import { openSettings } from "./ui/settings-open";

export function App() {
  // the confirm dialog lives above everything: the sync may ask before the app has loaded
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

/** The server no longer takes the account's token: sign in again. */
function SignedOut() {
  const { t } = useT();
  const { account } = useAccounts();
  if (!account?.lost) return null;
  return <StatusBanner action={{ label: t("account.signInAgain"), run: () => void signOut() }}>{t("account.lost", { server: location.host })}</StatusBanner>;
}

/** A newer app wrote data in one of the workspaces: this one only reads them until reloaded. */
function TooNew() {
  const { t } = useT();
  const { spaces } = useAccounts();
  if (!useReplicas(spaces.map((s) => s.id)).some((r) => r.readOnly)) return null;
  return <StatusBanner action={{ label: t("format.reload"), run: () => location.reload() }}>{t("format.tooNew")}</StatusBanner>;
}

/** A line across the top about the whole app, with the one thing to do about it. */
function StatusBanner({ children, action }: { children: React.ReactNode; action: { label: string; run: () => void } }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-2 px-4 py-2 text-sm" role="status">
      <span className="flex-1">{children}</span>
      <Button variant="plain" onClick={action.run} className="font-medium text-link hover:underline">
        {action.label}
      </Button>
    </div>
  );
}

function Main() {
  const r = useRepo();
  const { active, spaces } = useAccounts();
  const { t } = useT();
  const route = useRoute();
  const wide = useDesktop();
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  useEffect(() => setMenu(false), [route.path]);
  // another page closes the tray's panel – but "#/inbox" (Heute with it open) and a step it was open at
  useEffect(syncShelf, [route.path]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // taken by a field already (⌘K on selected text links it)
      if (e.defaultPrevented) return;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    const showPalette = () => setPalette(true);
    window.addEventListener("keydown", on);
    window.addEventListener("obtion:palette", showPalette);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("obtion:palette", showPalette);
    };
  }, []);

  // "#/create?title=…" – links to items that don't exist yet.
  useEffect(() => {
    if (route.parts[0] !== "create") return;
    const title = route.query.get("title") ?? "";
    const existing = title ? r.resolveTitle(title) : undefined;
    if (existing) openItem(existing, { replace: true });
    else {
      const id = r.create({ title });
      openItem(id, { replace: true, query: "?new=1" });
    }
  }, [route.path]);

  // a page of a workspace waits until it is set up (accounts.ts does that); Heute, the inbox,
  // the review, search and the settings show what is there in every workspace
  const settings = r.get(SETTINGS_ID);
  const global = globalPage(route.parts, route.space);
  const old = oldAddress(route.parts, route.space);
  const page = (() => {
    if (old !== undefined) return <Redirect to={old.startsWith("/review") || old === "/activity" || old === "/trash" ? old : spaceHref(route.space ?? active?.id, old).slice(1)} />;
    // a workspace in the address this account is not in (any more): not the open one's page instead
    if (route.space && !spaces.some((s) => s.id === route.space)) return <PagePlaceholder>{t("app.noSpace")}</PagePlaceholder>;
    if (!global) {
      if (!r.status.loaded) return <PagePlaceholder fill>{t("app.opening")}</PagePlaceholder>;
      if (!settings) return <PagePlaceholder fill>{t("app.syncing")}</PagePlaceholder>;
    }
    switch (route.parts[0]) {
      case undefined:
      case "inbox":
        // "#/inbox": Heute, with the tray's panel open (above)
        return <Today />;
      case "review":
        return <Review at={route.query.get("at") ?? undefined} />;
      case "search":
        return <SearchView />;
      case "files":
        return <FilesPage />;
      case "types":
        return <TypesView />;
      case "graph":
        return <GraphView />;
      case "activity":
        return <Activity />;
      case "trash":
        return <TrashView />;
      case "settings":
        return global ? <SettingsRedirect /> : <SpaceSettingsPage />;
      // the setup page of before (a workspace is set up as it is created)
      case "setup":
        return <Redirect to="/" />;
      case "i":
        return <ItemPage id={route.parts[1]!} isNew={route.query.get("new") === "1"} />;
      default:
        return <div className="p-8 text-muted-foreground">{t("app.notFound")}</div>;
    }
  })();
  const isGraph = route.parts[0] === "graph";
  // the tray is below every page but the review (it leads there); on Heute on a desktop with its panel open, as part of the
  // page – if it fits below it, else Heute shows the newest entries and the panel opens over the page as elsewhere
  const tray = !!settings && route.parts[0] !== "review" && !(route.parts[0] === "inbox" && route.parts[1]);
  const column = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  const pinned = useRoom(tray && wide && (route.parts[0] === undefined || route.parts[0] === "inbox"), column, main, route.path);
  useEffect(() => void setShelfPinned(pinned), [pinned]);

  return (
    <div className="flex h-full">
      <Button variant="plain"
        onClick={() => document.querySelector("main")?.focus()}
        className="sr-only z-50 rounded-lg border border-line bg-surface text-sm shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:px-3 focus:py-2"
      >
        {t("nav.skip")}
      </Button>
      {wide && <Sidebar onSearch={() => setPalette(true)} />}

      <div ref={column} className="flex min-w-0 flex-1 flex-col">
        {!wide && (
          <header className="flex items-center gap-2 border-b border-line bg-bg/90 px-3 py-2 backdrop-blur pt-safe">
            <a href="#/" className="tap flex items-center justify-center gap-2" aria-label={t("nav.today")}>
              <BrandLogo alt="" className="size-6" />
            </a>
            <StatusButton />
            <Button variant="plain" onClick={() => setPalette(true)} className="tap-row ml-1 flex flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-muted-foreground">
              <Search size={15} /> {t("nav.searchPlaceholder")}
            </Button>
            <Button variant="plain" onClick={() => setMenu(true)} className="tap p-1.5 text-muted-foreground" aria-label={t("nav.menu")}>
              <Menu size={20} />
            </Button>
          </header>
        )}
        <SignedOut />
        <TooNew />
        {/* with the panel pinned below: as tall as Heute is, the panel takes the rest */}
        <main ref={main} tabIndex={-1} className={cn("@container min-h-0 outline-none", pinned ? "flex-initial" : "flex-1", isGraph ? "overflow-hidden" : "overflow-y-auto")}>
          {/* a page of another workspace: anew on its replica (repo and files point at it) */}
          <PageBoundary key={`${global ? "" : active?.id}${route.path === "/inbox" ? "/" : route.path}`}>{page}</PageBoundary>
        </main>
        {tray && <Tray desktop={wide} pinned={pinned} onCapture={() => setCaptureOpen(true)} />}
        {/* the review on a phone is a page of its own, with its own way back */}
        {!wide && route.parts[0] !== "review" && <MobileNav />}
      </div>

      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {menu && (
        <Backdrop onClick={() => setMenu(false)}>
          <MenuSheet onClose={() => setMenu(false)}>
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line" />
            <MobileMenu onSettings={() => (setMenu(false), openSettings())} />
          </MenuSheet>
        </Backdrop>
      )}
      {captureOpen && <CaptureSheet onClose={() => setCaptureOpen(false)} />}
      <SettingsHost />
      <AgentNotice />
      <LightboxHost />
    </div>
  );
}

/**
 * Room for the tray's panel below the page (Heute, `on`): at least 220 px under it besides the bar (two entries;
 * less and the cards above take no more room than it would), measured as it
 * changes. Heute without it shows the newest entries instead (data-shelf-cards): they don't count, else it never comes back.
 */
function useRoom(on: boolean, column: React.RefObject<HTMLDivElement | null>, main: React.RefObject<HTMLElement | null>, path: string) {
  const [room, setRoom] = useState(true);
  useLayoutEffect(() => {
    const page = main.current?.firstElementChild as HTMLElement | null | undefined;
    if (!on || !column.current || !page) return;
    const measure = () => {
      const cards = page.querySelector<HTMLElement>("[data-shelf-cards]");
      const height = page.offsetHeight - (cards ? cards.offsetHeight + parseFloat(getComputedStyle(cards).marginTop) : 0);
      setRoom(column.current!.clientHeight - height - 88 >= 220);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(column.current);
    ro.observe(page);
    return () => ro.disconnect();
  }, [on, path]);
  return on && room;
}

/** The phone menu as a sheet from below: a modal surface (focus stays in, Escape closes). */
function MenuSheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const { t } = useT();
  return (
    <ModalSurface title={t("nav.menu")} onClose={onClose}><nav role="dialog" aria-modal="true" className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface p-3 pb-safe shadow-2xl" aria-label={t("nav.menu")} onClick={(e) => e.stopPropagation()}>
      <IconButton onClick={onClose} label={t("close")} icon={X} className="float-right -mr-1 -mt-1" />
      {children}
    </nav></ModalSurface>
  );
}

/** The phone menu (a sheet from below): the selector, Heute and Eingang · the workspaces seen (as in the sidebar) · Aktivität, Papierkorb, Einstellungen. */
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
      <a href="#/" className={row}>
        <Sun size={18} className="text-muted-foreground" /> {t("nav.today")}
      </a>
      <a href="#/inbox" className={row}>
        <Inbox size={18} className="text-muted-foreground" /> <span className="flex-1">{t("nav.inbox")}</span>
        {inbox > 0 && <span className="text-xs tabular-nums text-muted-foreground">{inbox}</span>}
      </a>
      {shown.map((s) => (
        <SpaceScope key={s.id} id={s.id}>
          <div className="mx-3 mt-3 border-t border-line" />
          <SpaceTree space={s} touch />
        </SpaceScope>
      ))}
      <div className="my-2 border-t border-line" />
      <a href="#/activity" className={row}>
        <History size={18} className="text-muted-foreground" /> {t("nav.activity")}
      </a>
      <a href="#/trash" className={row}>
        <Trash2 size={18} className="text-muted-foreground" /> {t("nav.trash")}
      </a>
      <Button variant="plain" onClick={onSettings} className={cn(row, "w-full text-left")}>
        <SlidersHorizontal size={18} className="text-muted-foreground" /> {t("nav.settings")}
      </Button>
    </>
  );
}

/**
 * Addresses from before and where they lead now (a path in the workspace of the address), or
 * undefined for one of today. They can go once no saved link or bookmark uses them any more.
 */
function oldAddress(parts: string[], space?: string): string | undefined {
  // the lists as collections (before 26.10.)
  if (parts[0] === "c") return OLD_LISTS[parts[1]!] ?? "/";
  // an inbox entry's own page (before the review): the review, at that entry
  if (parts[0] === "inbox" && parts[1]) return `/review?at=${encodeURIComponent(entryKey(activeSpace()!.id, parts[1]))}`;
  // a workspace's settings (before 31.10.)
  if (parts[0] === "workspace") return "/settings";
  // a workspace's activity or trash (before 1.11.): now one page for the workspaces seen
  if ((parts[0] === "activity" || parts[0] === "trash") && space) return "/" + parts[0];
}

const OLD_LISTS: Record<string, string> = { "sys:c-project": "/i/sys:project", "sys:c-task": "/i/sys:task", "sys:c-card": "/i/sys:card", "sys:c-files": "/files", "sys:c-images": "/files?kind=image", "sys:inbox": "/inbox" };

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

/**
 * Bottom bar on phones: Heute, Eingang – with one workspace seen also its first two types
 * of the sidebar (Projekte, Tasks); with several they are in the menu, each in its workspace.
 */
function MobileNav() {
  const { t } = useT();
  const { shown, active } = useAccounts();
  const one = shown.length === 1 ? shown[0]! : undefined;
  const [r] = useReplicas(one ? [one.id] : []);
  const route = useRoute();
  const ix = r?.index();
  const inbox = useInboxItems().length;
  const shelf = useShelf().open;
  const entries: { key: string; label: string; icon: React.ReactNode; href: string; active?: boolean; dot?: boolean }[] = [
    { key: "today", label: t("nav.today"), icon: <Sun size={20} />, href: "#/", active: route.path === "/" && !shelf },
    { key: "inbox", label: t("nav.inbox"), icon: <Inbox size={20} />, href: "#/inbox", active: shelf || route.path === "/review", dot: inbox > 0 },
    ...(ix
      ? ix.typesInOrder().slice(0, 2).map((x) => {
          const I = ICON[x.schema.icon] ?? ICON.circle!;
          return { key: x.id, label: ix.typePlural(x.id), icon: <I size={20} />, href: spaceHref(one!.id, itemPath(x.id)), active: active?.id === one!.id && route.parts[0] === "i" && route.parts[1] === x.id };
        })
      : []),
  ];
  return (
    <nav className="grid border-t border-line bg-surface pb-safe" style={{ gridTemplateColumns: `repeat(${entries.length}, minmax(0, 1fr))` }} aria-label={t("nav.main")}>
      {entries.map((e) => {
        const cls = cn("relative flex flex-col items-center gap-0.5 py-2 text-[11px]", e.active ? "text-fg" : "text-muted-foreground");
        const inner = (
          <>
            {e.icon}
            <span className="max-w-full truncate px-1">{e.label}</span>
            {e.dot && <span className="absolute right-[22%] top-1 size-1.5 rounded-full" style={{ background: "var(--t-inbox)" }} />}
          </>
        );
        return (
          <a key={e.key} href={e.href} className={cls}>
            {inner}
          </a>
        );
      })}
    </nav>
  );
}
