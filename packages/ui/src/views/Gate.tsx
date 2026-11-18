// In front of the app: signing in (Account.tsx), then a workspace has to be open. Without one, the
// first is created here.

import type { ReactNode } from "react";
import { serverName, useAccounts } from "../accounts";
import { useRoute } from "../hooks";
import { useT } from "../i18n";
import { desktop } from "../platform";
import { NewSpaceForm } from "../ui/Spaces";
import { AuthCard, Join, SignIn } from "./Account";

/**
 * Signed in, but in no workspace (a new account, or left them all): make one. In the desktop app
 * also its first start: the first workspace on this device or on a server, maybe an existing one.
 */
function NoSpace() {
	const { t } = useT();
	return (
		<AuthCard
			intro={desktop ? t("space.firstIntro") : t("account.noSpaceHint")}
			title={desktop ? t("setup.welcome") : t("account.noSpace")}
		>
			<div className="mt-4">
				<NewSpaceForm name={t("account.personal")} />
			</div>
		</AuthCard>
	);
}

export function Gate({ children }: { children: ReactNode }) {
	const { t } = useT();
	const route = useRoute();
	const { account, active } = useAccounts();
	if (route.parts[0] === "join" && route.parts[1]) return <Join code={route.parts[1]} />;
	if (!account)
		return (
			<AuthCard intro={t("account.intro", { server: serverName() })} title={t("setup.welcome")}>
				<SignIn />
			</AuthCard>
		);
	if (!active)
		return account.lost ? (
			<AuthCard intro={t("account.lost", { server: serverName() })} title={t("account.lostTitle")}>
				<SignIn />
			</AuthCard>
		) : (
			<NoSpace />
		);
	return <>{children}</>;
}
