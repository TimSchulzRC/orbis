// The signed-in account and its workspaces ("spaces"). Each workspace is its own replica with its own
// storage; one is open in the app, the others sync alongside. Kept in localStorage so the app opens offline.
import { useSyncExternalStore } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Repo } from "@obtion/sync";
import type { AccountInfo, ErrorBody, InviteCode, InviteInfo, InviteLink, InviteRequest, LoginMethods, McpConnect, Member, Ok, PasskeyInfo, Role, ServerInfo, SignedIn, User, VerifyFirst, WorkspaceInfo } from "@obtion/core/api";
import type { T } from "@obtion/core/i18n";
import { type FileMeta, SETTINGS_ID } from "@obtion/core/model";
import { runSetup } from "@obtion/core/setup";
import { type ExampleFile, exampleFiles, fileFacts, writeExamples } from "@obtion/core/examples";
import { firstName } from "@obtion/core/origin";
import { browserHost, storageNames, type SpaceLink } from "./browser";
import { DeviceFiles, setFiles } from "./files";
import { getLang } from "./i18n";
import { setRepo } from "./repo";
import { globalPage } from "./scope";
import { KEYS } from "./ui/storage";
import { navigate, parseHash, spaceHref } from "./hooks";

export interface Account {
  token: string;
  user: User;
  admin?: boolean;
  /** has a password to sign in with */
  password?: boolean;
  /** the server no longer accepts the token */
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
/** Workspaces shown on this device (sidebar, inbox); null = all. */
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
  // no choice made ("Alle"), as opposed to every workspace picked one by one
  const allSeen = !shown || !spaces.some((s) => shown!.includes(s.id));
  return { account, spaces, active: spaces.find((s) => s.id === active), shown: shownSpaces(), allSeen };
}

/** The workspaces chosen to be seen; never none (a choice that left none shows all). */
export function shownSpaces(): Space[] {
  const list = spaces.filter((s) => !shown || shown.includes(s.id));
  return list.length ? list : spaces;
}

/**
 * Picking every workspace is stored as "all" so new ones show too – unless `picked` (one by one via
 * the chips), which stays an explicit list.
 */
export function setShown(ids: string[], picked = false) {
  shown = !picked && spaces.every((s) => ids.includes(s.id)) ? null : ids;
  save();
}

export const activeUser = () => account?.user.id;
export const activeSpace = () => spaces.find((s) => s.id === active);
export const spaceById = (id: string) => spaces.find((s) => s.id === id);

const open = new Map<string, { repo: Repo; files: DeviceFiles }>();

function link(s: Space): SpaceLink {
  // read at each use: signing in again (to confirm it is them) gives the account a new token
  const first = account!.token;
  return { base: `${location.origin}/w/${s.id}`, get token() { return account?.token ?? first; }, person: { id: account!.user.id, name: firstName(account!.user) }, storage: storageNames(s) };
}

export function replica(id: string): { repo: Repo; files: DeviceFiles } {
  let entry = open.get(id);
  if (!entry) {
    const spaceLink = link(spaces.find((s) => s.id === id)!);
    const repo = new Repo(browserHost(spaceLink));
    entry = { repo, files: new DeviceFiles(repo, spaceLink) };
    open.set(id, entry);
    setUpWhenEmpty(id, entry);
    repo.init().catch((e) => console.error("could not open local storage", e));
  }
  return entry;
}

/** Workspaces created on this device and not set up yet; value: with examples. */
const created = new Map<string, boolean>();

/**
 * One created here is set up as soon as its storage is open; any other (made by the server or an
 * agent) only once it is in sync and still has no settings, so it isn't set up twice.
 */
function setUpWhenEmpty(id: string, { repo, files }: { repo: Repo; files: DeviceFiles }) {
  const off = repo.subscribe(() => {
    if (repo.get(SETTINGS_ID)) return void off();
    const examples = created.get(id);
    if (!repo.status.loaded || (examples === undefined && !repo.status.synced)) return;
    off();
    created.delete(id);
    void setUp(repo, files, examples ?? false);
  });
}

