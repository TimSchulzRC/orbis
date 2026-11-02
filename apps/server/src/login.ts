// Sign-in methods from the environment (see .env.example). SMTP settings alone switch nothing on.
import { createTransport } from "nodemailer";
import type { LoginMethods } from "@obtion/core/api";

export interface OAuthProvider {
  id: "oidc" | "github" | "google";
  /** button label */
  name: string;
  clientId: string;
  clientSecret: string;
  /** oidc only */
  discoveryUrl?: string;
}

export type SendCode = (to: string, code: string, lang: string | undefined) => Promise<void>;

export interface LoginConfig {
  password: boolean;
  sendCode?: SendCode;
  /** bound to the public host name */
  passkey?: { rpID: string; origin: string };
  oauth: OAuthProvider[];
}

const WAYS = ["password", "code", "passkey"] as const;
const DEFAULT_LOGIN = "password,passkey";

const MAIL = {
  de: { subject: (code: string) => `${code} ist dein Anmeldecode für Obtion`, body: (code: string, host: string) => `Dein Code für die Anmeldung bei ${host}:\n\n${code}\n\nEr gilt 10 Minuten. Wenn du dich nicht anmelden wolltest, ignoriere diese E-Mail.` },
  en: { subject: (code: string) => `${code} is your Obtion sign-in code`, body: (code: string, host: string) => `Your code for signing in at ${host}:\n\n${code}\n\nIt is valid for 10 minutes. If you did not try to sign in, ignore this email.` },
};

// OBTION_SMTP_URL=log prints the codes to the server log instead of sending mail.
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
    const mail = lang === "en" ? MAIL.en : MAIL.de;
    await transport.sendMail({ from, to, subject: mail.subject(code), text: mail.body(code, host) }).catch((e: unknown) => {
      console.error(`[obtion] could not send the sign-in code to ${to}:`, e instanceof Error ? e.message : e);
    });
  };
}

/** Throws when the settings cannot work, e.g. codes without a mailer or no way to sign up. */
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
  // a passkey can create an account too (with an address), but only where the browser offers passkeys
  if (!config.password && !config.sendCode && !config.passkey && !config.oauth.length)
    throw new Error("OBTION_LOGIN needs password, code or passkey (passkeys need OBTION_PUBLIC_URL with https), or an OAuth provider: otherwise nobody can create an account");
  return config;
}

export const loginMethods = (c: LoginConfig): LoginMethods => ({
  password: c.password,
  emailCode: !!c.sendCode,
  passkey: !!c.passkey,
  oauth: c.oauth.map((p) => ({ id: p.id, name: p.name })),
});
