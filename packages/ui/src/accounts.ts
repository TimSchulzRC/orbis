// The accounts this app holds – on the server that served it and on others – and their
// workspaces ("spaces" here). Each workspace is a replica of its own with its own storage on this
// device; one is open in the app (`repo` and `files` point at it), the others sync alongside and
// show in the sidebar. Kept on this device: the accounts with their tokens, the last known
// workspaces (so the app opens offline) and which one is open.
import { useSyncExternalStore } from "react";
import { Repo } from "@obtion/sync";
import { browserHost, type SpaceLink } from "./browser";
import { DeviceFiles, setFiles } from "./files";
import { setRepo } from "./repo";

export interface Account {
  id: string;
  /** the server's origin, e.g. https://obtion.example.org */
  server: string;
  token: string;
  user: { id: string; name: string; email: string };
  admin?: boolean;
  /** may use the in-app agent on this server */
  agent?: boolean;
  /** the server no longer accepts the token: sign in again */
  lost?: boolean;
}

export interface Space {
  /** account id + workspace id: unique on this device */
  key: string;
  account: string;
  id: string;
  name: string;
  role: "owner" | "member";
  legacy?: boolean;
}

/** The server that served this app. */
export const here = location.origin;

const KEY = { accounts: "obtion.accounts", spaces: "obtion.spaces", active: "obtion.active" };
const read = <T>(k: string, def: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(k) ?? "null") as T) ?? def;
  } catch {
    return def;
  }
};

let accounts: Account[] = read(KEY.accounts, []);
let spaces: Space[] = read(KEY.spaces, []);
let active: string | null = localStorage.getItem(KEY.active);
let version = 0;
const listeners = new Set<() => void>();

function save() {
  localStorage.setItem(KEY.accounts, JSON.stringify(accounts));
  localStorage.setItem(KEY.spaces, JSON.stringify(spaces));
  if (active) localStorage.setItem(KEY.active, active);
  else localStorage.removeItem(KEY.active);
  version++;
  for (const l of listeners) l();
}

export function useAccounts() {
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => version,
  );
  return { accounts, spaces, active: spaces.find((s) => s.key === active) };
}

export const accountOf = (s: Space) => accounts.find((a) => a.id === s.account)!;
export const activeSpace = () => spaces.find((s) => s.key === active);
/** The host of a server for display ("obtion.example.org"). */
export const hostOf = (server: string) => new URL(server).host;

// ---------- replicas ----------

const open = new Map<string, { repo: Repo; files: DeviceFiles }>();

function link(s: Space): SpaceLink {
  const a = accountOf(s);
  // the data from before accounts: the storage names they had, so this device keeps its copy
  const name = s.legacy && a.server === here ? "obtion" : `obtion-ws-${s.id}`;
  return { base: `${a.server}/w/${s.id}`, token: a.token, name };
}

/** The replica of a workspace, opened (and syncing) from its first use on. */
export function replica(key: string): { repo: Repo; files: DeviceFiles } {
  let r = open.get(key);
  if (!r) {
    const s = spaces.find((x) => x.key === key)!;
    const l = link(s);
    const repo = new Repo(browserHost(l));
    r = { repo, files: new DeviceFiles(repo, l) };
    open.set(key, r);
    repo.init().catch((e) => console.error("could not open local storage", e));
  }
  return r;
}

/** Changes on this device a reachable server does not have yet (in any open workspace). */
export function unsynced(): boolean {
  return [...open.values()].some(({ repo }) => repo.status.pending > 0 && repo.status.online);
}

/** Open a workspace in the app. */
export function activate(key: string) {
  if (!spaces.some((s) => s.key === key)) return;
  const r = replica(key);
  setRepo(r.repo);
  setFiles(r.files);
  if (active !== key) {
    active = key;
    save();
  }
}

/** May the open workspace's account use the in-app agent? (on the server and for this account) */
export const agentHere = () => {
  const s = activeSpace();
  return !!s && !!accountOf(s).agent;
};

/** The open workspace's API (…/w/<id>/api/…). */
export const activeFetch = (path: string, init?: RequestInit) => spaceFetch(activeSpace()!, path, init);

/** A workspace's API (…/w/<id>/api/…) as its account. */
export function spaceFetch(s: Space, path: string, init: RequestInit = {}) {
  const a = accountOf(s);
  return fetch(`${a.server}/w/${s.id}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${a.token}` } });
}

// ---------- accounts ----------

