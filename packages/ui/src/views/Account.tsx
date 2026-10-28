import { BrandLogo } from "../ui/BrandLogo";
// Before the app: signing in or creating an account on this server, joining by an invite link
// (#/join/<code>). Then a workspace has to be open.
import { useEffect, useState, type ReactNode } from "react";
import { createSpace, invite, joinInvite, serverInfo, signIn, signUp, useAccounts } from "../accounts";
import { useRoute } from "../hooks";
import { getLang, useT } from "../i18n";
import { Button } from "../ui/bits";

function Card({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <BrandLogo alt="" className="mb-4 size-10" />
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {intro && <p className="mt-2 text-sm text-muted">{intro}</p>}
        {children}
      </div>
    </div>
  );
}

const input = "field mt-1 block w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm";

function Field({ label, ...p }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="mt-4 block text-sm font-medium">
      {label}
      <input {...p} className={input} />
    </label>
  );
}

/** Sign in or create an account on this server. `inviteCode`: creating one joins that workspace. */
function SignIn({ inviteCode, onDone }: { inviteCode?: string; onDone?: () => void }) {
  const { t } = useT();
  const [info, setInfo] = useState<{ signup: string; firstAccount: boolean } | null>(null);
  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    serverInfo()
      .then((i) => {
        setInfo(i);
        if (i.firstAccount || inviteCode) setMode("up");
      })
      .catch(() => setError(t("account.offline")));
  }, []);
  const canSignUp = !!info && (info.firstAccount || info.signup === "open" || (info.signup === "invite" && !!inviteCode));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "up") await signUp({ name, email, password, invite: inviteCode, lang: getLang() });
      else await signIn(email, password);
      onDone?.();
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 401 ? t("account.wrong") : status === 429 ? t("account.tooMany") : status === 409 || status === 422 ? t("account.exists") : status === 403 ? t("account.closed") : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-2">
      {info?.firstAccount && <p className="mt-3 rounded-lg border border-line bg-surface-2 p-3 text-sm text-muted">{t("account.firstHint")}</p>}
      {mode === "up" && <Field label={t("account.name")} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
      <Field label={t("account.email")} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      <Field label={t("account.password")} type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "up" ? "new-password" : "current-password"} />
      {error && (
        <p className="mt-3 text-sm text-[var(--danger-text)]" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" className="mt-6 w-full" disabled={busy || !info}>
        {mode === "up" ? t("account.signUp") : t("account.signIn")}
      </Button>
      {canSignUp && !info?.firstAccount && (
        <button type="button" onClick={() => setMode(mode === "up" ? "in" : "up")} className="mt-3 w-full text-center text-sm text-[var(--link)] hover:underline">
          {mode === "up" ? t("account.haveAccount") : t("account.create")}
        </button>
      )}
    </form>
  );
}

/** Joining a workspace by its invite link: with the account signed in here, or a new one. */
function Join({ code }: { code: string }) {
  const { t } = useT();
  const [inv, setInv] = useState<{ workspace: string; by: string } | null | undefined>();
  const [error, setError] = useState("");
  const { account: acc } = useAccounts();
  useEffect(() => {
    invite(code).then(setInv, () => setInv(null));
  }, [code]);
  const done = () => location.replace("#/");
  if (inv === undefined) return null;
  if (inv === null) return <Card title={t("account.inviteInvalid")} intro={t("account.inviteInvalidHint")}><a href="#/inbox" className="mt-4 block text-sm text-[var(--link)] hover:underline">{t("nav.inbox")}</a></Card>;
  return (
    <Card title={t("account.joinTitle", { workspace: inv.workspace })} intro={t("account.joinIntro", { by: inv.by, server: location.host })}>
      {acc && !acc.lost ? (
        <>
          <p className="mt-4 text-sm">{t("account.joinAs", { email: acc.user.email })}</p>
          {error && <p className="mt-3 text-sm text-[var(--danger-text)]">{error}</p>}
          <Button variant="primary" className="mt-6 w-full" onClick={() => joinInvite(code).then(done, (e) => setError((e as Error).message))}>
            {t("account.join")}
          </Button>
        </>
      ) : (
        <SignIn inviteCode={code} onDone={done} />
      )}
    </Card>
  );
}

/** Signed in, but in no workspace (left them all, or joined none): make one. */
function NoSpace() {
  const { t } = useT();
  const [name, setName] = useState(t("account.personal"));
  return (
    <Card title={t("account.noSpace")} intro={t("account.noSpaceHint")}>
      <form onSubmit={(e) => (e.preventDefault(), void createSpace(name))}>
        <Field label={t("space.name")} required value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="primary" className="mt-6 w-full">
          {t("space.create")}
        </Button>
      </form>
    </Card>
  );
}

/** What has to happen before the app shows a workspace; `children` once one is open. */
export function Gate({ children }: { children: ReactNode }) {
  const { t } = useT();
  const route = useRoute();
  const { account, active } = useAccounts();
  if (route.parts[0] === "join" && route.parts[1]) return <Join code={route.parts[1]} />;
  if (!account) return <Card title={t("setup.welcome")} intro={t("account.intro", { server: location.host })}><SignIn /></Card>;
  if (!active) return account.lost ? <Card title={t("account.lostTitle")} intro={t("account.lost", { server: location.host })}><SignIn /></Card> : <NoSpace />;
  return <>{children}</>;
}
