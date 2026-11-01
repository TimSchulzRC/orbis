// Before the app: signing in or creating an account on this server, joining by an invite link
// (#/join/<code>). Then a workspace has to be open.
import { Input } from "../components/ui/input";
import { BrandLogo } from "../ui/BrandLogo";
import { useEffect, useState, type ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { ApiError, createSpace, errorText, invite, joinInvite, loginOf, oauthFailed, sendCode, serverInfo, signIn, signInWithCode, signInWithOAuth, signInWithPasskey, signUp, useAccounts } from "../accounts";
import type { InviteInfo, ServerInfo } from "@obtion/core/api";
import { useRoute, navigate } from "../hooks";
import { getLang, useT } from "../i18n";
import { Button } from "../ui/primitives";

/** A page before the app (signing in, joining, the first setup): logo, title, a sentence, a form. */
export function AuthCard({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <BrandLogo alt="" className="mb-4 size-10" />
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {intro && <p className="mt-2 text-sm text-muted-foreground">{intro}</p>}
        {children}
      </div>
    </div>
  );
}

const input = "mt-1 block bg-surface";

function Field({ label, ...p }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="mt-4 block text-sm font-medium">
      {label}
      <Input {...p} className={input} />
    </label>
  );
}

/** Passkeys work only where the browser has them (and in a secure context: HTTPS or localhost). */
const canPasskey = () => typeof window !== "undefined" && !!window.PublicKeyCredential && window.isSecureContext;

/**
 * Sign in or create an account on this server, in every way it offers: a passkey, an OAuth
 * provider, a code by email, a password. `inviteCode`: a new account joins that workspace.
 * `email`: confirming who is signed in already (only signing in, with this address).
 */
