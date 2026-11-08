// HTTP API types shared by server and app. Errors come as JSON { error } with their status.

/** The first account may always sign up, whatever the policy. */
export type SignupPolicy = "open" | "invite" | "off";

export type Role = "owner" | "member";

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  role: Role;
}

export interface Member extends User {
  role: Role;
}

export interface ErrorBody {
  error: string;
}

export interface Ok {
  ok: true;
}

/** Each method is enabled by the server admin (.env.example). */
export interface LoginMethods {
  password: boolean;
  emailCode: boolean;
  passkey: boolean;
  /** oidc (any OpenID Connect provider), github, google */
  oauth: { id: string; name: string }[];
}

/** GET /api/info */
export interface ServerInfo {
  signup: SignupPolicy;
  firstAccount: boolean;
  login: LoginMethods;
  version: string;
  commit: string;
}

/** GET /api/account */
export interface AccountInfo {
  user: User;
  admin: boolean;
  /** the account has a password set */
  password: boolean;
  workspaces: WorkspaceInfo[];
}

/** One passkey of the account (GET /api/auth/passkey/list-user-passkeys). */
export interface PasskeyInfo {
  id: string;
  name?: string | null;
  createdAt: string;
}

/** POST /api/account/signup */
export interface SignupRequest {
  name?: string;
  email?: string;
  password?: string;
  invite?: string;
  /** language of the email with the code */
  lang?: string;
  /** when email codes are on: the code sent to the address (the first answer is { verify: true }) */
  code?: string;
}

/** POST /api/account/signup with codes on and no code yet: request a code for the address, then sign up again with it. */
export interface VerifyFirst {
  verify: true;
}

/** POST /api/account/signup, POST /api/account/claim and POST /api/auth/sign-in/(email|email-otp) */
export interface SignedIn {
  token: string;
  user: User;
}

/** GET /api/invites/<code> */
export interface InviteInfo {
  workspace: string;
  by: string;
  role: Role;
  signup: boolean;
}

/** POST /api/workspaces/<id>/invites (role defaults to member). A link works for one person. */
export interface InviteRequest {
  role?: Role;
}

/** POST /api/workspaces/<id>/invites */
export interface InviteCode {
  code: string;
}

/** GET /api/workspaces/<id>/invites (owners only): a link that still works. */
export interface InviteLink {
  code: string;
  /** "" if the creator's account is gone */
  by: string;
  created: number;
  expires: number;
  role: Role;
}

/** POST /api/workspaces/<id>/mcp-token. The token is shown only once. */
export interface McpConnect {
  mcpUrl: string;
  token: string;
  claudeCode: string;
  json: unknown;
  vault: string;
}

/** POST /w/<id>/api/undo */
export interface UndoRequest {
  step: string;
  device?: string;
}

export interface UndoResult {
  step: string; // the new step that did the undo
  undid: string; // the step that was taken back
  changed: string[]; // documents changed back
  trashed: string[]; // documents the step had created
  kept: { doc: string; field: string }[]; // changed again later: newer value kept
}

/** POST /w/<id>/api/purge: one item from the trash, or everything in it (`all`). */
export type PurgeRequest = { id: string } | { all: true };

export interface PurgeResult {
  purged: string[]; // every document deleted for good
}

/** One kept version of an item's text (GET /w/<id>/api/history?doc=<doc>). */
export interface TextVersion {
  id: number;
  /** its number among the item's versions, from 1 (oldest) */
  n: number;
  ts: number;
  /** who made it */
  origin: string;
  step?: string;
  /** the activity entry it belongs to */
  event?: number;
  /** its length in characters */
  len: number;
}

/** GET /w/<id>/api/history?doc=<doc> */
export interface HistoryList {
  versions: TextVersion[];
}

/** GET /w/<id>/api/history?version=<id> */
export interface VersionText {
  text: string;
}

/** GET /w/<id>/api/history?event=<id>: what an activity entry did to the text. */
export interface EventText {
  doc: string;
  before: string;
  after: string;
  /** the numbers of the versions compared (no `from`: the text was empty before) */
  from?: number;
  to: number;
}
