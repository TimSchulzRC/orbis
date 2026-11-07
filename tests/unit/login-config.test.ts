import { test, expect } from "bun:test";
import { loginConfig, loginMethods } from "@obtion/server/login";

const methods = (env: Record<string, string>, pub = "") => loginMethods(loginConfig(env, pub));

test("without settings: password and passkeys (passkeys where the address allows them)", () => {
  expect(methods({})).toEqual({ password: true, emailCode: false, passkey: false, oauth: [] });
  expect(methods({}, "https://obtion.example.org")).toEqual({ password: true, emailCode: false, passkey: true, oauth: [] });
});

test("passkeys need a public https address (or localhost) and go off when not listed", () => {
  expect(methods({}, "http://localhost:8480").passkey).toBe(true);
  expect(methods({}, "http://nas:8480").passkey).toBe(false);
  expect(methods({ OBTION_LOGIN: "password" }, "https://obtion.example.org").passkey).toBe(false);
  expect(loginConfig({}, "https://obtion.example.org:8443").passkey).toEqual({ rpID: "obtion.example.org", origin: "https://obtion.example.org:8443" });
});

test("codes are a way of their own: mail settings alone switch nothing on", () => {
  expect(methods({ OBTION_SMTP_URL: "log" }).emailCode).toBe(false);
  expect(methods({ OBTION_LOGIN: "password, code", OBTION_SMTP_URL: "log" })).toMatchObject({ password: true, emailCode: true });
  expect(methods({ OBTION_LOGIN: "code", OBTION_SMTP_URL: "log" })).toMatchObject({ password: false, emailCode: true });
  expect(() => loginConfig({ OBTION_LOGIN: "code" }, "")).toThrow("OBTION_SMTP_URL");
});

test("a server needs a way to create accounts: passkeys alone do, where the address allows them", () => {
  expect(methods({ OBTION_LOGIN: "passkey" }, "https://obtion.example.org")).toEqual({ password: false, emailCode: false, passkey: true, oauth: [] });
  expect(() => loginConfig({ OBTION_LOGIN: "passkey" }, "http://nas:8480")).toThrow("nobody can create an account");
  expect(() => loginConfig({ OBTION_LOGIN: "passkey" }, "")).toThrow("nobody can create an account");
  expect(methods({ OBTION_LOGIN: "passkey", OBTION_GITHUB_CLIENT_ID: "gh", OBTION_GITHUB_CLIENT_SECRET: "s" }, "https://o.example.org")).toMatchObject({ password: false, passkey: true, oauth: [{ id: "github" }] });
});

test("OAuth providers need their client and the public address", () => {
  const env = { OBTION_OIDC_ISSUER: "https://auth.example.org/application/o/obtion/", OBTION_OIDC_CLIENT_ID: "id", OBTION_OIDC_CLIENT_SECRET: "s", OBTION_OIDC_NAME: "Authentik", OBTION_GITHUB_CLIENT_ID: "gh" };
  expect(methods(env)).toMatchObject({ oauth: [] });
  const c = loginConfig(env, "https://obtion.example.org");
  expect(c.oauth.map((p) => p.id)).toEqual(["oidc"]);
  expect(c.oauth[0]!.discoveryUrl).toBe("https://auth.example.org/application/o/obtion/.well-known/openid-configuration");
  expect(methods({ ...env, OBTION_GITHUB_CLIENT_SECRET: "x" }, "https://o.example.org").oauth).toEqual([{ id: "oidc", name: "Authentik" }, { id: "github", name: "GitHub" }]);
});
