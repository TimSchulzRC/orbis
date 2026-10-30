// The account signed in on the server that served this app, and its workspaces ("spaces" here).
// Each workspace is a replica of its own with its own storage on this device; one is open in the
// app (`repo` and `files` point at it), the others sync alongside and show in the sidebar. Kept on
// this device: the account with its token, the last known workspaces (so the app opens offline)
// and which one is open.
import { useSyncExternalStore } from "react";
import { Repo } from "@obtion/sync";
import { browserHost, type SpaceLink } from "./browser";
import { DeviceFiles, setFiles } from "./files";
import { setRepo } from "./repo";
import { globalPage } from "./scope";

export interface Account {
  token: string;
  user: { id: string; name: string; email: string };
  admin?: boolean;
  /** the server no longer accepts the token: sign in again */
  lost?: boolean;
}

export interface Space {
  id: string;
  name: string;
  role: "owner" | "member";
  legacy?: boolean;
}

const KEY = { account: "obtion.account", spaces: "obtion.spaces", active: "obtion.active", shown: "obtion.shown" };
const read = <T>(k: string, def: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(k) ?? "null") as T) ?? def;
  } catch {
    return def;
  }
};

// the app could hold accounts of other servers for a day (2026-10-27): keep the one of this server
if (localStorage.getItem("obtion.accounts")) {
  const mine = read<{ server: string }[]>("obtion.accounts", []).find((a) => a.server === location.origin);
  if (mine) localStorage.setItem(KEY.account, JSON.stringify(mine));
  for (const k of ["obtion.accounts", KEY.spaces, KEY.active]) localStorage.removeItem(k);
}

let account: Account | null = read(KEY.account, null);
let spaces: Space[] = read(KEY.spaces, []);
let active: string | null = localStorage.getItem(KEY.active);
/** The workspaces chosen to be seen (sidebar, inbox) on this device; null: all. */
let shown: string[] | null = read(KEY.shown, null);
let version = 0;
const listeners = new Set<() => void>();

function save() {
  localStorage.setItem(KEY.account, JSON.stringify(account));
  localStorage.setItem(KEY.spaces, JSON.stringify(spaces));
  if (active) localStorage.setItem(KEY.active, active);
  else localStorage.removeItem(KEY.active);
  localStorage.setItem(KEY.shown, JSON.stringify(shown));
  version++;
  for (const l of listeners) l();
}

export function useAccounts() {
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => version,
  );
  return { account, spaces, active: spaces.find((s) => s.id === active), shown: shownSpaces() };
}

/** The workspaces chosen to be seen; never none (a choice that left none shows all). */
export function shownSpaces(): Space[] {
  const list = spaces.filter((s) => !shown || shown.includes(s.id));
  return list.length ? list : spaces;
}

/** Choose the workspaces to be seen. All of them is stored as "all", so a new one is seen too. */
export function setShown(ids: string[]) {
  shown = spaces.every((s) => ids.includes(s.id)) ? null : ids;
  save();
}

export const activeSpace = () => spaces.find((s) => s.id === active);
export const spaceById = (id: string) => spaces.find((s) => s.id === id);

// ---------- replicas ----------

const open = new Map<string, { repo: Repo; files: DeviceFiles }>();

function link(s: Space): SpaceLink {
  // the data from before accounts: the storage names they had, so this device keeps its copy
  return { base: `${location.origin}/w/${s.id}`, token: account!.token, name: s.legacy ? "obtion" : `obtion-ws-${s.id}` };
}

/** The replica of a workspace, opened (and syncing) from its first use on. */
export function replica(id: string): { repo: Repo; files: DeviceFiles } {
  let r = open.get(id);
  if (!r) {
    const l = link(spaces.find((x) => x.id === id)!);
    const repo = new Repo(browserHost(l));
    r = { repo, files: new DeviceFiles(repo, l) };
    open.set(id, r);
    repo.init().catch((e) => console.error("could not open local storage", e));
  }
  return r;
}

/** Changes on this device a reachable server does not have yet (in any open workspace). */
export function unsynced(): boolean {
  return [...open.values()].some(({ repo }) => repo.status.pending > 0 && repo.status.online);
}

/** Open a workspace in the app. */
export function activate(id: string) {
  if (!spaces.some((s) => s.id === id)) return;
  const r = replica(id);
  setRepo(r.repo);
  setFiles(r.files);
  if (active !== id) {
    active = id;
    save();
  }
}


/** A workspace's API (/w/<id>/api/…). */
export const spaceFetch = (id: string, path: string, init: RequestInit = {}) =>
  fetch(`/w/${id}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${account!.token}` } });

// ---------- account ----------

async function call(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", token = account?.token) {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status });
  return data;
}

/** Ask the server for the account's workspaces (and whether the token still counts). */
export async function refresh() {
  if (!account) return;
  let gone: Space[] = [];
  try {
    const me = await call("/api/account");
    Object.assign(account, { user: me.user, admin: me.admin, lost: false });
    const known = new Map(spaces.map((s) => [s.id, s]));
    // gone on the server (deleted, or this account removed): the copy here goes too
    gone = spaces.filter((s) => !me.workspaces.some((w: Space) => w.id === s.id));
    spaces = me.workspaces.map((w: Space) => ({ ...known.get(w.id), ...w }));
  } catch (e) {
    if ((e as { status?: number }).status === 401) account.lost = true;
    else return; // offline: keep what is known
  }
  if (!activeSpace() && spaces[0]) activate(spaces[0].id);
  save();
  // deleting makes open replicas reload the page: last
  for (const s of gone) await forget(s);
}