async function setUp(repo: Repo, files: DeviceFiles, examples: boolean) {
  const lang = getLang();
  // the files first (stored here, uploaded later), then everything in one go
  const metas: Partial<Record<ExampleFile["key"], FileMeta>> = {};
  if (examples)
    for (const f of exampleFiles(lang)) {
      const meta = await files.prepare(new Blob([f.bytes], { type: f.mime }), f.name);
      metas[f.key] = { ...fileFacts(f, meta.hash), ...meta };
    }
  // set up meanwhile by another device: the examples chosen here still come (they skip what is there)
  if (!repo.get(SETTINGS_ID)) runSetup(repo.writer, lang, repo.origin);
  if (examples) writeExamples(repo.writer, lang, metas);
}

/** Pending local changes while the server is reachable, in any open workspace. */
export function unsynced(): boolean {
  return [...open.values()].some(({ repo }) => repo.status.pending > 0 && repo.status.online);
}

function activate(id: string) {
  if (!spaces.some((s) => s.id === id)) return;
  const { repo, files } = replica(id);
  setRepo(repo);
  setFiles(files);
  if (active !== id) {
    active = id;
    save();
  }
}

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

export const spaceCall = <R>(id: string, path: string) => call<R>(`/w/${id}${path}`);

export function errorText(e: unknown, t: T, what: "signIn" | "code" | "space" | "deleteAccount" | "password"): string {
  const status = e instanceof ApiError ? e.status : undefined;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 429) return t("account.tooMany");
  switch (what) {
    case "code":
      if (status === 403) return t("account.closed");
      if (status === 400) return t("account.codeWrong");
      return status ? message : t("account.offline");
    case "signIn":
      if (status === 401) return t("account.wrong");
      if (status === 409 || status === 422) return t("account.exists");
      if (status === 403) return t("account.closed");
      return message;
    case "password":
      if (message === "invalid password") return t("account.deletePassword");
      if (message === "password too long") return t("account.passwordLong");
      return status === 400 ? t("account.passwordShort") : t("account.offline");
    case "deleteAccount":
      if (message === "last owner") return t("account.deleteOwner");
      if (message === "invalid password") return t("account.deletePassword");
      return t("account.offline");
    case "space":
      return message === "last owner" ? t("space.lastOwner") : message;
  }
}

/** Also marks the account `lost` when the server rejects the token. */
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
  // last: deleting makes open replicas reload the page
  for (const s of gone) await forget(s);
}

/**
 * A different account signed in before is forgotten first; the same one signing in again (to
 * confirm it is them) keeps its workspaces and ends the old session.
 */
async function keep(token: string) {
  const me = await call<AccountInfo>("/api/account", undefined, "GET", token);
  if (account && account.user.id !== me.user.id) await forgetAll();
  else if (account && account.token !== token && !account.lost) await call<Ok>("/api/account/signout", {}).catch(() => {});
  account = { token, user: me.user };
  await refresh();
}

/** Older servers send no `login`: password only. */
export const loginOf = (info: ServerInfo | null): LoginMethods => info?.login ?? { password: true, emailCode: false, passkey: false, oauth: [] };

/** The server reads this cookie when a code or OAuth sign-in creates the user. */
function signupContext(invite: string | undefined, lang: string) {
  document.cookie = `obtion_signup=${encodeURIComponent(JSON.stringify({ invite, lang }))}; path=/api/auth; max-age=1800; samesite=lax`;
}

export async function signIn(email: string, password: string) {
  const res = await call<SignedIn>("/api/auth/sign-in/email", { email, password });
  await keep(res.token);
}

/**
 * Where email codes are on, the address is verified first: without `code` a code is sent and the
 * result is "verify"; then call again with the code.
 */
export async function signUp(b: { name: string; email: string; password: string; invite?: string; lang: string; code?: string }): Promise<"verify" | undefined> {
  const res = await call<SignedIn | VerifyFirst>("/api/account/signup", b);
  if ("verify" in res) {
    await sendCode(b.email, { invite: b.invite, lang: b.lang });
    return "verify";
  }
  await keep(res.token);
}

