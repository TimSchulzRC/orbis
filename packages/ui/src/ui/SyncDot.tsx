import { Cloud, CloudOff, RefreshCw } from "lucide-react";
import { useAccounts } from "../accounts";
import { useT } from "../i18n";
import { cx } from "./bits";
import { useReplicas } from "./Spaces";

/** How the sync of all workspaces on this device stands: offline as soon as one is, pending summed up. */
export function SyncDot() {
  const { t } = useT();
  const { spaces } = useAccounts();
  const all = useReplicas(spaces.map((s) => s.id)).map((r) => r.status);
  const s = { online: all.every((x) => x.online), pending: all.reduce((n, x) => n + x.pending, 0), synced: all.every((x) => x.synced) };
  const label = !s.online ? t("sync.offline", { count: s.pending }) : s.pending ? t("sync.pending", { count: s.pending }) : !s.synced ? t("sync.catchingUp") : t("sync.ok");
  const Icon = !s.online ? CloudOff : s.pending || !s.synced ? RefreshCw : Cloud;
  return (
    <span title={label} aria-label={label} className={cx("ml-auto inline-flex items-center gap-1 text-xs", !s.online ? "text-warn" : "text-muted")}>
      <Icon size={14} className={s.online && (s.pending || !s.synced) ? "animate-spin" : ""} />
      {!s.online && t("sync.offlineShort")}
    </span>
  );
}
