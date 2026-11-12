// Values left on an entry after its type or property is gone. They can only be shown and removed.

import { fmtDate, fmtNumber } from "@obtion/core/i18n";
import type { FreeValue } from "@obtion/core/model";
import { useT } from "../i18n";

export function FreeValueText({ value }: { value: FreeValue }) {
	const { lang } = useT();
	const v = value.v;
	if (Array.isArray(v)) return <span className="text-sm break-words">{v.join(", ")}</span>;
	if (value.k === "checkbox") return <span className="text-sm">{v ? "✓" : "–"}</span>;
	if (value.k === "number")
		return (
			<span className="text-sm tabular-nums">
				{typeof v === "number" ? fmtNumber(lang, v) : String(v)}
			</span>
		);
	if (value.k === "date")
		return (
			<span className="text-sm whitespace-nowrap">
				{String(v)
					.split("/")
					.map((d) => fmtDate(lang, d))
					.join(" – ")}
			</span>
		);
	if (value.k === "url" && /^https?:\/\//.test(String(v)))
		return (
			<a
				className="truncate text-sm text-link hover:underline"
				href={String(v)}
				rel="noopener"
				target="_blank"
			>
				{String(v).replace(/^https?:\/\//, "")}
			</a>
		);
	return <span className="text-sm break-words">{String(v ?? "")}</span>;
}
