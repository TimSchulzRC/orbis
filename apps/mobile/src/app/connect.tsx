// Another server next to the ones connected, as in the desktop app: its address, then signing in.
// Its workspaces join the others on this phone.

import { router, Stack } from "expo-router";
import { t } from "../lib/i18n";
import { SignInForm } from "../ui/signin";

export default function Connect() {
	return (
		<>
			<Stack.Toolbar placement="left">
				<Stack.Toolbar.Button icon="xmark" onPress={() => router.back()}>
					{t("cancel")}
				</Stack.Toolbar.Button>
			</Stack.Toolbar>
			<SignInForm another onDone={() => router.back()} />
		</>
	);
}
