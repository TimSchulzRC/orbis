import { ModalSurface } from "./components/ui/dialog";
import { Button as ShadcnButton } from "./components/ui/button";
import { BrandLogo } from "./ui/BrandLogo";
import { useEffect, useRef, useState } from "react";
import { Plus, Menu, Search, Inbox, SlidersHorizontal, X } from "lucide-react";
import { SETTINGS_ID } from "@obtion/core/model";
import { useRepo, useRoute, useMediaQuery, itemHref, spaceHref } from "./hooks";
import { useT } from "./i18n";
import { cx, IconButton } from "./ui/bits";
import { AgentNotice } from "./ui/AgentNotice";
import { ConfirmHost } from "./ui/feedback";
import { AppToaster } from "./ui/toasts";
import { LightboxHost } from "./ui/Lightbox";
import { InboxEntry } from "./ui/Triage";
import { PageBoundary } from "./ui/ErrorBoundary";
import { Sidebar, SpaceTree, useInboxTotal } from "./ui/Sidebar";
import { SyncDot } from "./ui/SyncDot";
import { CommandPalette } from "./ui/CommandPalette";
import { CaptureSheet } from "./ui/Capture";
import { Setup } from "./views/Setup";
import { ItemPage } from "./views/ItemPage";
import { SearchView } from "./views/Search";
import { FilesPage, InboxPage } from "./views/Lists";
import { TypesView } from "./views/Types";
import { GraphView } from "./views/Graph";
import { Activity } from "./views/Activity";
import { TrashView } from "./views/Trash";
import { Settings, SpaceSettingsPage } from "./views/Settings";
import { ICON } from "./ui/icons";
import { NewSpaceDialog, SpaceScope, SpaceSelector, useReplicas } from "./ui/Spaces";
import { globalPage } from "./scope";
import { Gate } from "./views/Account";
import { signOut, useAccounts } from "./accounts";

export function App() {
  // the confirm dialog lives above everything: the sync may ask before the app has loaded
  return (
    <>
      <Gate>
        <Main />
      </Gate>
      <ConfirmHost />
      <AppToaster />
    </>
  );
}

/** The server no longer takes the account's token: sign in again. */
function SignedOut() {
  const { t } = useT();
  const { account } = useAccounts();
  if (!account?.lost) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-2 px-4 py-2 text-sm" role="status">
      <span className="flex-1">{t("account.lost", { server: location.host })}</span>
      <ShadcnButton variant="plain" size="none" onClick={() => void signOut()} className="font-medium text-[var(--link)] hover:underline">
        {t("account.signInAgain")}
      </ShadcnButton>
    </div>
  );
}

/** A newer app wrote data in one of the workspaces: this one only reads them until reloaded. */
function TooNew() {
  const { t } = useT();
  const { spaces } = useAccounts();
  if (!useReplicas(spaces.map((s) => s.id)).some((r) => r.readOnly)) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-2 px-4 py-2 text-sm" role="status">
      <span className="flex-1">{t("format.tooNew")}</span>
      <ShadcnButton variant="plain" size="none" onClick={() => location.reload()} className="font-medium text-[var(--link)] hover:underline">
        {t("format.reload")}
      </ShadcnButton>
    </div>
  );
}