async function call(a: { server: string; token?: string }, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const res = await fetch(a.server + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(a.token ? { authorization: `Bearer ${a.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status });
  return data;
}

/** Ask the server for the account's workspaces (and whether the token still counts). */
export async function refresh(acc: Account) {
  try {
    const me = await call(acc, "/api/account");
    Object.assign(acc, { user: me.user, admin: me.admin, agent: me.agent, lost: false });
    const known = new Map(spaces.filter((s) => s.account === acc.id).map((s) => [s.id, s]));
    const mine: Space[] = me.workspaces.map((w: Omit<Space, "key" | "account">) => ({ ...known.get(w.id), ...w, key: `${acc.id}/${w.id}`, account: acc.id }));
    spaces = [...spaces.filter((s) => s.account !== acc.id), ...mine];
  } catch (e) {
    if ((e as { status?: number }).status === 401) acc.lost = true;
    else return; // offline: keep what is known
  }
  if (!activeSpace() && spaces[0]) activate(spaces[0].key);
  save();
}

export function refreshAll() {
  return Promise.all(accounts.map(refresh));
}

/** Keep an account (signed in on its server's page, or brought back from another server). Opens its first workspace if none is open. */
export async function addAccount(server: string, token: string): Promise<Account> {
  const me = await call({ server, token }, "/api/account");
  let acc = accounts.find((a) => a.server === server && a.user.id === me.user.id);
  if (acc) Object.assign(acc, { token, lost: false });
  else accounts.push((acc = { id: "a" + Math.random().toString(36).slice(2, 10), server, token, user: me.user }));
  await refresh(acc);
  const first = spaces.find((s) => s.account === acc!.id);
  if (first && (!activeSpace() || accounts.length === 1)) activate(first.key);
  save();
  return acc;
}

/** Sign in on this server (its own page). */
export async function signIn(email: string, password: string) {
  const res = await call({ server: here }, "/api/auth/sign-in/email", { email, password });
  return addAccount(here, res.token);
}

/** Create an account on this server – with an invite it joins that workspace instead of getting one of its own. */
export async function signUp(b: { name: string; email: string; password: string; invite?: string; lang: string }) {
  const res = await call({ server: here }, "/api/account/signup", b);
  return addAccount(here, res.token);
}

/** The account of this server signed in here, if any (the connect and invite pages need it). */
export const homeAccount = () => accounts.find((a) => a.server === here && !a.lost);

/** Sign out: the account's workspaces leave this device, with their local copies. */
export async function signOut(acc: Account) {
  await call(acc, "/api/account/signout", {}).catch(() => {});
  const gone = spaces.filter((s) => s.account === acc.id);
  for (const s of gone) await forget(s);
  accounts = accounts.filter((a) => a !== acc);
  spaces = spaces.filter((s) => s.account !== acc.id);
  if (!activeSpace()) active = spaces[0]?.key ?? null;
  save();
  location.replace("#/");
  location.reload();
}

/** Delete a workspace's local copy (after leaving it or signing out). */
async function forget(s: Space) {
  const name = link(s).name;
  open.delete(s.key);
  const legacy = name === "obtion";
  for (const db of [name, legacy ? "obtion-files" : `${name}-files`]) indexedDB.deleteDatabase(db);
  const root = await navigator.storage?.getDirectory?.().catch(() => undefined);
  await root?.removeEntry(legacy ? "blobs" : `blobs-${name}`, { recursive: true }).catch(() => {});
}

// ---------- workspaces ----------

export async function createSpace(acc: Account, name: string) {
  const w = await call(acc, "/api/workspaces", { name });
  await refresh(acc);
  activate(`${acc.id}/${w.id}`);
}

export async function renameSpace(s: Space, name: string) {
  await call(accountOf(s), `/api/workspaces/${s.id}`, { name }, "PATCH");
  await refresh(accountOf(s));
}

/** An invite link: whoever opens it may join (with an account of that server). */
export async function inviteLink(s: Space): Promise<string> {
  const { code } = await call(accountOf(s), `/api/workspaces/${s.id}/invites`, {});
  return `${accountOf(s).server}/#/join/${code}`;
}

export function members(s: Space): Promise<{ id: string; name: string; email: string; role: string }[]> {
  return call(accountOf(s), `/api/workspaces/${s.id}/members`);
}

export async function leaveSpace(s: Space) {
  const acc = accountOf(s);
  await call(acc, `/api/workspaces/${s.id}/members/${acc.user.id}`, undefined, "DELETE");
  await forget(s);
  spaces = spaces.filter((x) => x.key !== s.key);
  if (active === s.key) active = spaces[0]?.key ?? null;
  save();
  location.replace("#/");
  location.reload();
}

export async function joinInvite(code: string) {
  const acc = homeAccount();
  if (!acc) throw new Error("not signed in");
  const w = await call(acc, `/api/invites/${code}`, {});
  await refresh(acc);
  activate(`${acc.id}/${w.id}`);
}

export const invite = (code: string): Promise<{ workspace: string; by: string; signup: boolean }> => call({ server: here }, `/api/invites/${code}`);
export const serverInfo = (server = here): Promise<{ signup: "open" | "invite" | "off"; firstAccount: boolean; agent: boolean }> => call({ server }, "/api/info");

/** An MCP token for agents on a workspace, with the ready-made commands. */
export const mcpToken = (s: Space) => call(accountOf(s), `/api/workspaces/${s.id}/mcp-token`, {});

// ---------- another server ----------

/**
 * Add an account of another server: its own page signs in and asks for consent (#/connect),
 * then sends a token of its own back here (#/connected). The password never reaches this page.
 */
export function connectServer(address: string) {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(address) ? address : `https://${address}`);
  } catch {
    throw new Error("bad address");
  }
  location.href = `${url.origin}/#/connect?app=${encodeURIComponent(here)}`;
}

/** On the other server's page: a token for the app at `app`, sent back there. */
export async function grant(app: string) {
  const acc = homeAccount();
  if (!acc) throw new Error("not signed in");
  const { token } = await call(acc, "/api/account/session", {});
  location.href = `${app}/#/connected?server=${encodeURIComponent(here)}&token=${encodeURIComponent(token)}`;
}

/** Back here with a token from another server. */
export async function connected(server: string, token: string) {
  await addAccount(server, token);
}

// the workspace open at the last start; the others open when they are first shown
if (activeSpace()) activate(active!);
else if (spaces[0]) activate(spaces[0].key);
