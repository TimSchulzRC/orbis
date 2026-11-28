// A server no longer accepts this phone's sign-in: sign in again on the same server. Same account,
// same copies: nothing unsynced is lost.

import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { t } from "../lib/i18n";
import { accountOf, useSession } from "../lib/session";
import { SignInForm } from "../ui/signin";

export default function Reauth() {
	const { server } = useLocalSearchParams<{ server: string }>();
	useSession();
	const account = accountOf(server);
	useEffect(() => {
		if (!account?.lost) router.back();
	}, [account]);
	return (
		<>
			<Stack.Screen options={{ title: t("account.signInAgain") }} />
			<SignInForm email={account?.user.email} fixedServer={server} />
		</>
	);
}
