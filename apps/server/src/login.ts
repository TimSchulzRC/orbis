// Sign-in methods from the environment (see .env.example). SMTP settings alone switch nothing on.

import type { LoginMethods } from "@orbis/core/api";
import { type Lang, translate } from "@orbis/core/i18n";
import { createTransport } from "nodemailer";

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

// ORBIS_SMTP_URL=log prints the codes to the server log instead of sending mail.
function mailer(env: Record<string, string | undefined>, host: string): SendCode | undefined {
	const url = env.ORBIS_SMTP_URL?.trim();
	if (!url) return undefined;
	if (url === "log")
		return (to, code) => {
			console.log(`[orbis] sign-in code for ${to}: ${code}`);
			return Promise.resolve();
		};
	const from = env.ORBIS_MAIL_FROM?.trim() || `Orbis <orbis@${host.replace(/:\d+$/, "")}>`;
	const transport = createTransport(url);
	return async (to, code, lang) => {
		const l: Lang = lang === "en" ? "en" : "de";
		await transport
			.sendMail({
				from,
				to,
				subject: translate(l, "mail.code.subject", { code }),
				text: translate(l, "mail.code.body", { code, host }),
			})
			.catch((e: unknown) => {
				console.error(
					`[orbis] could not send the sign-in code to ${to}:`,
					e instanceof Error ? e.message : e,
				);
			});
	};
}

/** Throws when the settings cannot work, e.g. codes without a mailer or no way to sign up. */
export function loginConfig(
	env: Record<string, string | undefined>,
	publicUrl: string,
): LoginConfig {
	const pub = publicUrl ? new URL(publicUrl) : undefined;
	const listed = env.ORBIS_LOGIN?.trim();
	const ways = new Set(
		(listed || DEFAULT_LOGIN)
			.split(",")
			.map((w) => w.trim().toLowerCase())
			.filter(Boolean),
	);
	for (const w of ways)
		if (!(WAYS as readonly string[]).includes(w))
			console.warn(`[orbis] ORBIS_LOGIN: unknown way "${w}" (known: ${WAYS.join(", ")})`);
	const oauth: OAuthProvider[] = [];
	const issuer = env.ORBIS_OIDC_ISSUER?.trim();
	if (issuer && env.ORBIS_OIDC_CLIENT_ID)
		oauth.push({
			id: "oidc",
			name: env.ORBIS_OIDC_NAME?.trim() || "SSO",
			clientId: env.ORBIS_OIDC_CLIENT_ID,
			clientSecret: env.ORBIS_OIDC_CLIENT_SECRET ?? "",
			discoveryUrl: issuer.includes("/.well-known/")
				? issuer
				: `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
		});
	if (env.ORBIS_GITHUB_CLIENT_ID && env.ORBIS_GITHUB_CLIENT_SECRET)
		oauth.push({
			id: "github",
			name: "GitHub",
			clientId: env.ORBIS_GITHUB_CLIENT_ID,
			clientSecret: env.ORBIS_GITHUB_CLIENT_SECRET,
		});
	if (env.ORBIS_GOOGLE_CLIENT_ID && env.ORBIS_GOOGLE_CLIENT_SECRET)
		oauth.push({
			id: "google",
			name: "Google",
			clientId: env.ORBIS_GOOGLE_CLIENT_ID,
			clientSecret: env.ORBIS_GOOGLE_CLIENT_SECRET,
		});
	if (oauth.length && !pub)
		console.warn(
			"[orbis] OAuth needs ORBIS_PUBLIC_URL (the address the provider sends people back to); it stays off",
		);
	let sendCode: SendCode | undefined;
	if (ways.has("code")) {
		sendCode = mailer(env, pub?.host ?? "Orbis");
		if (!sendCode)
			throw new Error(
				"ORBIS_LOGIN has code, but there is no way to send mail: set ORBIS_SMTP_URL (or ORBIS_SMTP_URL=log to print the codes in the server log)",
			);
	}
	// browsers have passkeys only in a secure context: https, or localhost
	const secure = !!pub && (pub.protocol === "https:" || pub.hostname === "localhost");
	if (ways.has("passkey") && !secure && listed)
		console.warn("[orbis] passkeys need ORBIS_PUBLIC_URL with https (or localhost); they stay off");
	const config: LoginConfig = {
		password: ways.has("password"),
		sendCode,
		passkey:
			ways.has("passkey") && secure ? { rpID: pub!.hostname, origin: pub!.origin } : undefined,
		oauth: pub ? oauth : [],
	};
	// passkeys are added to an account: someone has to be able to make one first
	if (!config.password && !config.sendCode && !config.oauth.length)
		throw new Error(
			"ORBIS_LOGIN needs password or code (or an OAuth provider): otherwise nobody can create an account",
		);
	return config;
}

export const loginMethods = (c: LoginConfig): LoginMethods => ({
	password: c.password,
	emailCode: !!c.sendCode,
	passkey: !!c.passkey,
	oauth: c.oauth.map((p) => ({ id: p.id, name: p.name })),
});
