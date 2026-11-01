// How people sign in on this server, from the environment (see .env.example). OBTION_LOGIN lists
// the ways: password, code (by email), passkey; default "password,passkey". OAuth providers (any
// OpenID Connect provider, GitHub, Google) come with their own settings. Sending mail (SMTP) is a
// setting of its own: it switches nothing on.
import { createTransport } from "nodemailer";
import type { LoginMethods } from "@obtion/core/api";

export interface OAuthProvider {
  /** oidc (generic OpenID Connect), github, google */
  id: "oidc" | "github" | "google";
  /** the button's label */
  name: string;
  clientId: string;
  clientSecret: string;
  /** oidc: the provider's discovery document */
  discoveryUrl?: string;
}

/** Sends a sign-in code. */
export type SendCode = (to: string, code: string, lang: string | undefined) => Promise<void>;

export interface LoginConfig {
  password: boolean;
  /** codes by email: how they are sent */
  sendCode?: SendCode;
  /** passkeys: bound to one host name, the public one */
  passkey?: { rpID: string; origin: string };
  oauth: OAuthProvider[];
}

/** The ways OBTION_LOGIN can list. */
const WAYS = ["password", "code", "passkey"] as const;
const DEFAULT_LOGIN = "password,passkey";

const MAIL = {
  de: { subject: (code: string) => `${code} ist dein Anmeldecode für Obtion`, body: (code: string, host: string) => `Dein Code für die Anmeldung bei ${host}:\n\n${code}\n\nEr gilt 10 Minuten. Wenn du dich nicht anmelden wolltest, ignoriere diese E-Mail.` },
  en: { subject: (code: string) => `${code} is your Obtion sign-in code`, body: (code: string, host: string) => `Your code for signing in at ${host}:\n\n${code}\n\nIt is valid for 10 minutes. If you did not try to sign in, ignore this email.` },
};

/** Codes by email: over SMTP, or (OBTION_SMTP_URL=log) into the server's log for whoever reads it. */
function mailer(env: Record<string, string | undefined>, host: string): SendCode | undefined {
  const url = env.OBTION_SMTP_URL?.trim();
  if (!url) return undefined;
  if (url === "log")
    return async (to, code) => {
      console.log(`[obtion] sign-in code for ${to}: ${code}`);
    };
  const from = env.OBTION_MAIL_FROM?.trim() || `Obtion <obtion@${host.replace(/:\d+$/, "")}>`;
  const transport = createTransport(url);
  return async (to, code, lang) => {
    const m = lang === "en" ? MAIL.en : MAIL.de;
    await transport.sendMail({ from, to, subject: m.subject(code), text: m.body(code, host) }).catch((e: unknown) => {
      console.error(`[obtion] could not send the sign-in code to ${to}:`, e instanceof Error ? e.message : e);
    });
  };
}

/**
 * The sign-in methods the environment sets up. `publicUrl`: OBTION_PUBLIC_URL (passkeys and OAuth
 * need it). Throws when the settings cannot work (codes without a way to send them, no way to sign up).
 */
export function loginConfig(env: Record<string, string | undefined>, publicUrl: string): LoginConfig {
  const pub = publicUrl ? new URL(publicUrl) : undefined;
  const listed = env.OBTION_LOGIN?.trim();
  const ways = new Set((listed || DEFAULT_LOGIN).split(",").map((w) => w.trim().toLowerCase()).filter(Boolean));
  for (const w of ways) if (!(WAYS as readonly string[]).includes(w)) console.warn(`[obtion] OBTION_LOGIN: unknown way "${w}" (known: ${WAYS.join(", ")})`);
  const oauth: OAuthProvider[] = [];
  const issuer = env.OBTION_OIDC_ISSUER?.trim();
  if (issuer && env.OBTION_OIDC_CLIENT_ID)
    oauth.push({
      id: "oidc",
      name: env.OBTION_OIDC_NAME?.trim() || "SSO",
      clientId: env.OBTION_OIDC_CLIENT_ID,
      clientSecret: env.OBTION_OIDC_CLIENT_SECRET ?? "",
      discoveryUrl: issuer.includes("/.well-known/") ? issuer : `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
    });
  if (env.OBTION_GITHUB_CLIENT_ID && env.OBTION_GITHUB_CLIENT_SECRET)
    oauth.push({ id: "github", name: "GitHub", clientId: env.OBTION_GITHUB_CLIENT_ID, clientSecret: env.OBTION_GITHUB_CLIENT_SECRET });
  if (env.OBTION_GOOGLE_CLIENT_ID && env.OBTION_GOOGLE_CLIENT_SECRET)
    oauth.push({ id: "google", name: "Google", clientId: env.OBTION_GOOGLE_CLIENT_ID, clientSecret: env.OBTION_GOOGLE_CLIENT_SECRET });
  if (oauth.length && !pub) console.warn("[obtion] OAuth needs OBTION_PUBLIC_URL (the address the provider sends people back to); it stays off");
  let sendCode: SendCode | undefined;
  if (ways.has("code")) {
    sendCode = mailer(env, pub?.host ?? "Obtion");
    if (!sendCode) throw new Error("OBTION_LOGIN has code, but there is no way to send mail: set OBTION_SMTP_URL (or OBTION_SMTP_URL=log to print the codes in the server log)");
  }
  // browsers have passkeys only in a secure context: https, or localhost
  const secure = !!pub && (pub.protocol === "https:" || pub.hostname === "localhost");
  if (ways.has("passkey") && !secure && listed) console.warn("[obtion] passkeys need OBTION_PUBLIC_URL with https (or localhost); they stay off");
  const config: LoginConfig = {
    password: ways.has("password"),
    sendCode,
    passkey: ways.has("passkey") && secure ? { rpID: pub!.hostname, origin: pub!.origin } : undefined,
    oauth: pub ? oauth : [],
  };
  // passkeys are added to an account: someone has to be able to make one first
  if (!config.password && !config.sendCode && !config.oauth.length)
    throw new Error("OBTION_LOGIN needs password or code (or an OAuth provider): otherwise nobody can create an account");
  return config;
}

/** What the sign-in page offers (GET /api/info). */
export const loginMethods = (c: LoginConfig): LoginMethods => ({
  password: c.password,
  emailCode: !!c.sendCode,
  passkey: !!c.passkey,
  oauth: c.oauth.map((p) => ({ id: p.id, name: p.name })),
});
