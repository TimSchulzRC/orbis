import { useEffect, useRef, useState } from "react";
import { Sparkles, Plus, Menu, Search, LayoutDashboard, Inbox, SlidersHorizontal, X } from "lucide-react";
import { SETTINGS_ID } from "@obtion/core/model";
import { inboxWhere } from "@obtion/core/inbox";
import { runQuery } from "@obtion/core/query";
import { useRepo, useRoute, useMediaQuery, itemHref } from "./hooks";
import { useT } from "./i18n";
import { cx, IconButton, useModal } from "./ui/bits";
import { AgentNotice } from "./ui/AgentNotice";
import { ConfirmHost } from "./ui/feedback";
import { AppToaster } from "./ui/toasts";
import { LightboxHost } from "./ui/Lightbox";
import { InboxEntry } from "./ui/Triage";
import { PageBoundary } from "./ui/ErrorBoundary";
import { PinnedTree, Sidebar, TypeNav } from "./ui/Sidebar";
import { SyncDot } from "./ui/SyncDot";
import { CommandPalette } from "./ui/CommandPalette";
import { AgentPanel } from "./ui/AgentPanel";
import { CaptureSheet } from "./ui/Capture";
import { Setup } from "./views/Setup";
import { Start } from "./views/Start";
import { ItemPage } from "./views/ItemPage";
import { SearchView } from "./views/Search";
import { FilesPage, InboxPage } from "./views/Lists";
import { TypesView } from "./views/Types";
import { GraphView } from "./views/Graph";
import { Activity } from "./views/Activity";
import { TrashView } from "./views/Trash";
import { Settings } from "./views/Settings";
import { ICON } from "./ui/icons";

export function App() {
  // the confirm dialog lives above everything: the sync may ask before the app has loaded
  return (
    <>
      <Main />
      <ConfirmHost />
      <AppToaster />
    </>
  );
}

