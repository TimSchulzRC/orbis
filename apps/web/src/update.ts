// A new version of the app: the status button (packages/ui/src/update.ts) turns while its service
// worker loads and offers "Aktualisieren" once it waits. That activates it fully – local changes
// first go to the server, then SKIP_WAITING, then exactly one reload when the new worker has taken
// over. Without a waiting worker the page reloads at once. A click on the button looks for one too.
import { setUpdate, setUpdateCheck, unsynced } from "@obtion/ui";

let reg: ServiceWorkerRegistration | undefined;
let reloading = false;

const ready = () => setUpdate("ready", () => void apply());

/** Unsent local changes: wait until the server has them (they are kept on the device anyway). */
async function settled(ms = 5000) {
  const end = Date.now() + ms;
  while (unsynced() && Date.now() < end) await new Promise((r) => setTimeout(r, 150));
}

function reloadOnce() {
  if (reloading) return;
  reloading = true;
  location.reload();
}

async function apply() {
  setUpdate("applying");
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
        // a new version found: the button turns while it loads (only when this page has one running)
        r.addEventListener("updatefound", () => navigator.serviceWorker.controller && !r.waiting && setUpdate("loading"));
        setUpdateCheck(async () => {
          await r.update();
          return !!(r.installing || r.waiting);
        });
        // a page left open for long notices rollouts too
        setInterval(() => void r.update().catch(() => {}), 30 * 60_000);
        document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void r.update().catch(() => {}));
      },
    });
  });
}
