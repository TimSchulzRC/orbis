// Applying an update: local changes go to the server first, then SKIP_WAITING, then exactly one
// reload once the new worker has taken over.
import { setUpdate, setUpdateCheck, unsynced } from "@obtion/ui";

let reg: ServiceWorkerRegistration | undefined;
let reloading = false;
const TAKEOVER_TIMEOUT_MS = 4000;
const RECHECK_MS = 30 * 60_000;
const SYNC_POLL_MS = 150;

const ready = () => setUpdate("ready", () => void apply());

// bounded wait: unsent changes stay on the device anyway
async function waitForSync(ms = 5000) {
	const end = Date.now() + ms;
	while (unsynced() && Date.now() < end) await new Promise((r) => setTimeout(r, SYNC_POLL_MS));
}

function reloadOnce() {
	if (reloading) return;
	reloading = true;
	location.reload();
}

async function apply() {
	setUpdate("applying");
	await waitForSync();
	const waiting = reg?.waiting;
	if (!waiting) return reloadOnce();
	navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, { once: true });
	waiting.postMessage({ type: "SKIP_WAITING" });
	// fallback for a worker that never takes over
	setTimeout(reloadOnce, TAKEOVER_TIMEOUT_MS);
}

export function initUpdates() {
	if (!("serviceWorker" in navigator) || import.meta.env.DEV) return;
	import("virtual:pwa-register").then(({ registerSW }) => {
		registerSW({
			onNeedReload: () => {
				// we reload ourselves, once and after the outbox has drained
			},
			onNeedRefresh: ready,
			onRegisteredSW: (_url, registration) => {
				if (!registration) return;
				reg = registration;
				if (registration.waiting && navigator.serviceWorker.controller) ready();
				// without a controller this is the first install, not an update
				registration.addEventListener("updatefound", () => {
					if (navigator.serviceWorker.controller && !registration.waiting) setUpdate("loading");
				});
				setUpdateCheck(async () => {
					await registration.update();
					return !!(registration.installing || registration.waiting);
				});
				const recheck = () =>
					void registration.update().catch(() => {
						// offline or the server is down; the next check tries again
					});
				// tabs left open for days still notice rollouts
				setInterval(recheck, RECHECK_MS);
				document.addEventListener("visibilitychange", () => {
					if (document.visibilityState === "visible") recheck();
				});
			},
		});
	});
}