function Main() {
  const r = useRepo();
  const { t } = useT();
  const route = useRoute();
  const wide = useMediaQuery("(min-width: 1024px)");
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  useEffect(() => setMenu(false), [route.path]);
  const [agentOpen, setAgentOpen] = useState(() => localStorage.getItem("obtion.agentOpen") === "1" && matchMedia("(min-width: 1024px)").matches);

  const toggleAgent = (v?: boolean) => {
    const next = v ?? !agentOpen;
    setAgentOpen(next);
    localStorage.setItem("obtion.agentOpen", next ? "1" : "0");
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleAgent();
      }
    };
    const ask = () => toggleAgent(true);
    const showPalette = () => setPalette(true);
    window.addEventListener("keydown", on);
    window.addEventListener("obtion:ask", ask);
    window.addEventListener("obtion:palette", showPalette);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("obtion:ask", ask);
      window.removeEventListener("obtion:palette", showPalette);
    };
  });

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

  if (!r.status.loaded) return <div className="flex h-full items-center justify-center text-muted">{t("app.opening")}</div>;
  // First setup: only once the hub was asked (or nothing is there at all and we are offline).
  const settings = r.get(SETTINGS_ID);
  if (!settings && (r.status.synced || (!r.status.online && r.docs.size === 0))) return <Setup />;
  if (!settings) return <div className="flex h-full items-center justify-center text-muted">{t("app.syncing")}</div>;

  const page = (() => {
    switch (route.parts[0]) {
      case undefined:
        return <Start />;
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
      case "i":
        return <ItemPage id={route.parts[1]!} isNew={route.query.get("new") === "1"} />;
      default:
        return <div className="p-8 text-muted">{t("app.notFound")}</div>;
    }
  })();
  const contextItem = route.parts[0] === "i" ? r.get(route.parts[1]) : undefined;
  const isGraph = route.parts[0] === "graph";

  return (
    <div className="flex h-full">
      <button
        onClick={() => document.querySelector("main")?.focus()}
        className="sr-only z-50 rounded-lg border border-line bg-surface text-sm shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:px-3 focus:py-2"
      >
        {t("nav.skip")}
      </button>
      {wide && <Sidebar onSearch={() => setPalette(true)} onAgent={() => toggleAgent(true)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        {!wide && (
          <header className="flex items-center gap-2 border-b border-line bg-bg/90 px-3 py-2 backdrop-blur pt-safe">
            <a href="#/" className="tap flex items-center justify-center gap-2" aria-label={t("nav.start")}>
              <img src="/icon.svg" alt="" className="size-6" />
            </a>
            <SyncDot />
            <button onClick={() => setPalette(true)} className="tap-row ml-1 flex flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-muted">
              <Search size={15} /> {t("nav.searchPlaceholder")}
            </button>
            <button onClick={() => setMenu(true)} className="tap p-1.5 text-muted" aria-label={t("nav.menu")}>
              <Menu size={20} />
            </button>
          </header>
        )}
        {r.readOnly && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-2 px-4 py-2 text-sm" role="status">
            <span className="flex-1">{t("format.tooNew")}</span>
            <button onClick={() => location.reload()} className="font-medium text-[var(--link)] hover:underline">
              {t("format.reload")}
            </button>
          </div>
        )}
        <main tabIndex={-1} className={cx("@container min-h-0 flex-1 outline-none", isGraph ? "overflow-hidden" : "overflow-y-auto")}>
          <PageBoundary key={route.path}>{page}</PageBoundary>
        </main>
        {/* an inbox entry on a phone has its actions at the bottom instead */}
        {!wide && !(route.parts[0] === "inbox" && route.parts[1]) && <MobileNav onAgent={() => toggleAgent(true)} />}
      </div>

      {agentOpen && <AgentPanel context={contextItem} onClose={() => toggleAgent(false)} overlay={!wide} />}
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {menu && (
        <div className="fixed inset-0 z-50 bg-black/30" onClick={() => setMenu(false)}>
          <MenuSheet onClose={() => setMenu(false)}>
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line" />
            <MobileMenu />
          </MenuSheet>
        </div>
      )}
      {!wide && route.parts[0] !== "i" && !(route.parts[0] === "inbox" && route.parts[1]) && !agentOpen && (
        <button
          onClick={() => setCaptureOpen(true)}
          aria-label={t("capture.title")}
          className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-20 flex size-12 items-center justify-center rounded-full bg-ink text-ink-text shadow-lg"
        >
          <Plus size={22} />
        </button>
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
  useModal(ref, onClose);
  return (
    <nav ref={ref} role="dialog" aria-modal="true" className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface p-3 pb-safe shadow-2xl" aria-label={t("nav.menu")} onClick={(e) => e.stopPropagation()}>
      <IconButton onClick={onClose} label={t("close")} icon={X} className="float-right -mr-1 -mt-1" />
      {children}
    </nav>
  );
}

/** The phone menu (a sheet from below): Start, Eingang · Angeheftet · Typen (as in the sidebar) · Einstellungen. */
function MobileMenu() {
  const { t } = useT();
  const ix = useRepo().index();
  const row = "flex min-h-11 items-center gap-3 rounded-lg px-3 text-[15px] hover:bg-hover";
  const inbox = runQuery({ where: inboxWhere(ix) }, { ix }).total;
  return (
    <>
      <a href="#/" className={row}>
        <LayoutDashboard size={18} className="text-muted" /> {t("nav.start")}
      </a>
      <a href="#/inbox" className={row}>
        <Inbox size={18} className="text-muted" /> <span className="flex-1">{t("nav.inbox")}</span>
        {inbox > 0 && <span className="text-xs tabular-nums text-muted">{inbox}</span>}
      </a>
      <PinnedTree touch />
      <TypeNav touch />
      <div className="my-2 border-t border-line" />
      <a href="#/settings" className={row}>
        <SlidersHorizontal size={18} className="text-muted" /> {t("nav.settings")}
      </a>
    </>
  );
}

const OLD_LISTS: Record<string, string> = { "sys:c-project": "/i/sys%3Aproject", "sys:c-task": "/i/sys%3Atask", "sys:c-card": "/i/sys%3Acard", "sys:c-files": "/files", "sys:c-images": "/files?kind=bild", "sys:inbox": "/inbox" };

function Redirect({ to }: { to: string }) {
  useEffect(() => location.replace("#" + to), [to]);
  return null;
}

/** Bottom bar on phones: Start, Eingang, the first two types of the sidebar (Projekte, Tasks), Agent. */
function MobileNav({ onAgent }: { onAgent: () => void }) {
  const { t } = useT();
  const r = useRepo();
  const route = useRoute();
  const ix = r.index();
  const entries = [
    { key: "start", label: t("nav.start"), icon: <LayoutDashboard size={20} />, href: "#/", active: route.path === "/" },
    { key: "inbox", label: t("nav.inbox"), icon: <Inbox size={20} />, href: "#/inbox", active: route.path.startsWith("/inbox"), dot: runQuery({ where: inboxWhere(ix) }, { ix }).total > 0 },
    ...ix.typesInOrder().slice(0, 2).map((x) => {
      const I = ICON[x.schema!.icon] ?? ICON.circle!;
      return { key: x.id, label: ix.typePlural(x.id), icon: <I size={20} />, href: itemHref(x.id), active: route.parts[0] === "i" && route.parts[1] === x.id };
    }),
    { key: "agent", label: t("nav.agent"), icon: <Sparkles size={20} />, onClick: onAgent },
  ] as { key: string; label: string; icon: React.ReactNode; href?: string; onClick?: () => void; active?: boolean; dot?: boolean }[];
  return (
    <nav className="grid border-t border-line bg-surface pb-safe" style={{ gridTemplateColumns: `repeat(${entries.length}, minmax(0, 1fr))` }} aria-label={t("nav.main")}>
      {entries.map((e) => {
        const cls = cx("relative flex flex-col items-center gap-0.5 py-2 text-[11px]", e.active ? "text-fg" : "text-muted");
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
          <button key={e.key} onClick={e.onClick} className={cls}>
            {inner}
          </button>
        );
      })}
    </nav>
  );
}
