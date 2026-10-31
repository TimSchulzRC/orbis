// How people sign in on this server, from the environment (see .env.example): password, codes by
// email, passkeys, OAuth (any OpenID Connect provider, GitHub, Google). Everything but the password
// needs settings of its own, so a server without them keeps working as before.
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

const off = (v: string | undefined) => /^(off|0|false|no)$/i.test(v ?? "");

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

/** The sign-in methods the environment sets up. `publicUrl`: OBTION_PUBLIC_URL (passkeys and OAuth need it). */
export function loginConfig(env: Record<string, string | undefined>, publicUrl: string): LoginConfig {
  const pub = publicUrl ? new URL(publicUrl) : undefined;
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
  const sendCode = mailer(env, pub?.host ?? "Obtion");
  const config: LoginConfig = {
    password: !off(env.OBTION_PASSWORD),
    sendCode,
    // browsers have passkeys only in a secure context: https, or localhost
    passkey: pub && !off(env.OBTION_PASSKEYS) && (pub.protocol === "https:" || pub.hostname === "localhost") ? { rpID: pub.hostname, origin: pub.origin } : undefined,
    oauth: pub ? oauth : [],
  };
  // a server nobody can sign in to helps no one: the password stays on then
  if (!config.password && !config.sendCode && !config.oauth.length) {
    console.warn("[obtion] OBTION_PASSWORD=off needs another way to sign up (OBTION_SMTP_URL or OAuth); passwords stay on");
    config.password = true;
  }
  return config;
}

/** What the sign-in page offers (GET /api/info). */
export const loginMethods = (c: LoginConfig): LoginMethods => ({
  password: c.password,
  emailCode: !!c.sendCode,
  passkey: !!c.passkey,
  oauth: c.oauth.map((p) => ({ id: p.id, name: p.name })),
});
