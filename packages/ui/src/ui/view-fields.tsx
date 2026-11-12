// The fields a view can show, sort, group and filter by: the properties of the types it lists and
// the built-in ones.

import { type PropDef, type PropKind, titleKey } from "@obtion/core/model";
import { type Cond, parseQuery, typesIn, viewTypeIds } from "@obtion/core/query";
import {
	Calendar,
	CheckSquare,
	CircleDashed,
	Clock,
	CornerLeftUp,
	Hash,
	Link,
	Link2,
	ListChecks,
	Sigma,
	Tag,
	Type,
} from "lucide-react";
import type { ComponentType } from "react";
import { useIndex } from "../hooks";
import { useT } from "../i18n";

type Icon = ComponentType<{ size?: number; className?: string }>;

export const PROP_ICON: Record<PropKind, Icon> = {
	text: Type,
	number: Hash,
	date: Calendar,
	checkbox: CheckSquare,
	url: Link,
	select: ListChecks,
	status: CircleDashed,
	relation: Link2,
	computed: Sigma,
};
const FIELD_ICON: Record<string, Icon> = { item: CornerLeftUp, tags: Tag, "builtin-date": Clock };

export function FieldIcon({ kind, size = 14 }: { kind: ViewField["kind"]; size?: number }) {
	const Icon = FIELD_ICON[kind] ?? PROP_ICON[kind as PropKind] ?? Type;
	return <Icon className="shrink-0 text-muted-foreground" size={size} />;
}

export interface ViewField {
	key: string; // stored in columns / sort / group: a built-in field or the property's name
	label: string;
	kind: PropDef["kind"] | "item" | "tags" | "builtin-date";
	prop?: PropDef;
}

/** Fields of the types a view lists (and the built-in ones), for columns, sorting, grouping and dates. */
export function useViewFields(
	where: Cond | undefined,
	sample: { type: string | null }[] = [],
): ViewField[] {
	const ix = useIndex();
	const { t } = useT();
	const typeIds = viewTypeIds(where, sample, ix);
	const out: ViewField[] = [];
	const seen = new Set<string>();
	const push = (f: ViewField) => {
		if (seen.has(titleKey(f.key))) return;
		seen.add(titleKey(f.key));
		out.push(f);
	};
	for (const id of typeIds)
		for (const p of ix.types.get(id)!.schema.properties)
			push({ key: p.name, label: p.name, kind: p.kind, prop: p });
	// the other side of relations that can point here ("Blockiert diese")
	for (const type of ix.types.values())
		for (const p of type.schema.properties) {
			if (p.kind !== "relation" || p.symmetric || !p.inverseName) continue;
			const target = p.target ? typesIn(parseQuery(p.target, ix).def.where) : [];
			if (target.length && !target.some((x) => typeIds.includes(x))) continue;
			if (!typeIds.includes(type.id) && !target.length) continue;
			push({ key: p.inverseName, label: p.inverseName, kind: "relation" });
		}
	push({ key: "project", label: t("field.project"), kind: "item" });
	push({ key: "area", label: t("field.area"), kind: "item" });
	push({ key: "tags", label: t("item.tags"), kind: "tags" });
	push({ key: "created", label: t("field.created"), kind: "builtin-date" });
	push({ key: "updated", label: t("field.updated"), kind: "builtin-date" });
	return out;
}