/** Keep the account signed in with `token` (another one signed in before leaves first). */
async function keep(token: string) {
  const me = await call("/api/account", undefined, "GET", token);
  if (account && account.user.id !== me.user.id) await forgetAll();
  account = { token, user: me.user };
  await refresh();
}

export async function signIn(email: string, password: string) {
  const res = await call("/api/auth/sign-in/email", { email, password });
  await keep(res.token);
}

/** Create an account – with an invite it joins that workspace instead of getting one of its own. */
export async function signUp(b: { name: string; email: string; password: string; invite?: string; lang: string }) {
  const res = await call("/api/account/signup", b);
  await keep(res.token);
}

/** Sign out: the workspaces leave this device, with their local copies. */
export async function signOut() {
  await call("/api/account/signout", {}).catch(() => {});
  await forgetAll();
  save();
  location.replace("#/");
  location.reload();
}

/** Delete the account on this server, then remove this device's workspace copies. */
export async function deleteAccount(password: string) {
  await call("/api/account", { password }, "DELETE");
  await forgetAll();
  save();
  location.replace("#/");
  location.reload();
}

async function forgetAll() {
  const previous = spaces;
  account = null;
  spaces = [];
  active = null;
  shown = null;
  // Persist the signed-out state before IndexedDB deletion can reload another open replica.
  save();
  for (const s of previous) await forget(s);
}

/** Delete a workspace's local copy (after leaving it or signing out). */
async function forget(s: Space) {
  const name = s.legacy ? "obtion" : `obtion-ws-${s.id}`;
  open.delete(s.id);
  const legacy = name === "obtion";
  await Promise.all([name, legacy ? "obtion-files" : `${name}-files`].map((db) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(db);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  })));
  const root = await navigator.storage?.getDirectory?.().catch(() => undefined);
  await root?.removeEntry(legacy ? "blobs" : `blobs-${name}`, { recursive: true }).catch(() => {});
}

// ---------- workspaces ----------

export async function createSpace(name: string) {
  const w = await call("/api/workspaces", { name });
  if (shown) shown = [...shown, w.id];
  await refresh();
  location.hash = `#/w/${w.id}/setup`;
}

export async function renameSpace(s: Space, name: string) {
  await call(`/api/workspaces/${s.id}`, { name }, "PATCH");
  await refresh();
}

/** An invite link: whoever opens it may join (with an account of this server). */
export async function inviteLink(s: Space): Promise<string> {
  const { code } = await call(`/api/workspaces/${s.id}/invites`, {});
  return `${location.origin}/#/join/${code}`;
}

export function members(s: Space): Promise<{ id: string; name: string; email: string; role: string }[]> {
  return call(`/api/workspaces/${s.id}/members`);
}

export async function leaveSpace(s: Space) {
  await call(`/api/workspaces/${s.id}/members/${account!.user.id}`, undefined, "DELETE");
  await forget(s);
  spaces = spaces.filter((x) => x.id !== s.id);
  if (active === s.id) active = spaces[0]?.id ?? null;
  save();
  location.replace("#/");
  location.reload();
}

/** Delete a workspace for good on the server (owners only; for every member). */
export async function deleteSpace(s: Space) {
  await call(`/api/workspaces/${s.id}`, undefined, "DELETE");
  spaces = spaces.filter((x) => x.id !== s.id);
  if (active === s.id) active = spaces[0]?.id ?? null;
  save();
  await forget(s);
  location.replace("#/");
  location.reload();
}

export async function joinInvite(code: string) {
  const w = await call(`/api/invites/${code}`, {});
  await refresh();
  activate(w.id);
}

export const invite = (code: string): Promise<{ workspace: string; by: string; signup: boolean }> => call(`/api/invites/${code}`);
export const serverInfo = (): Promise<{ signup: "open" | "invite" | "off"; firstAccount: boolean; version: string; commit: string }> => call("/api/info");

/** An MCP token for agents on a workspace, with the ready-made commands. */
export const mcpToken = (s: Space) => call(`/api/workspaces/${s.id}/mcp-token`, {});

/**
 * The address names the workspace ("#/w/<id>/…") and opens it. A page of a workspace without it
 * (a link inside the app) is the open workspace's and gets its name, so going back later returns
 * to it. Pages of no workspace (inbox, search, settings) keep an address without one.
 */
function followHash() {
  const named = /^#\/w\/([^/?]+)/.exec(location.hash)?.[1];
  if (named) {
    if (named !== active && spaces.some((s) => s.id === named)) activate(named);
  } else if (active && !globalPage((location.hash.slice(1).split("?")[0] ?? "").split("/").filter(Boolean)))
    history.replaceState(history.state, "", `#/w/${active}${location.hash.slice(1) || "/"}`);
}
addEventListener("hashchange", followHash);

// the workspace open at the last start (or named by the address); the others open when they are first shown
if (activeSpace()) activate(active!);
else if (spaces[0]) activate(spaces[0].id);
followHash();
