// The account signed in on the server that served this app, and its workspaces ("spaces" here).
// Each workspace is a replica of its own with its own storage on this device; one is open in the
// app (`repo` and `files` point at it), the others sync alongside and show in the sidebar. Kept on
// this device: the account with its token, the last known workspaces (so the app opens offline)
// and which one is open.
import { useSyncExternalStore } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Repo } from "@obtion/sync";
import type { AccountInfo, ErrorBody, InviteCode, InviteInfo, LoginMethods, McpConnect, Member, Ok, PasskeyInfo, ServerInfo, SignedIn, User, WorkspaceInfo } from "@obtion/core/api";
import type { T } from "@obtion/core/i18n";
import { browserHost, storageNames, type SpaceLink } from "./browser";
import { DeviceFiles, setFiles } from "./files";
import { setRepo } from "./repo";
import { globalPage } from "./scope";
import { KEYS } from "./ui/storage";
import { navigate, parseHash, spaceHref } from "./hooks";

export interface Account {
  token: string;
  user: User;
  admin?: boolean;
  /** the account can sign in with a password */
  password?: boolean;
  /** the server no longer accepts the token: sign in again */
  lost?: boolean;
}

export type Space = WorkspaceInfo;

const read = <T>(k: string, def: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(k) ?? "null") as T) ?? def;
  } catch {
    return def;
  }
};

// the app could hold accounts of other servers for a day (2026-10-27): keep the one of this server
if (localStorage.getItem(KEYS.legacyAccounts)) {
  const mine = read<{ server: string }[]>(KEYS.legacyAccounts, []).find((a) => a.server === location.origin);
  if (mine) localStorage.setItem(KEYS.account, JSON.stringify(mine));
  for (const k of [KEYS.legacyAccounts, KEYS.spaces, KEYS.active]) localStorage.removeItem(k);
}

let account: Account | null = read(KEYS.account, null);
let spaces: Space[] = read(KEYS.spaces, []);
let active: string | null = localStorage.getItem(KEYS.active);
/** The workspaces chosen to be seen (sidebar, inbox) on this device; null: all. */
let shown: string[] | null = read(KEYS.shown, null);
let version = 0;
const listeners = new Set<() => void>();

