// Another server next to the ones connected, as in the desktop app: its address, then signing in.
// Its workspaces join the others on this phone.

import { router } from "expo-router";
import { SignInForm } from "../ui/signin";

export default function Connect() {
	return <SignInForm another onDone={() => router.back()} />;
}
