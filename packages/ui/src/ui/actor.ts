// The device stays in the origin for later queries but is never shown.

import type { T } from "@orbis/core/i18n";
import { type Person, parseOrigin } from "@orbis/core/origin";
import { Bot, Cog, Download, type LucideIcon, Sparkles, User } from "lucide-react";
import { agentLabel } from "./AgentNotice";

export interface Who {
	label: string;
	icon: LucideIcon;
	agent: boolean;
	/** Set only when the person changed it directly, not through an agent. */
	person?: Person;
}

export function who(origin: string, t: T): Who {
	const parsed = parseOrigin(origin);
	if (parsed.kind === "agent") {
		const agent = agentLabel(parsed.name, t);
		const label = parsed.person
			? t("activity.agentFor", { agent, name: parsed.person.name })
			: agent;
		return { label, icon: parsed.name === "chat" ? Sparkles : Bot, agent: true };
	}
	if (parsed.kind === "import")
		return { label: t("activity.import", { name: parsed.name }), icon: Download, agent: false };
	if (parsed.kind === "system") return { label: t("activity.system"), icon: Cog, agent: false };
	if (parsed.kind === "web")
		return { label: parsed.person!.name, icon: User, agent: false, person: parsed.person };
	return { label: origin, icon: User, agent: false };
}

export function byMe(w: Who, me: { id: string } | undefined): boolean {
	return !!w.person && !!me && w.person.id === me.id;
}
