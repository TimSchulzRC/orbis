// Which sign-in methods the environment turns on (login.ts).
import { test, expect } from "bun:test";
import { loginConfig, loginMethods } from "@obtion/server/login";

const methods = (env: Record<string, string>, pub = "") => loginMethods(loginConfig(env, pub));

test("without settings: only the password", () => {
  expect(methods({})).toEqual({ password: true, emailCode: false, passkey: false, oauth: [] });
});

test("passkeys need a public https address (or localhost) and can be turned off", () => {
  expect(methods({}, "https://obtion.example.org").passkey).toBe(true);
  expect(methods({}, "http://localhost:8480").passkey).toBe(true);
  expect(methods({}, "http://nas:8480").passkey).toBe(false);
  expect(methods({ OBTION_PASSKEYS: "off" }, "https://obtion.example.org").passkey).toBe(false);
  expect(loginConfig({}, "https://obtion.example.org:8443").passkey).toEqual({ rpID: "obtion.example.org", origin: "https://obtion.example.org:8443" });
});

test("OAuth providers need their client and the public address", () => {
  const env = { OBTION_OIDC_ISSUER: "https://auth.example.org/application/o/obtion/", OBTION_OIDC_CLIENT_ID: "id", OBTION_OIDC_CLIENT_SECRET: "s", OBTION_OIDC_NAME: "Authentik", OBTION_GITHUB_CLIENT_ID: "gh" };
  expect(methods(env)).toMatchObject({ oauth: [] });
  const c = loginConfig(env, "https://obtion.example.org");
  expect(c.oauth.map((p) => p.id)).toEqual(["oidc"]);
  expect(c.oauth[0]!.discoveryUrl).toBe("https://auth.example.org/application/o/obtion/.well-known/openid-configuration");
  expect(methods({ ...env, OBTION_GITHUB_CLIENT_SECRET: "x" }, "https://o.example.org").oauth).toEqual([{ id: "oidc", name: "Authentik" }, { id: "github", name: "GitHub" }]);
});

test("passwords go off only when there is another way to sign up", () => {
  expect(methods({ OBTION_PASSWORD: "off" }).password).toBe(true);
  expect(methods({ OBTION_PASSWORD: "off", OBTION_SMTP_URL: "log" })).toMatchObject({ password: false, emailCode: true });
});
