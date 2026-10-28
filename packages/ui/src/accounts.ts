// The account signed in on the server that served this app, and the workspaces ("spaces" here):
// those of the account on the server, and those kept in a folder on this device (see local.ts) –
// with or without the server. Each workspace is a replica of its own with its own storage on this
// device; one is open in the app (`repo` and `files` point at it), the others sync alongside and
// show in the sidebar. Kept on this device: the account with its token, the last known workspaces
// of the server (so the app opens offline), the folder workspaces, and which one is open.
//
// A workspace changes where it is kept: one in a folder starts syncing with the server (it is
// uploaded into a new workspace there), one of the server gets a full copy in a folder, and a
// folder copy is cut off from the server again (it goes on alone; the server's stays as it is).
import { useSyncExternalStore } from "react";
import { openDB } from "idb";
import * as Y from "yjs";
import { newId } from "@obtion/core/model";
import { Repo } from "@obtion/sync";
import { FOLDER_FORMAT, encodeRows, readInfo, writeInfo } from "@obtion/sync/folder";
import { browserHost, type SpaceLink } from "./browser";
import { DeviceFiles, setFiles } from "./files";
import { folderNow, folderOf, forgetFolder, handleDir, rememberFolder } from "./local";
import { setRepo } from "./repo";
import { globalPage } from "./scope";

export interface Account {
  token: string;
  user: { id: string; name: string; email: string };
  admin?: boolean;
  /** may use the in-app agent */
  agent?: boolean;
  /** the server no longer accepts the token: sign in again */
  lost?: boolean;
}

export interface Space {
  id: string;
  name: string;
  /** its workspace on this server (the same id for one that began there); none: on this device only */
  remote?: string;
  role?: "owner" | "member";
  legacy?: boolean;
  /** kept in a folder on this device, all of it (files too) */
  folder?: boolean;
}

/** A workspace in a folder, as this device keeps it. */
interface FolderSpace {
  id: string;
  name: string;
  remote?: string;
}

const KEY = { account: "obtion.account", spaces: "obtion.spaces", active: "obtion.active", shown: "obtion.shown", folders: "obtion.folders", detached: "obtion.detached" };
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
/** The account's workspaces on the server, as it said last. */
let server: Space[] = read(KEY.spaces, []);
let folders: FolderSpace[] = read(KEY.folders, []);
/** Workspaces of the server whose folder copy was cut off from it: not shown on this device any more. */
let detached: string[] = read(KEY.detached, []);
let spaces: Space[] = combine();
let active: string | null = localStorage.getItem(KEY.active);
/** The workspaces chosen to be seen (sidebar, inbox) on this device; null: all. */
let shown: string[] | null = read(KEY.shown, null);
let version = 0;
const listeners = new Set<() => void>();

/** The workspaces in the app: the server's in its order (the one with a folder copy as that), then the folders of this device only. */
function combine(): Space[] {
  const copies = new Map(folders.filter((f) => f.remote).map((f) => [f.remote!, f]));
  const out: Space[] = [];
  for (const s of server) {
    if (detached.includes(s.id)) continue;
    const f = copies.get(s.id);
    out.push(f ? { ...s, id: f.id, remote: s.id, folder: true } : { ...s, remote: s.id });
  }
  for (const f of folders) if (!out.some((x) => x.id === f.id)) out.push({ ...f, folder: true });
  return out;
}

function save() {
  spaces = combine();
  localStorage.setItem(KEY.account, JSON.stringify(account));
  localStorage.setItem(KEY.spaces, JSON.stringify(server));
  localStorage.setItem(KEY.folders, JSON.stringify(folders));
  localStorage.setItem(KEY.detached, JSON.stringify(detached));
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

// the data from before accounts: the storage names they had, so this device keeps its copy
const storeName = (s: Space) => (s.legacy ? "obtion" : `obtion-ws-${s.id}`);

function link(s: Space): SpaceLink {
  return {
    server: s.remote && account ? { base: `${location.origin}/w/${s.remote}`, token: account.token } : undefined,
    name: storeName(s),
    folder: s.folder ? folderOf(s.id) : undefined,
  };
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

/** May the account use the in-app agent? (on the server and for this account) */
export const agentHere = () => !!account?.agent;

/** Does workspace `id` sync with the server (what needs the server: activity, undo, agent, members)? */
export const onServer = (id?: string) => !!(id && account && spaceById(id)?.remote);

/** A workspace's API (/w/<id>/api/…). */
export const spaceFetch = (id: string, path: string, init: RequestInit = {}) =>
  fetch(`/w/${spaceById(id)?.remote}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${account!.token}` } });

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
  try {
    const me = await call("/api/account");
    Object.assign(account, { user: me.user, admin: me.admin, agent: me.agent, lost: false });
    const known = new Map(server.map((s) => [s.id, s]));
    server = me.workspaces.map((w: Space) => ({ ...known.get(w.id), ...w }));
    // a folder copy is called as its workspace on the server
    for (const f of folders) f.name = server.find((w) => w.id === f.remote)?.name ?? f.name;
  } catch (e) {
    if ((e as { status?: number }).status === 401) account.lost = true;
    else return; // offline: keep what is known
  }
  save();
  if (!activeSpace() && spaces[0]) activate(spaces[0].id);
}