function Main() {
  const r = useRepo();
  const { active, spaces } = useAccounts();
  const { t } = useT();
  const route = useRoute();
  const wide = useMediaQuery("(min-width: 1024px)");
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  useEffect(() => setMenu(false), [route.path]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
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
  });

  // nothing set up in any workspace yet (a new account): the first one's setup
  const all = useReplicas(spaces.map((s) => s.id));
  const nothing = all.length > 0 && all.every((x) => !x.get(SETTINGS_ID) && x.status.loaded && (x.status.synced || (!x.status.online && x.docs.size === 0)));
  useEffect(() => void (nothing && globalPage(route.parts) && location.replace(spaceHref(spaces[0]!.id, "/setup"))), [nothing, route.path]);

  // "#/create?title=…" – links to items that don't exist yet.
  useEffect(() => {
    if (route.parts[0] !== "create") return;
    const title = route.query.get("title") ?? "";
    const existing = title ? r.resolveTitle(title) : undefined;
    if (existing) location.replace(itemHref(existing));
    else {
      const id = r.create({ title });
      location.replace(`${itemHref(id)}?new=1`);
    }
  }, [route.path]);

  // a page of a workspace waits for it and is its setup until it is set up; the inbox,
  // search and the settings show what is there in every workspace
  const settings = r.get(SETTINGS_ID);
  const setUp = !settings && (r.status.synced || (!r.status.online && r.docs.size === 0));
  const page = (() => {
    if (!globalPage(route.parts) || route.parts[0] === "setup") {
      if (!r.status.loaded) return <div className="flex h-full items-center justify-center text-muted-foreground">{t("app.opening")}</div>;
      if (setUp) return <Setup />;
      if (!settings) return <div className="flex h-full items-center justify-center text-muted-foreground">{t("app.syncing")}</div>;
    }
    switch (route.parts[0]) {
      case undefined:
        // no start page for now: the app begins at the inbox
        return <Redirect to="/inbox" />;
      case "inbox":
        return route.parts[1] ? <InboxEntry id={route.parts[1]} /> : <InboxPage />;
      case "search":
        return <SearchView />;
      case "files":
        return <FilesPage />;
      case "c":
        // links from before 26.10., when the lists were collections
        return <Redirect to={OLD_LISTS[route.parts[1]!] ?? "/"} />;
      case "types":
        return <TypesView />;
      case "graph":
        return <GraphView />;
      case "activity":
        return <Activity />;
      case "trash":
        return <TrashView />;
      case "settings":
        return <Settings />;
      case "workspace":
        return <SpaceSettingsPage />;
      case "setup":
        return <Redirect to="/" />;
      case "i":
        return <ItemPage id={route.parts[1]!} isNew={route.query.get("new") === "1"} />;
      default:
        return <div className="p-8 text-muted-foreground">{t("app.notFound")}</div>;
    }
  })();
  const isGraph = route.parts[0] === "graph";

  return (
    <div className="flex h-full">
      <ShadcnButton variant="plain" size="none"
        onClick={() => document.querySelector("main")?.focus()}
        className="sr-only z-50 rounded-lg border border-line bg-surface text-sm shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:px-3 focus:py-2"
      >
        {t("nav.skip")}
      </ShadcnButton>
      {wide && <Sidebar onSearch={() => setPalette(true)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        {!wide && (
          <header className="flex items-center gap-2 border-b border-line bg-bg/90 px-3 py-2 backdrop-blur pt-safe">
            <a href="#/inbox" className="tap flex items-center justify-center gap-2" aria-label={t("nav.inbox")}>
              <BrandLogo alt="" className="size-6" />
            </a>
            <SyncDot />
            <ShadcnButton variant="plain" size="none" onClick={() => setPalette(true)} className="tap-row ml-1 flex flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-muted-foreground">
              <Search size={15} /> {t("nav.searchPlaceholder")}
            </ShadcnButton>
            <ShadcnButton variant="plain" size="none" onClick={() => setMenu(true)} className="tap p-1.5 text-muted-foreground" aria-label={t("nav.menu")}>
              <Menu size={20} />
            </ShadcnButton>
          </header>
        )}
        <SignedOut />
        <TooNew />
        <main tabIndex={-1} className={cx("@container min-h-0 flex-1 outline-none", isGraph ? "overflow-hidden" : "overflow-y-auto")}>
          {/* a page of another workspace: anew on its replica (repo and files point at it) */}
          <PageBoundary key={`${globalPage(route.parts) ? "" : active?.id}${route.path}`}>{page}</PageBoundary>
        </main>
        {/* an inbox entry on a phone has its actions at the bottom instead */}
        {!wide && !(route.parts[0] === "inbox" && route.parts[1]) && <MobileNav />}
      </div>

      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {menu && (
        <div className="fixed inset-0 z-50 bg-black/30" onClick={() => setMenu(false)}>
          <MenuSheet onClose={() => setMenu(false)}>
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line" />
            <MobileMenu />
          </MenuSheet>
        </div>
      )}
      {!wide && route.parts[0] !== "i" && !(route.parts[0] === "inbox" && route.parts[1]) && (
        <ShadcnButton variant="plain" size="none"
          onClick={() => setCaptureOpen(true)}
          aria-label={t("capture.title")}
          className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-20 flex size-12 items-center justify-center rounded-full bg-ink text-ink-text shadow-lg"
        >
          <Plus size={22} />
        </ShadcnButton>
      )}
      {captureOpen && <CaptureSheet onClose={() => setCaptureOpen(false)} />}
      <AgentNotice />
      <LightboxHost />
    </div>
  );
}

/** The phone menu as a sheet from below: a modal surface (focus stays in, Escape closes). */
function MenuSheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const { t } = useT();
  const ref = useRef<HTMLElement>(null);
  return (
    <ModalSurface title={t("nav.menu")} onClose={onClose}><nav ref={ref} role="dialog" aria-modal="true" className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface p-3 pb-safe shadow-2xl" aria-label={t("nav.menu")} onClick={(e) => e.stopPropagation()}>
      <IconButton onClick={onClose} label={t("close")} icon={X} className="float-right -mr-1 -mt-1" />
      {children}
    </nav></ModalSurface>
  );
}

