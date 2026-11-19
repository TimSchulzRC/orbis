// The workspace switcher at the top left of each tab: all workspaces or one of them, the same choice
// on every tab. With several servers the menu groups them by server; a new workspace starts there too.

import { router, Stack } from "expo-router";
import { hostOf } from "../lib/api";
import { t } from "../lib/i18n";
import { setShown, useSession, type Workspace } from "../lib/session";

/** Longer than this, iOS folds the whole bar into one "•••" button. */
const LABEL = 16;

/** The name for the button, cut to fit next to the buttons on the right. */
function short(name: string): string {
	const chars = Array.from(name);
	if (chars.length <= LABEL) return name;
	const cut = chars
		.slice(0, LABEL - 1)
		.join("")
		.trimEnd();
	return `${cut}…`;
}

export function SpaceSwitcher() {
	const session = useSession();
	if (!session?.spaces.length) return null;
	const { accounts, spaces } = session;
	const one = spaces.length === 1;
	const chosen = session.shown ?? (one ? spaces[0]!.id : null);
	const action = (w: Workspace) => (
		<Stack.Toolbar.MenuAction isOn={w.id === chosen} key={w.id} onPress={() => setShown(w.id)}>
			{w.name}
		</Stack.Toolbar.MenuAction>
	);
	// the toolbar takes only its own elements as children: arrays, no fragments or components
	const groups =
		accounts.length > 1
			? accounts.map((a) => (
					<Stack.Toolbar.Menu inline key={a.server} title={hostOf(a.server)}>
						{spaces.filter((w) => w.server === a.server).map(action)}
					</Stack.Toolbar.Menu>
				))
			: [
					<Stack.Toolbar.Menu inline key="spaces">
						{spaces.map(action)}
					</Stack.Toolbar.Menu>,
				];
	return (
		<Stack.Toolbar placement="left">
			<Stack.Toolbar.Menu title={t("settings.workspaces")}>
				<Stack.Toolbar.Label>
					{short(spaces.find((w) => w.id === chosen)?.name ?? t("space.all"))}
				</Stack.Toolbar.Label>
				{!one && (
					<Stack.Toolbar.MenuAction
						icon="square.stack.3d.up"
						isOn={!chosen}
						onPress={() => setShown(null)}
					>
						{t("space.all")}
					</Stack.Toolbar.MenuAction>
				)}
				{groups}
				<Stack.Toolbar.Menu inline>
					<Stack.Toolbar.MenuAction icon="plus" onPress={() => router.push("/new-space")}>
						{t("space.new")}
					</Stack.Toolbar.MenuAction>
				</Stack.Toolbar.Menu>
			</Stack.Toolbar.Menu>
		</Stack.Toolbar>
	);
}
