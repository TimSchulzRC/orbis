// The device stays in the origin for later queries but is never shown.
import { Bot, Cog, Download, Sparkles, User, type LucideIcon } from "lucide-react";
import type { T } from "@obtion/core/i18n";
import { firstName, parseOrigin } from "@obtion/core/origin";
import { agentLabel } from "./AgentNotice";

export interface Who {
  label: string;
  icon: LucideIcon;
  agent: boolean;
  /** Set only when the person changed it directly, not through an agent. */
  person?: { id?: string; name: string };
}

export function who(origin: string, t: T): Who {
  const a = parseOrigin(origin);
  if (a.kind === "agent") {
    const agent = agentLabel(a.name, t);
    return { label: a.person ? t("activity.agentFor", { agent, name: a.person.name }) : agent, icon: a.name === "chat" ? Sparkles : Bot, agent: true };
  }
  if (a.kind === "import") return { label: t("activity.import", { name: a.name }), icon: Download, agent: false };
  if (a.kind === "system") return { label: t("activity.system"), icon: Cog, agent: false };
  if (a.kind === "web") return { label: a.person!.name, icon: User, agent: false, person: a.person };
  return { label: origin, icon: User, agent: false };
}

/** Older entries carry no account id, so the name decides for them. */
export function byMe(w: Who, me: { id: string; name: string; email: string } | undefined): boolean {
  if (!w.person || !me) return false;
  return w.person.id ? w.person.id === me.id : w.person.name === firstName(me);
}