/** Keep the account signed in with `token` (another one signed in before leaves first). */
async function keep(token: string) {
  const me = await call("/api/account", undefined, "GET", token);
  if (account && account.user.id !== me.user.id) await forgetAll(true);
  account = { token, user: me.user };
  await refresh();
}

export async function signIn(email: string, password: string) {
  const res = await call("/api/auth/sign-in/email", { email, password });
  await keep(res.token);
}

/** Create an account – with an invite it joins that workspace instead of getting one of its own (`none`: gets none either). */
export async function signUp(b: { name: string; email: string; password: string; invite?: string; lang: string; none?: boolean }) {
  const res = await call("/api/account/signup", b);
  await keep(res.token);
}

/** Sign out: the workspaces of the server leave this device, with their local copies; those in a folder stay (and sync again after signing in). */
export async function signOut() {
  await call("/api/account/signout", {}).catch(() => {});
  await forgetAll();
  save();
  location.replace("#/");
  location.reload();
}

/** The account leaves this device. Folder workspaces stay; `cut`: they no longer sync either (another account comes). */
async function forgetAll(cut = false) {
  const before = spaces;
  if (cut) for (const s of before) if (s.folder) await cutOff(s);
  account = null;
  server = [];
  shown = null;
  save();
  if (!activeSpace()) active = spaces[0]?.id ?? null;
  save();
  // deleting makes open replicas reload the page: only once all the rest is stored
  for (const s of before) if (!s.folder || cut) await forget(s);
}

/** Delete a workspace's local copy (after leaving it or signing out); of one in a folder only what concerns the server, the folder stays. */
async function forget(s: Space) {
  const name = storeName(s);
  open.delete(s.id);
  const legacy = name === "obtion";
  for (const db of [name, legacy ? "obtion-files" : `${name}-files`]) indexedDB.deleteDatabase(db);
  if (s.folder) return;
  const root = await navigator.storage?.getDirectory?.().catch(() => undefined);
  await root?.removeEntry(legacy ? "blobs" : `blobs-${name}`, { recursive: true }).catch(() => {});
}

/** A folder workspace goes on without the server: the folder no longer names it (then forget what this device knew of the server). */
async function cutOff(s: Space) {
  const f = folders.find((x) => x.id === s.id);
  if (!f?.remote) return;
  if (!detached.includes(f.remote)) detached.push(f.remote);
  delete f.remote;
  save();
  // without access now: the folder keeps naming the server, which only counts when it is opened anew
  const handle = await folderNow(s.id);
  if (handle) {
    const info = await readInfo(handleDir(handle));
    await writeInfo(handleDir(handle), { id: s.id, name: info?.name ?? s.name });
  }
}

// ---------- workspaces ----------

/** A folder holds data that are no workspace (a chosen folder must be empty or one of a workspace). */
export class FolderError extends Error {}

async function isEmpty(handle: FileSystemDirectoryHandle) {
  for await (const name of (handle as unknown as { keys(): AsyncIterable<string> }).keys()) if (!name.startsWith(".")) return false;
  return true;
}

/**
 * A workspace in this folder: a new one in an empty folder, or the one already in it (made by
 * another app or another browser). One that syncs with this server is synced again.
 */
export async function openFolder(handle: FileSystemDirectoryHandle, name: string) {
  const dir = handleDir(handle);
  const info = await readInfo(dir);
  if (info && info.folder > FOLDER_FORMAT) throw new FolderError("tooNew");
  if (!info && !(await isEmpty(handle))) throw new FolderError("notEmpty");
  const id = info?.id ?? newId();
  if (folders.some((f) => f.id === id)) return void (location.hash = `#/w/${id}/`);
  if (!info) await writeInfo(dir, { id, name: name.trim() || "Workspace" });
  const remote = account && info?.server?.url === location.origin ? info.server.workspace : undefined;
  // its copy from the server knows less than the folder may: start anew and send it all
  if (remote) await forget({ id, name: "", folder: true });
  await rememberFolder(id, handle);
  folders.push({ id, name: info?.name ?? name, remote });
  if (shown) shown = [...shown, id];
  save();
  location.hash = `#/w/${id}/${info ? "" : "setup"}`;
  if (!remote) return activate(id);
  const { repo } = replica(id);
  await repo.loaded;
  await repo.enqueueFullUpload();
  location.reload();
}

