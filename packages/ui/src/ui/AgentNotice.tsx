// Flashes on-screen rows an agent changed and offers undo for that agent step.
import { useEffect, useRef } from "react";
import type { ActivityEvent } from "@obtion/core/protocol";
import { repo } from "../repo";
import { useT } from "../i18n";
import { notify } from "./feedback";
import type { T } from "@obtion/core/i18n";
import { parseOrigin } from "@obtion/core/origin";

function visible(id: string): HTMLElement[] {
  const onPage = decodeURIComponent(location.hash.replace(/^#\/i\//, "")) === id;
  const rows = [...document.querySelectorAll<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)].filter((el) => {
    const box = el.getBoundingClientRect();
    return box.bottom > 0 && box.top < innerHeight && box.width > 0;
  });
  if (onPage) rows.push(...[...document.querySelectorAll<HTMLElement>("[data-page-title]")]);
  return rows;
}

/** The agent of a change ("agent:claude-code;u=…" → "claude-code"); undefined when no agent made it. */
export function agentName(origin: string): string | undefined {
  const a = parseOrigin(origin);
  return a.kind === "agent" ? a.name : undefined;
}

/** A readable name for an agent id: "claude-code", "claude" → Claude; anything else → Agent. */
export function agentLabel(id: string, t: T): string {
  return /claude/i.test(id) ? "Claude" : t("activity.agent");
}

export function AgentNotice() {
  const { t } = useT();
  const titles = useRef<{ step: string; list: string[] }>({ step: "", list: [] });
  useEffect(() => {
    const off = repo.onEvent((e: ActivityEvent) => {
      const agent = agentName(e.origin);
      if (!agent || !e.step || e.undoes) return;
      const els = visible(e.doc);
      if (!els.length) return;
      for (const el of els) {
        el.classList.remove("agent-flash");
        void el.offsetWidth; // force a reflow so the animation restarts
        el.classList.add("agent-flash");
      }
      // one notice per step, later changes in the same step update it
      const cur = titles.current.step === e.step ? titles.current.list : [];
      titles.current = { step: e.step, list: [...new Set([...cur, e.title])] };
      const list = titles.current.list;
      const name = agentLabel(agent, t);
      const step = e.step;
      const message = list.length === 1 ? t("agent.changed", { agent: name, title: list[0] || t("untitled") }) : t("agent.changedMany", { agent: name, count: list.length });
      notify.undo(message, () => void repo.undo(step), "agent:" + step);
    });
    return () => void off();
  }, [t]);
  return null;
}
