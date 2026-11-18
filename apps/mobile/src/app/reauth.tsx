// The server no longer accepts this phone's sign-in: sign in again on the same server. Same
// account, same copies: nothing unsynced is lost.

import { router, Stack } from "expo-router";
import { useEffect } from "react";
import { t } from "../lib/i18n";
import { useSession } from "../lib/session";
import { SignInForm } from "../ui/signin";

export default function Reauth() {
	const session = useSession();
	useEffect(() => {
		if (session && !session.lost) router.back();
	}, [session]);
	return (
		<>
			<Stack.Screen options={{ title: t("account.signInAgain") }} />
			<SignInForm email={session?.user.email} fixedServer={session?.server} />
		</>
	);
}