/** Keep a full copy of a workspace of the server in this (empty) folder: it then works from there. */
export async function copyToFolder(s: Space, handle: FileSystemDirectoryHandle) {
  if (!(await isEmpty(handle))) throw new FolderError("notEmpty");
  const { repo, files } = replica(s.id);
  await repo.saved();
  const dir = handleDir(handle);
  await dir.write(`updates/${Date.now().toString(36)}-copy.obu`, encodeRows([...repo.docs].map(([d, doc]) => ({ d, u: Y.encodeStateAsUpdate(doc) }))));
  await files.copyInto(handle);
  await writeInfo(dir, { id: s.id, name: s.name, server: { url: location.origin, workspace: s.remote! } });
  // the data are in the folder now; the position on the server and the outbox stay here
  const db = await openDB(storeName(s), 1);
  await db.clear("updates");
  db.close();
  const root = await navigator.storage?.getDirectory?.().catch(() => undefined);
  await root?.removeEntry(s.legacy ? "blobs" : `blobs-${storeName(s)}`, { recursive: true }).catch(() => {});
  await rememberFolder(s.id, handle);
  folders.push({ id: s.id, name: s.name, remote: s.remote });
  save();
  location.reload();
}

/** Sync a workspace of this device with the server: a new workspace there, which gets all of it. */
export async function putOnServer(s: Space) {
  const w = await call("/api/workspaces", { name: s.name });
  const { repo, files } = replica(s.id);
  await repo.loaded;
  await repo.saved();
  await repo.enqueueFullUpload();
  await files.uploadEverything();
  const dir = handleDir(await folderOf(s.id));
  await writeInfo(dir, { id: s.id, name: s.name, server: { url: location.origin, workspace: w.id } });
  folders.find((f) => f.id === s.id)!.remote = w.id;
  await refresh();
  location.reload();
}

/** Cut a folder copy off from the server: it goes on as a workspace of this device only. */
export async function detach(s: Space) {
  await cutOff(s);
  // deleting makes the open replica reload the page: last
  await forget(s);
  location.reload();
}

/** Take a workspace of this device out of the app; its folder stays as it is (and can be opened again). */
export async function removeFolderSpace(s: Space) {
  folders = folders.filter((f) => f.id !== s.id);
  if (active === s.id) active = null;
  save();
  await forgetFolder(s.id);
  await forget(s);
  location.replace("#/");
  location.reload();
}

export async function createSpace(name: string) {
  const w = await call("/api/workspaces", { name });
  if (shown) shown = [...shown, w.id];
  await refresh();
  location.hash = `#/w/${w.id}/setup`;
}

export async function renameSpace(s: Space, name: string) {
  if (s.remote) await call(`/api/workspaces/${s.remote}`, { name }, "PATCH");
  const f = folders.find((x) => x.id === s.id);
  const handle = f && (await folderNow(s.id));
  if (f) f.name = name;
  if (handle) {
    const info = await readInfo(handleDir(handle));
    await writeInfo(handleDir(handle), { ...info, id: s.id, name });
  }
  save();
  await refresh();
}

/** An invite link: whoever opens it may join (with an account of this server). */
export async function inviteLink(s: Space): Promise<string> {
  const { code } = await call(`/api/workspaces/${s.remote}/invites`, {});
  return `${location.origin}/#/join/${code}`;
}

export function members(s: Space): Promise<{ id: string; name: string; email: string; role: string }[]> {
  return call(`/api/workspaces/${s.remote}/members`);
}

/** Leave a workspace of the server; a folder copy of it stays as a workspace of this device. */
export async function leaveSpace(s: Space) {
  await call(`/api/workspaces/${s.remote}/members/${account!.user.id}`, undefined, "DELETE");
  if (s.folder) return detach(s);
  await forget(s);
  server = server.filter((x) => x.id !== s.remote);
  save();
  if (active === s.id) active = spaces[0]?.id ?? null;
  save();
  location.replace("#/");
  location.reload();
}

export async function joinInvite(code: string) {
  const w = await call(`/api/invites/${code}`, {});
  await refresh();
  activate(w.id);
}

export const invite = (code: string): Promise<{ workspace: string; by: string; signup: boolean }> => call(`/api/invites/${code}`);
export const serverInfo = (): Promise<{ signup: "open" | "invite" | "off"; firstAccount: boolean; agent: boolean }> => call("/api/info");

/** An MCP token for agents on a workspace, with the ready-made commands. */
export const mcpToken = (s: Space) => call(`/api/workspaces/${s.remote}/mcp-token`, {});

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