function save() {
  localStorage.setItem(KEYS.account, JSON.stringify(account));
  localStorage.setItem(KEYS.spaces, JSON.stringify(spaces));
  if (active) localStorage.setItem(KEYS.active, active);
  else localStorage.removeItem(KEYS.active);
  localStorage.setItem(KEYS.shown, JSON.stringify(shown));
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

/** The id of the account signed in now. */
export const activeUser = () => account?.user.id;
export const activeSpace = () => spaces.find((s) => s.id === active);
export const spaceById = (id: string) => spaces.find((s) => s.id === id);

// ---------- replicas ----------

const open = new Map<string, { repo: Repo; files: DeviceFiles }>();

function link(s: Space): SpaceLink {
  return { base: `${location.origin}/w/${s.id}`, token: account!.token, storage: storageNames(s) };
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
function activate(id: string) {
  if (!spaces.some((s) => s.id === id)) return;
  const r = replica(id);
  setRepo(r.repo);
  setFiles(r.files);
  if (active !== id) {
    active = id;
    save();
  }
}

// ---------- account ----------

/** A call of the server's API that failed: the HTTP status and the server's error. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call<R>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", token = account?.token): Promise<R> {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as Partial<ErrorBody> | null)?.error ?? res.statusText, res.status);
  return data as R;
}

/** A workspace's API (/w/<id>/api/…). */
export const spaceCall = <R>(id: string, path: string) => call<R>(`/w/${id}${path}`);

/** What to tell the user when a call failed: signing in or up, a workspace action, deleting the account, changing the password. */
export function errorText(e: unknown, t: T, what: "signIn" | "code" | "space" | "deleteAccount" | "password"): string {
  const status = e instanceof ApiError ? e.status : undefined;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 429) return t("account.tooMany");
  if (what === "code") return status === 403 ? t("account.closed") : status === 400 ? t("account.codeWrong") : status ? message : t("account.offline");
  if (what === "signIn") return status === 401 ? t("account.wrong") : status === 409 || status === 422 ? t("account.exists") : status === 403 ? t("account.closed") : message;
  if (what === "password") return message === "invalid password" ? t("account.deletePassword") : message === "password too long" ? t("account.passwordLong") : status === 400 ? t("account.passwordShort") : t("account.offline");
  if (what === "deleteAccount") return t(message === "last owner" ? "account.deleteOwner" : message === "invalid password" ? "account.deletePassword" : "account.offline");
  return message === "last owner" ? t("space.lastOwner") : message;
}

/** Ask the server for the account's workspaces (and whether the token still counts). */
export async function refresh() {
  if (!account) return;
  let gone: Space[] = [];
  try {
    const me = await call<AccountInfo>("/api/account");
    Object.assign(account, { user: me.user, admin: me.admin, password: me.password, lost: false });
    const known = new Map(spaces.map((s) => [s.id, s]));
    // gone on the server (deleted, or this account removed): the copy here goes too
    gone = spaces.filter((s) => !me.workspaces.some((w) => w.id === s.id));
    spaces = me.workspaces.map((w) => ({ ...known.get(w.id), ...w }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) account.lost = true;
    else return; // offline: keep what is known
  }
  if (!activeSpace() && spaces[0]) activate(spaces[0].id);
  save();
  // deleting makes open replicas reload the page: last
  for (const s of gone) await forget(s);
}

/**
 * Keep the account signed in with `token`. Another one signed in before leaves first; the same one
 * signed in again (to confirm it is them) keeps its workspaces and ends the session before.
 */
async function keep(token: string) {
  const me = await call<AccountInfo>("/api/account", undefined, "GET", token);
  if (account && account.user.id !== me.user.id) await forgetAll();
  else if (account && account.token !== token && !account.lost) await call<Ok>("/api/account/signout", {}).catch(() => {});
  account = { token, user: me.user };
  await refresh();
}

/** The ways to sign in a server offers (an older server: only the password). */
export const loginOf = (info: ServerInfo | null): LoginMethods => info?.login ?? { password: true, emailCode: false, passkey: false, oauth: [] };

/**
 * What an account created by a code or OAuth comes with (the server reads it when it creates the
 * user): the invite it joins with, the app's language for its personal workspace.
 */
function signupContext(invite: string | undefined, lang: string) {
  document.cookie = `obtion_signup=${encodeURIComponent(JSON.stringify({ invite, lang }))}; path=/api/auth; max-age=1800; samesite=lax`;
}

export async function signIn(email: string, password: string) {
  const res = await call<SignedIn>("/api/auth/sign-in/email", { email, password });
  await keep(res.token);
}

/** Create an account – with an invite it joins that workspace instead of getting one of its own. */
export async function signUp(b: { name: string; email: string; password: string; invite?: string; lang: string }) {
  const res = await call<SignedIn>("/api/account/signup", b);
  await keep(res.token);
}

/** Send a sign-in code to `email` (an address without an account gets one where it may sign up). */
export async function sendCode(email: string, ctx: { invite?: string; lang: string }) {
  signupContext(ctx.invite, ctx.lang);
  await call<Ok>("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
}

/** Sign in with the code from the email; a new address becomes an account named `name`. */
export async function signInWithCode(email: string, otp: string, name: string | undefined, ctx: { invite?: string; lang: string }) {
  signupContext(ctx.invite, ctx.lang);
  const res = await call<SignedIn>("/api/auth/sign-in/email-otp", { email, otp: otp.trim(), ...(name?.trim() ? { name: name.trim() } : {}) });
  await keep(res.token);
}

/** Sign in with a passkey of this device (or a phone nearby). */
export async function signInWithPasskey() {
  const optionsJSON = await call<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/auth/passkey/generate-authenticate-options");
  const response = await startAuthentication({ optionsJSON });
  const res = await call<{ session: { token: string } }>("/api/auth/passkey/verify-authentication", { response });
  await keep(res.session.token);
}

const OAUTH_RETURN = "obtion.oauthReturn";

/**
 * Sign in (or up) with an OAuth provider: the page goes there and comes back to "/?signin=oauth",
 * where finishOAuth takes over.
 */
export async function signInWithOAuth(provider: string, ctx: { invite?: string; lang: string }) {
  signupContext(ctx.invite, ctx.lang);
  sessionStorage.setItem(OAUTH_RETURN, location.hash);
  const urls = { callbackURL: "/?signin=oauth", errorCallbackURL: "/?signin=failed" };
  const res = await call<{ url: string }>("/api/auth/sign-in/social", { provider, ...urls });
  location.href = res.url;
}

/** The last OAuth sign-in failed: "closed" (no account here and none may be made), or "failed". */
export let oauthFailed: "closed" | "failed" | undefined;

/** Back from the OAuth provider: the session it left in a cookie becomes this app's token. */
async function finishOAuth() {
  const params = new URLSearchParams(location.search);
  const how = params.get("signin");
  if (!how) return;
  const back = sessionStorage.getItem(OAUTH_RETURN) ?? location.hash;
  sessionStorage.removeItem(OAUTH_RETURN);
  history.replaceState(history.state, "", location.pathname + back);
  document.cookie = "obtion_signup=; path=/api/auth; max-age=0";
  if (how !== "oauth") return void (oauthFailed = /^(signup_closed|invite_invalid)$/.test(params.get("error") ?? "") ? "closed" : "failed");
  try {
    const res = await call<SignedIn>("/api/account/claim", {});
    await keep(res.token);
  } catch {
    oauthFailed = "failed";
    save();
  }
}

// ---------- passkeys ----------

export const passkeys = () => call<PasskeyInfo[]>("/api/auth/passkey/list-user-passkeys");

/** Add a passkey of this device to the account. Needs a sign-in of the last minutes (403: confirm first). */
export async function addPasskey() {
  const optionsJSON = await call<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/passkey/generate-register-options");
  const response = await startRegistration({ optionsJSON });
  await call<Ok>("/api/auth/passkey/verify-registration", { response, name: deviceLabel() });
}

export const removePasskey = (id: string) => call<Ok>("/api/auth/passkey/delete-passkey", { id });

/** A passkey's name: the device it was made on, as far as the browser tells. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [browser, os].filter(Boolean).join(" · ") || "Passkey";
}

/** Sign out: the workspaces leave this device, with their local copies. */
export async function signOut() {
  await call<Ok>("/api/account/signout", {}).catch(() => {});
  await forgetAll();
  save();
  navigate("/", { replace: true });
  location.reload();
}

/** Change the password. The other devices are signed out; this one stays signed in. */
export async function changePassword(current: string, next: string) {
  await call<Ok>("/api/account/password", { current, next });
}

/**
 * Delete the account on this server, then remove this device's workspace copies. Proof: the
 * password, or without one a sign-in of the last minutes (403 "sign in again": confirm first).
 */
export async function deleteAccount(password?: string) {
  await call<Ok>("/api/account", password === undefined ? {} : { password }, "DELETE");
  await forgetAll();
  save();
  navigate("/", { replace: true });
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
  const names = storageNames(s);
  open.delete(s.id);
  await Promise.all([names.replica, names.files].map((db) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(db);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  })));
  const root = await navigator.storage?.getDirectory?.().catch(() => undefined);
  await root?.removeEntry(names.blobs, { recursive: true }).catch(() => {});
}

// ---------- workspaces ----------

export async function createSpace(name: string) {
  const w = await call<WorkspaceInfo>("/api/workspaces", { name });
  if (shown) shown = [...shown, w.id];
  await refresh();
  navigate("/setup", { space: w.id });
}

export async function renameSpace(s: Space, name: string) {
  await call<Ok>(`/api/workspaces/${s.id}`, { name }, "PATCH");
  await refresh();
}

/** An invite link: whoever opens it may join (with an account of this server). */
export async function inviteLink(s: Space): Promise<string> {
  const { code } = await call<InviteCode>(`/api/workspaces/${s.id}/invites`, {});
  return `${location.origin}/#/join/${code}`;
}

export function members(s: Space): Promise<Member[]> {
  return call(`/api/workspaces/${s.id}/members`);
}

export async function leaveSpace(s: Space) {
  await call<Ok>(`/api/workspaces/${s.id}/members/${account!.user.id}`, undefined, "DELETE");
  await forget(s);
  spaces = spaces.filter((x) => x.id !== s.id);
  if (active === s.id) active = spaces[0]?.id ?? null;
  save();
  navigate("/", { replace: true });
  location.reload();
}

/** Delete a workspace for good on the server (owners only; for every member). */
export async function deleteSpace(s: Space) {
  await call<Ok>(`/api/workspaces/${s.id}`, undefined, "DELETE");
  spaces = spaces.filter((x) => x.id !== s.id);
  if (active === s.id) active = spaces[0]?.id ?? null;
  save();
  await forget(s);
  navigate("/", { replace: true });
  location.reload();
}

export async function joinInvite(code: string) {
  const w = await call<WorkspaceInfo>(`/api/invites/${code}`, {});
  await refresh();
  activate(w.id);
}

export const invite = (code: string) => call<InviteInfo>(`/api/invites/${code}`);
export const serverInfo = () => call<ServerInfo>("/api/info");

/** An MCP token for agents on a workspace, with the ready-made commands. */
export const mcpToken = (s: Space) => call<McpConnect>(`/api/workspaces/${s.id}/mcp-token`, {});

/**
 * The address names the workspace ("#/w/<id>/…") and opens it. A page of a workspace without it
 * (a link inside the app) is the open workspace's and gets its name, so going back later returns
 * to it. Pages of no workspace (inbox, search, settings) keep an address without one.
 */
function followHash() {
  const { space: named, rest } = parseHash();
  if (named) {
    if (named !== active && spaces.some((s) => s.id === named)) activate(named);
  } else if (active && !globalPage((rest.split("?")[0] ?? "").split("/").filter(Boolean)))
    history.replaceState(history.state, "", spaceHref(active, rest));
}
addEventListener("hashchange", followHash);

await finishOAuth();

// the workspace open at the last start (or named by the address); the others open when they are first shown
if (activeSpace()) activate(active!);
else if (spaces[0]) activate(spaces[0].id);
followHash();