/** An address without an account gets a code too where sign-up is open. */
export async function sendCode(email: string, ctx: { invite?: string; lang: string }) {
  signupContext(ctx.invite, ctx.lang);
  await call<Ok>("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
}

/** A new address becomes an account named `name`. */
export async function signInWithCode(email: string, otp: string, name: string | undefined, ctx: { invite?: string; lang: string }) {
  signupContext(ctx.invite, ctx.lang);
  const res = await call<SignedIn>("/api/auth/sign-in/email-otp", { email, otp: otp.trim(), ...(name?.trim() ? { name: name.trim() } : {}) });
  await keep(res.token);
}

export async function signInWithPasskey() {
  const optionsJSON = await call<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/auth/passkey/generate-authenticate-options");
  const response = await startAuthentication({ optionsJSON });
  const res = await call<{ session: { token: string } }>("/api/auth/passkey/verify-authentication", { response });
  await keep(res.session.token);
}

const OAUTH_RETURN = "obtion.oauthReturn";

/** Leaves the page; the provider returns to "/?signin=oauth", where finishOAuth takes over. */
export async function signInWithOAuth(provider: string, ctx: { invite?: string; lang: string }) {
  signupContext(ctx.invite, ctx.lang);
  sessionStorage.setItem(OAUTH_RETURN, location.hash);
  const urls = { callbackURL: "/?signin=oauth", errorCallbackURL: "/?signin=failed" };
  const res = await call<{ url: string }>("/api/auth/sign-in/social", { provider, ...urls });
  location.href = res.url;
}

/**
 * Why the last OAuth sign-in failed. "closed": no account and sign-up is closed; "notLinked": an
 * account has the address but hasn't linked this provider.
 */
export let oauthFailed: "closed" | "notLinked" | "failed" | undefined;
/** "taken": that provider account belongs to another account here. */
export let linkFailed: "taken" | "failed" | undefined;

/** The session the provider left in a cookie becomes this app's token. */
async function finishOAuth() {
  const params = new URLSearchParams(location.search);
  const how = params.get("signin");
  if (!how) return;
  const back = sessionStorage.getItem(OAUTH_RETURN) ?? location.hash;
  sessionStorage.removeItem(OAUTH_RETURN);
  history.replaceState(history.state, "", location.pathname + back);
  document.cookie = "obtion_signup=; path=/api/auth; max-age=0";
  if (how === "linked") return;
  const error = params.get("error") ?? "";
  if (how === "linkFailed") {
    linkFailed = error === "account_already_linked_to_different_user" ? "taken" : "failed";
    return;
  }
  if (how !== "oauth") {
    oauthFailed = oauthFailure(error);
    return;
  }
  try {
    const res = await call<SignedIn>("/api/account/claim", {});
    await keep(res.token);
  } catch {
    oauthFailed = "failed";
    save();
  }
}

function oauthFailure(error: string): NonNullable<typeof oauthFailed> {
  if (/^(signup_closed|invite_invalid)$/.test(error)) return "closed";
  if (error === "account_not_linked") return "notLinked";
  return "failed";
}

export const linkedProviders = () => call<{ providerId: string }[]>("/api/auth/list-accounts").then((l) => l.map((a) => a.providerId));

export async function linkOAuth(provider: string) {
  // the settings are a dialog: "#/settings" opens them again
  sessionStorage.setItem(OAUTH_RETURN, "#/settings");
  const res = await call<{ url: string }>("/api/auth/link-social", { provider, callbackURL: "/?signin=linked", errorCallbackURL: "/?signin=linkFailed" });
  location.href = res.url;
}

export const passkeys = () => call<PasskeyInfo[]>("/api/auth/passkey/list-user-passkeys");

/** Needs a recent sign-in (403: confirm first). */
export async function addPasskey() {
  const optionsJSON = await call<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/passkey/generate-register-options");
  const response = await startRegistration({ optionsJSON });
  await call<Ok>("/api/auth/passkey/verify-registration", { response, name: deviceLabel() });
}

export const removePasskey = (id: string) => call<Ok>("/api/auth/passkey/delete-passkey", { id });

/** First match wins: an iPad's agent also says "Mac", Chrome's also says "Safari". */
const OS_NAMES: [RegExp, string][] = [[/iPhone|iPad/, "iOS"], [/Android/, "Android"], [/Mac/, "macOS"], [/Windows/, "Windows"], [/Linux/, "Linux"]];
const BROWSER_NAMES: [RegExp, string][] = [[/Edg\//, "Edge"], [/Firefox\//, "Firefox"], [/Chrome\//, "Chrome"], [/Safari\//, "Safari"]];

const nameIn = (ua: string, names: [RegExp, string][]) => names.find(([pattern]) => pattern.test(ua))?.[1] ?? "";

function deviceLabel(): string {
  const ua = navigator.userAgent;
  return [nameIn(ua, BROWSER_NAMES), nameIn(ua, OS_NAMES)].filter(Boolean).join(" · ") || "Passkey";
}

export async function signOut() {
  await call<Ok>("/api/account/signout", {}).catch(() => {});
  await forgetAll();
  save();
  restart();
}

/** Back to the start page, loaded afresh. */
function restart() {
  navigate("/", { replace: true });
  location.reload();
}

/** The server signs out the other devices; this one stays signed in. */
export async function changePassword(current: string, next: string) {
  await call<Ok>("/api/account/password", { current, next });
}

/** Proof is the password, or without one a recent sign-in (403: confirm first). */
export async function deleteAccount(password?: string) {
  await call<Ok>("/api/account", password === undefined ? {} : { password }, "DELETE");
  await forgetAll();
  save();
  restart();
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

export async function createSpace(name: string, examples: boolean) {
  const w = await call<WorkspaceInfo>("/api/workspaces", { name });
  created.set(w.id, examples);
  if (shown) shown = [...shown, w.id];
  await refresh();
  navigate("/", { space: w.id });
}

export async function renameSpace(s: Space, name: string) {
  await call<Ok>(`/api/workspaces/${s.id}`, { name }, "PATCH");
  await refresh();
}

export const joinUrl = (code: string) => `${location.origin}/#/join/${code}`;

/** Owners only; a link is for one person. */
export async function inviteLink(s: Space, opts: InviteRequest = {}): Promise<string> {
  const { code } = await call<InviteCode>(`/api/workspaces/${s.id}/invites`, opts);
  return joinUrl(code);
}

/** Owners only; only links that still work. */
export const inviteLinks = (s: Space) => call<InviteLink[]>(`/api/workspaces/${s.id}/invites`);

export const revokeInvite = (s: Space, code: string) => call<Ok>(`/api/workspaces/${s.id}/invites/${code}`, undefined, "DELETE");

export function members(s: Space): Promise<Member[]> {
  return call(`/api/workspaces/${s.id}/members`);
}

/** Owners only. */
export const setRole = (s: Space, user: string, role: Role) => call<Ok>(`/api/workspaces/${s.id}/members/${user}`, { role }, "PATCH");

/** Owners only; their devices stop syncing it. */
export const removeMember = (s: Space, user: string) => call<Ok>(`/api/workspaces/${s.id}/members/${user}`, undefined, "DELETE");

export async function leaveSpace(s: Space) {
  await call<Ok>(`/api/workspaces/${s.id}/members/${account!.user.id}`, undefined, "DELETE");
  await forget(s);
  dropFromList(s);
  save();
  restart();
}

/** Owners only; deletes it for every member. */
export async function deleteSpace(s: Space) {
  await call<Ok>(`/api/workspaces/${s.id}`, undefined, "DELETE");
  dropFromList(s);
  save();
  await forget(s);
  restart();
}

/** If it was the open one, the first remaining workspace opens instead. */
function dropFromList(s: Space) {
  spaces = spaces.filter((other) => other.id !== s.id);
  if (active === s.id) active = spaces[0]?.id ?? null;
}

export async function joinInvite(code: string) {
  const w = await call<WorkspaceInfo>(`/api/invites/${code}`, {});
  await refresh();
  activate(w.id);
}

export const invite = (code: string) => call<InviteInfo>(`/api/invites/${code}`);
export const serverInfo = () => call<ServerInfo>("/api/info");

export const mcpToken = (s: Space) => call<McpConnect>(`/api/workspaces/${s.id}/mcp-token`, {});

/**
 * A workspace page without "#/w/<id>" (a link inside the app) gets the open workspace's id, so going
 * back later returns to it. Global pages (inbox, search, settings) stay without one.
 */
function followHash() {
  const { space: named, rest } = parseHash();
  if (named) {
    if (named !== active && spaces.some((s) => s.id === named)) activate(named);
    return;
  }
  const parts = (rest.split("?")[0] ?? "").split("/").filter(Boolean);
  if (active && !globalPage(parts)) history.replaceState(history.state, "", spaceHref(active, rest));
}
addEventListener("hashchange", followHash);

await finishOAuth();

// only the active workspace opens now; the others open when first shown
if (activeSpace()) activate(active!);
else if (spaces[0]) activate(spaces[0].id);
followHash();