export function SignIn({ inviteCode, onDone, email: fixedEmail }: { inviteCode?: string; onDone?: () => void; email?: string }) {
  const { t } = useT();
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [mode, setMode] = useState<"in" | "up">("in");
  // by code (when the server sends them) or by password
  const [withPassword, setWithPassword] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(fixedEmail ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState(oauthFailed ? t(oauthFailed === "closed" ? "account.closed" : oauthFailed === "notLinked" ? "account.notLinked" : "account.oauthFailed") : "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    serverInfo()
      .then((i) => {
        setInfo(i);
        if (!fixedEmail && (i.firstAccount || inviteCode)) setMode("up");
        if (!loginOf(i).emailCode) setWithPassword(true);
      })
      .catch(() => setError(t("account.offline")));
  }, []);
  const login = loginOf(info);
  const ctx = { invite: inviteCode, lang: getLang() };
  const canSignUp = !fixedEmail && !!info && (info.firstAccount || info.signup === "open" || (info.signup === "invite" && !!inviteCode));
  const run = async (what: "signIn" | "code", f: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await f();
      return true;
    } catch (err) {
      setError(errorText(err, t, what));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const account = { name, email, password, invite: inviteCode, lang: getLang() };
  // a new account with a password, where codes are on: its address proves itself with a code first
  const signUpWithCode = withPassword && mode === "up" && login.emailCode;
  const sendAgain = () => run("code", () => (signUpWithCode ? signUp(account) : sendCode(email, ctx)));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (codeSent && signUpWithCode) {
      if (await run("code", () => signUp({ ...account, code }))) onDone?.();
    } else if (withPassword) {
      let verify = false;
      const ok = await run("signIn", async () => void (verify = mode === "up" ? (await signUp(account)) === "verify" : (await signIn(email, password), false)));
      if (ok && verify) setCodeSent(true);
      else if (ok) onDone?.();
    } else if (!codeSent) {
      if (await run("code", () => sendCode(email, ctx))) setCodeSent(true);
    } else if (await run("code", () => signInWithCode(email, code, mode === "up" ? name : undefined, ctx))) onDone?.();
  };
  const passkey = async () => {
    setBusy(true);
    setError("");
    try {
      await signInWithPasskey();
      onDone?.();
    } catch (err) {
      // closed by the person (NotAllowedError): nothing to say
      if (!(err instanceof Error && err.name === "NotAllowedError")) setError(err instanceof ApiError && err.status === 429 ? t("account.tooMany") : t("account.passkeyFailed"));
    } finally {
      setBusy(false);
    }
  };
  const others = (login.passkey && canPasskey() && mode === "in") || login.oauth.length > 0;
  if (codeSent)
    return (
      <form onSubmit={submit} className="mt-2">
        <p className="mt-4 text-sm">{t("account.codeSent", { email })}</p>
        <Field label={t("account.code")} required autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        {error && (
          <p className="mt-3 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="mt-6 w-full" disabled={busy || !code.trim()}>
          {mode === "up" ? t("account.signUp") : t("account.signIn")}
        </Button>
        <div className="mt-3 flex justify-between text-sm">
          <Button variant="plain" type="button" className="text-link hover:underline" onClick={() => (setCodeSent(false), setCode(""), setError(""))}>
            {t("account.back")}
          </Button>
          <Button variant="plain" type="button" className="text-link hover:underline" disabled={busy} onClick={() => void sendAgain()}>
            {t("account.codeAgain")}
          </Button>
        </div>
      </form>
    );
  return (
    <form onSubmit={submit} className="mt-2">
      {info?.firstAccount && <p className="mt-3 rounded-lg border border-line bg-surface-2 p-3 text-sm text-muted-foreground">{t("account.firstHint")}</p>}
      {others && (
        <div className="mt-4 flex flex-col gap-2">
          {login.passkey && canPasskey() && mode === "in" && (
            <Button type="button" variant="outline" className="w-full" disabled={busy || !info} onClick={() => void passkey()}>
              <KeyRound size={16} /> {t("account.passkey")}
            </Button>
          )}
          {login.oauth.map((p) => (
            <Button key={p.id} type="button" variant="outline" className="w-full" disabled={busy || !info} onClick={() => void run("signIn", () => signInWithOAuth(p.id, ctx))}>
              {t("account.oauth", { provider: p.name })}
            </Button>
          ))}
          {(login.emailCode || login.password) && <p className="mt-2 text-center text-xs text-muted-foreground">{t("account.or")}</p>}
        </div>
      )}
      {(login.emailCode || login.password) && (
        <>
          {mode === "up" && <Field label={t("account.name")} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
          <Field label={t("account.email")} type="email" required readOnly={!!fixedEmail} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          {withPassword && <Field label={t("account.password")} type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "up" ? "new-password" : "current-password"} />}
        </>
      )}
      {error && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {(login.emailCode || login.password) && (
        <Button type="submit" variant="primary" className="mt-6 w-full" disabled={busy || !info}>
          {!withPassword ? t("account.sendCode") : mode === "up" ? t("account.signUp") : t("account.signIn")}
        </Button>
      )}
      {login.emailCode && login.password && (
        <Button variant="plain" type="button" onClick={() => (setWithPassword(!withPassword), setError(""))} className="mt-3 w-full text-center text-sm text-link hover:underline">
          {withPassword ? t("account.useCode") : t("account.usePassword")}
        </Button>
      )}
      {canSignUp && !info?.firstAccount && (
        <Button variant="plain" type="button" onClick={() => (setMode(mode === "up" ? "in" : "up"), setError(""))} className="mt-3 w-full text-center text-sm text-link hover:underline">
          {mode === "up" ? t("account.haveAccount") : t("account.create")}
        </Button>
      )}
    </form>
  );
}

/** Joining a workspace by its invite link: with the account signed in here, or a new one. */
function Join({ code }: { code: string }) {
  const { t } = useT();
  const [inv, setInv] = useState<InviteInfo | null | undefined>();
  const [error, setError] = useState("");
  const { account: acc } = useAccounts();
  useEffect(() => {
    invite(code).then(setInv, () => setInv(null));
  }, [code]);
  const done = () => navigate("/", { replace: true });
  if (inv === undefined) return null;
  if (inv === null) return <AuthCard title={t("account.inviteInvalid")} intro={t("account.inviteInvalidHint")}><a href="#/inbox" className="mt-4 block text-sm text-link hover:underline">{t("nav.inbox")}</a></AuthCard>;
  return (
    <AuthCard title={t("account.joinTitle", { workspace: inv.workspace })} intro={t("account.joinIntro", { by: inv.by, server: location.host })}>
      {acc && !acc.lost ? (
        <>
          <p className="mt-4 text-sm">{t("account.joinAs", { email: acc.user.email })}</p>
          {error && <p className="mt-3 text-sm text-danger">{error}</p>}
          <Button variant="primary" className="mt-6 w-full" onClick={() => joinInvite(code).then(done, (e) => setError(errorText(e, t, "space")))}>
            {t("account.join")}
          </Button>
        </>
      ) : (
        <SignIn inviteCode={code} onDone={done} />
      )}
    </AuthCard>
  );
}

/** Signed in, but in no workspace (left them all, or joined none): make one. */
function NoSpace() {
  const { t } = useT();
  const [name, setName] = useState(t("account.personal"));
  return (
    <AuthCard title={t("account.noSpace")} intro={t("account.noSpaceHint")}>
      <form onSubmit={(e) => (e.preventDefault(), void createSpace(name))}>
        <Field label={t("space.name")} required value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="primary" className="mt-6 w-full">
          {t("space.create")}
        </Button>
      </form>
    </AuthCard>
  );
}

/** What has to happen before the app shows a workspace; `children` once one is open. */
export function Gate({ children }: { children: ReactNode }) {
  const { t } = useT();
  const route = useRoute();
  const { account, active } = useAccounts();
  if (route.parts[0] === "join" && route.parts[1]) return <Join code={route.parts[1]} />;
  if (!account) return <AuthCard title={t("setup.welcome")} intro={t("account.intro", { server: location.host })}><SignIn /></AuthCard>;
  if (!active) return account.lost ? <AuthCard title={t("account.lostTitle")} intro={t("account.lost", { server: location.host })}><SignIn /></AuthCard> : <NoSpace />;
  return <>{children}</>;
}