/** The phone menu (a sheet from below): the selector, Eingang · the workspaces seen (as in the sidebar) · Einstellungen. */
function MobileMenu() {
  const { t } = useT();
  const { shown } = useAccounts();
  const [creating, setCreating] = useState(false);
  const row = "flex min-h-11 items-center gap-3 rounded-lg px-3 text-[15px] hover:bg-hover";
  const inbox = useInboxTotal();
  return (
    <>
      <div className="mb-2 flex px-3">
        <SpaceSelector className="flex-1" onNew={() => setCreating(true)} />
      </div>
      {creating && <NewSpaceDialog onClose={() => setCreating(false)} />}
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
      <a href="#/settings" className={row}>
        <SlidersHorizontal size={18} className="text-muted-foreground" /> {t("nav.settings")}
      </a>
    </>
  );
}

const OLD_LISTS: Record<string, string> = { "sys:c-project": "/i/sys%3Aproject", "sys:c-task": "/i/sys%3Atask", "sys:c-card": "/i/sys%3Acard", "sys:c-files": "/files", "sys:c-images": "/files?kind=bild", "sys:inbox": "/inbox" };

function Redirect({ to }: { to: string }) {
  useEffect(() => location.replace("#" + to), [to]);
  return null;
}

/**
 * Bottom bar on phones: Eingang – with one workspace seen also its first two types
 * of the sidebar (Projekte, Tasks); with several they are in the menu, each in its workspace.
 */
function MobileNav() {
  const { t } = useT();
  const { shown, active } = useAccounts();
  const one = shown.length === 1 ? shown[0]! : undefined;
  const [r] = useReplicas(one ? [one.id] : []);
  const route = useRoute();
  const ix = r?.index();
  const inbox = useInboxTotal();
  const entries = [
    { key: "inbox", label: t("nav.inbox"), icon: <Inbox size={20} />, href: "#/inbox", active: route.path.startsWith("/inbox"), dot: inbox > 0 },
    ...(ix
      ? ix.typesInOrder().slice(0, 2).map((x) => {
          const I = ICON[x.schema!.icon] ?? ICON.circle!;
          return { key: x.id, label: ix.typePlural(x.id), icon: <I size={20} />, href: spaceHref(one!.id, `/i/${encodeURIComponent(x.id)}`), active: active?.id === one!.id && route.parts[0] === "i" && route.parts[1] === x.id };
        })
      : []),
  ] as { key: string; label: string; icon: React.ReactNode; href?: string; onClick?: () => void; active?: boolean; dot?: boolean }[];
  return (
    <nav className="grid border-t border-line bg-surface pb-safe" style={{ gridTemplateColumns: `repeat(${entries.length}, minmax(0, 1fr))` }} aria-label={t("nav.main")}>
      {entries.map((e) => {
        const cls = cx("relative flex flex-col items-center gap-0.5 py-2 text-[11px]", e.active ? "text-fg" : "text-muted-foreground");
        const inner = (
          <>
            {e.icon}
            <span className="max-w-full truncate px-1">{e.label}</span>
            {e.dot && <span className="absolute right-[22%] top-1 size-1.5 rounded-full" style={{ background: "var(--t-inbox)" }} />}
          </>
        );
        return e.href ? (
          <a key={e.key} href={e.href} className={cls}>
            {inner}
          </a>
        ) : (
          <ShadcnButton variant="plain" size="none" key={e.key} onClick={e.onClick} className={cls}>
            {inner}
          </ShadcnButton>
        );
      })}
    </nav>
  );
}
