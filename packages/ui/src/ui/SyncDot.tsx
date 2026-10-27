import { Cloud, CloudOff, RefreshCw } from "lucide-react";
import { useRepo } from "../hooks";
import { useT } from "../i18n";
import { cx } from "./bits";

export function SyncDot() {
  const r = useRepo();
  const { t } = useT();
  const s = r.status;
  const label = !s.online ? t("sync.offline", { count: s.pending }) : s.pending ? t("sync.pending", { count: s.pending }) : !s.synced ? t("sync.catchingUp") : t("sync.ok");
  const Icon = !s.online ? CloudOff : s.pending || !s.synced ? RefreshCw : Cloud;
  return (
    <span title={label} aria-label={label} className={cx("ml-auto inline-flex items-center gap-1 text-xs", !s.online ? "text-warn" : "text-muted")}>
      <Icon size={14} className={s.online && (s.pending || !s.synced) ? "animate-spin" : ""} />
      {!s.online && t("sync.offlineShort")}
    </span>
  );
}
