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
  /** The server's data from before accounts; devices keep their local copy of it. */
  legacy?: boolean;
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

/** POST /api/account/signup with codes on and no code yet: a code was sent, sign up again with it. */
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
