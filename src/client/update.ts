// A new version of the app: one notice at the bottom (sonner, id "update", never twice). While
// the new service worker still loads it says so; once it waits, "Neu laden" activates it fully –
// local changes first go to the hub, then SKIP_WAITING, then exactly one reload when the new
// worker has taken over. Without a waiting worker the page reloads at once.
import { toast } from "sonner";
import { tr } from "./i18n";
import { repo } from "./repo";

const ID = "update";
let reg: ServiceWorkerRegistration | undefined;
let reloading = false;

function loading(text = tr("app.updateLoading")) {
  toast.loading(text, { id: ID, duration: Infinity });
}

function ready() {
  toast(tr("app.newVersion"), {
    id: ID,
    duration: Infinity,
    action: {
      label: tr("app.reload"),
      onClick: (e) => (e.preventDefault(), void apply()),
    },
  });
}

/** Unsent local changes: wait until the hub has them (they are kept on the device anyway). */
async function settled(ms = 5000) {
  const end = Date.now() + ms;
  while (repo.status.pending > 0 && repo.status.online && Date.now() < end) await new Promise((r) => setTimeout(r, 150));
}

function reloadOnce() {
  if (reloading) return;
  reloading = true;
  location.reload();
}

async function apply() {
  loading(tr("app.updating"));
  await settled();
  const waiting = reg?.waiting;
  if (!waiting) return reloadOnce();
  navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, { once: true });
  waiting.postMessage({ type: "SKIP_WAITING" });
  // a worker that does not take over: reload anyway after a while
  setTimeout(reloadOnce, 4000);
}

export function initUpdates() {
  if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
  import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({
      // the reload is ours (exactly once, after the outbox): the plugin's own one stays off
      onNeedReload: () => {},
      onNeedRefresh: ready,
      onRegisteredSW: (_url, r) => {
        if (!r) return;
        reg = r;
        if (r.waiting && navigator.serviceWorker.controller) ready();
        // a new version found: say so while it loads (only when this page has one running)
        r.addEventListener("updatefound", () => navigator.serviceWorker.controller && !r.waiting && loading());
        // a page left open for long notices rollouts too
        setInterval(() => void r.update().catch(() => {}), 30 * 60_000);
        document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void r.update().catch(() => {}));
      },
    });
  });
}
