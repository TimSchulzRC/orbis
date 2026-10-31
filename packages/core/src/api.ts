// The HTTP API of a server as server and app both see it: accounts and workspaces (/api/…) and
// the undo of a workspace (/w/<id>/api/undo). Errors come as JSON { error } with their status.

/** Who may create an account: anyone, only with an invite link, or nobody (the first account always may). */
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
  /** The data of the server from before accounts: devices keep their local copy of it. */
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

/** How one can sign in on a server (each set up by its admin, see .env.example). */
export interface LoginMethods {
  password: boolean;
  /** a code sent by email */
  emailCode: boolean;
  passkey: boolean;
  /** OAuth providers: oidc (any OpenID Connect provider), github, google */
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
  /** the account can sign in with a password */
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
  lang?: string;
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
  signup: boolean;
}

/** POST /api/workspaces/<id>/invites */
export interface InviteCode {
  code: string;
}

/** POST /api/workspaces/<id>/mcp-token: a token for agents on the workspace, shown once, with the ready-made commands. */
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
  redo?: boolean;
  device?: string;
}

export interface UndoResult {
  step: string; // the new step that did the undo
  undid: string; // the step that was taken back
  changed: string[]; // documents changed back
  trashed: string[]; // documents the step had created
  kept: { doc: string; field: string }[]; // changed again later: newer value kept
}
