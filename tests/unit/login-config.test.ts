import { expect, test } from "bun:test";
import { loginConfig, loginMethods } from "@orbis/server/login";

const methods = (env: Record<string, string>, pub = "") => loginMethods(loginConfig(env, pub));

test("without settings: password and passkeys (passkeys where the address allows them)", () => {
	expect(methods({})).toEqual({ password: true, emailCode: false, passkey: false, oauth: [] });
	expect(methods({}, "https://orbis.example.org")).toEqual({
		password: true,
		emailCode: false,
		passkey: true,
		oauth: [],
	});
});

test("passkeys need a public https address (or localhost) and go off when not listed", () => {
	expect(methods({}, "http://localhost:8480").passkey).toBe(true);
	expect(methods({}, "http://nas:8480").passkey).toBe(false);
	expect(methods({ ORBIS_LOGIN: "password" }, "https://orbis.example.org").passkey).toBe(false);
	expect(loginConfig({}, "https://orbis.example.org:8443").passkey).toEqual({
		rpID: "orbis.example.org",
		origin: "https://orbis.example.org:8443",
	});
});

test("codes are a way of their own: mail settings alone switch nothing on", () => {
	expect(methods({ ORBIS_SMTP_URL: "log" }).emailCode).toBe(false);
	expect(methods({ ORBIS_LOGIN: "password, code", ORBIS_SMTP_URL: "log" })).toMatchObject({
		password: true,
		emailCode: true,
	});
	expect(methods({ ORBIS_LOGIN: "code", ORBIS_SMTP_URL: "log" })).toMatchObject({
		password: false,
		emailCode: true,
	});
	expect(() => loginConfig({ ORBIS_LOGIN: "code" }, "")).toThrow("ORBIS_SMTP_URL");
});

test("a server needs a way to create accounts", () => {
	expect(() => loginConfig({ ORBIS_LOGIN: "passkey" }, "https://orbis.example.org")).toThrow(
		"nobody can create an account",
	);
	expect(
		methods(
			{ ORBIS_LOGIN: "passkey", ORBIS_GITHUB_CLIENT_ID: "gh", ORBIS_GITHUB_CLIENT_SECRET: "s" },
			"https://o.example.org",
		),
	).toMatchObject({ password: false, passkey: true, oauth: [{ id: "github" }] });
});

test("OAuth providers need their client and the public address", () => {
	const env = {
		ORBIS_OIDC_ISSUER: "https://auth.example.org/application/o/orbis/",
		ORBIS_OIDC_CLIENT_ID: "id",
		ORBIS_OIDC_CLIENT_SECRET: "s",
		ORBIS_OIDC_NAME: "Authentik",
		ORBIS_GITHUB_CLIENT_ID: "gh",
	};
	expect(methods(env)).toMatchObject({ oauth: [] });
	const c = loginConfig(env, "https://orbis.example.org");
	expect(c.oauth.map((p) => p.id)).toEqual(["oidc"]);
	expect(c.oauth[0]!.discoveryUrl).toBe(
		"https://auth.example.org/application/o/orbis/.well-known/openid-configuration",
	);
	expect(
		methods({ ...env, ORBIS_GITHUB_CLIENT_SECRET: "x" }, "https://o.example.org").oauth,
	).toEqual([
		{ id: "oidc", name: "Authentik" },
		{ id: "github", name: "GitHub" },
	]);
});
