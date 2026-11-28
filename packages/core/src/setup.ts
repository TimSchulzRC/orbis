// Default types and settings. After setup the default types are ordinary data; their fixed ids
// (sys:*) only serve "restore default types".
import type * as Y from "yjs";
import { type Lang, translate, words } from "./i18n";
import {
	type Capabilities,
	FORMAT,
	type Item,
	initItem,
	initType,
	type PropDef,
	SETTINGS_ID,
	setMeta,
	setSchemaField,
	setSettings,
	setTab,
	setTabs,
	type ViewTab,
} from "./model";
import { keyBetween, keysFor } from "./sortkey";

export const SYS = {
	card: "sys:card",
	project: "sys:project",
	task: "sys:task",
} as const;

/** Property ids of the shipped "Blocked by" and "Waiting for". */
export const BLOCKED_BY = "p_blocked";
export const WAITING_FOR = "p_waiting";

export interface Writer {
	change(id: string, fn: (doc: Y.Doc) => void): void;
	get(id: string): Item | undefined;
}

type TypeSpec = {
	name: string;
	icon: string;
	color: string;
	description: string;
	capabilities: Capabilities;
	properties: Omit<PropDef, "sort">[];
};

export function defaultTypes(lang: Lang): Record<string, TypeSpec> {
	const t = (k: string) => translate(lang, `setup.${k}`);
	const typeKey = words(lang, "q.key.type")[0];
	const priority: Omit<PropDef, "sort"> = {
		id: "p_priority",
		name: t("prop.priority"),
		kind: "select",
		options: [
			{ id: "pr_high", name: t("priority.high"), color: "red" },
			{ id: "pr_medium", name: t("priority.medium"), color: "amber" },
			{ id: "pr_low", name: t("priority.low"), color: "green" },
		],
	};
	const blockedBy: Omit<PropDef, "sort"> = {
		id: BLOCKED_BY,
		name: t("prop.blockedBy"),
		kind: "relation",
		multiple: true,
		target: `${typeKey}:${t("task.name")} | ${typeKey}:${t("project.name")}`,
		inverseName: t("prop.blocking"),
		blocks: true,
	};
	return {
		[SYS.card]: {
			name: t("card.name"),
			icon: "sticky-note",
			color: "blue",
			description: t("card.description"),
			capabilities: {},
			properties: [],
		},
		[SYS.project]: {
			name: t("project.name"),
			icon: "folder-kanban",
			color: "green",
			description: t("project.description"),
			capabilities: { updates: true, template: { body: "" } },
			properties: [
				{
					id: "p_status",
					name: t("prop.status"),
					kind: "status",
					default: "st_backlog",
					options: [
						{ id: "st_backlog", name: t("status.backlog"), group: "todo", color: "gray" },
						{ id: "st_planning", name: t("status.planning"), group: "active", color: "blue" },
						{ id: "st_active", name: t("status.inProgress"), group: "active", color: "amber" },
						{ id: "st_paused", name: t("status.paused"), group: "active", color: "violet" },
						{ id: "st_done", name: t("status.done"), group: "done", color: "green" },
						{ id: "st_canceled", name: t("status.canceled"), group: "done", color: "red" },
					],
				},
				priority,
				{ id: "p_period", name: t("prop.period"), kind: "date", range: true },
				{ id: "p_summary", name: t("prop.summary"), kind: "text" },
				{
					id: "p_progress",
					name: t("prop.progress"),
					kind: "computed",
					computed: { fn: "progress", of: SYS.task },
				},
				blockedBy,
			],
		},
		[SYS.task]: {
			name: t("task.name"),
			icon: "circle-check",
			color: "slate",
			description: t("task.description"),
			capabilities: { due: "p_due" },
			properties: [
				{
					id: "p_status",
					name: t("prop.status"),
					kind: "status",
					default: "st_todo",
					options: [
						{ id: "st_todo", name: t("status.notStarted"), group: "todo", color: "gray" },
						{ id: "st_active", name: t("status.inProgress"), group: "active", color: "amber" },
						{ id: "st_paused", name: t("status.paused"), group: "active", color: "violet" },
						{ id: "st_done", name: t("status.done"), group: "done", color: "green" },
						{ id: "st_dropped", name: t("status.dropped"), group: "done", color: "brown" },
						{ id: "st_archived", name: t("status.archived"), group: "done", color: "gray" },
					],
				},
				priority,
				{ id: "p_due", name: t("prop.due"), kind: "date" },
				{
					id: "p_progress",
					name: t("prop.progress"),
					kind: "computed",
					computed: { fn: "progress", of: SYS.task },
				},
				blockedBy,
				{ id: WAITING_FOR, name: t("prop.waitingFor"), kind: "text", blocks: true },
			],
		},
	};
}

function createType(w: Writer, id: string, spec: TypeSpec, lang: Lang, origin?: string) {
	const tabs = defaultTabs(lang)[id];
	w.change(id, (doc) => {
		initType(doc, spec, { createdBy: origin });
		if (tabs) setTabs(doc, tabs);
	});
}

/** Creates missing default types and undeletes deleted ones. */
export function restoreDefaultTypes(w: Writer, lang: Lang, origin?: string): string[] {
	const specs = defaultTypes(lang);
	const changed: string[] = [];
	for (const [id, spec] of Object.entries(specs)) {
		const cur = w.get(id);
		if (!cur) {
			createType(w, id, spec, lang, origin);
			changed.push(id);
		} else if (cur.deleted) {
			w.change(id, (doc) => setMeta(doc, { deleted: null }));
			changed.push(id);
		}
	}
	return changed;
}

const DEFAULT_CAPTURE_TYPES = [SYS.card, SYS.task, SYS.project];

/**
 * Names and columns are in the setup language, like the type names. A view named like its kind
 * has no name, so it follows the UI language.
 */
/** The shipped types' views, written into the type when it is created. */
function defaultTabs(lang: Lang): Record<string, Omit<ViewTab, "pos">[]> {
	const p = (k: string) => translate(lang, `setup.prop.${k}`);
	const v = (k: string) => translate(lang, `setup.view.${k}`);
	const projectCols = [
		p("status"),
		"area",
		p("period"),
		p("priority"),
		p("progress"),
		p("blockedBy"),
	];
	return {
		[SYS.project]: [
			{
				id: "v_active",
				name: v("active"),
				kind: "table",
				group: "status",
				hideEmpty: true,
				hiddenGroups: ["st_backlog", "st_done", "st_canceled"],
				columns: projectCols,
			},
			{ id: "v_timeline", kind: "timeline", group: "statusGroup", date: p("period") },
			{ id: "v_board", kind: "board", group: "status", columns: [p("period"), p("status")] },
			{
				id: "v_all",
				name: v("all"),
				kind: "table",
				sort: [{ key: "status" }, { key: "updated", desc: true }],
				columns: projectCols,
			},
			{ id: "v_calendar", kind: "calendar", date: p("period") },
		],
		[SYS.task]: [
			{
				id: "v_byproject",
				name: v("byProject"),
				kind: "table",
				where: { status: "open" },
				group: "project",
				hideEmpty: true,
				sort: [{ key: "due" }],
				columns: [p("status"), p("priority"), p("blockedBy"), p("blocking"), p("due"), "tags"],
			},
			{
				id: "v_progress",
				name: v("progress"),
				kind: "board",
				group: "status",
				hiddenGroups: ["st_dropped", "st_archived"],
				subgroup: "project",
				sort: [{ key: p("priority") }],
				columns: [p("due")],
			},
			{
				id: "v_priority",
				name: p("priority"),
				kind: "board",
				where: { status: "open" },
				group: p("priority"),
				sort: [{ key: "status" }],
				columns: ["subtasks"],
			},
			{
				id: "v_all",
				name: v("all"),
				kind: "table",
				sort: [{ key: "status" }, { key: "due" }],
				columns: [
					"project",
					p("status"),
					p("priority"),
					p("due"),
					p("blockedBy"),
					p("blocking"),
					p("waitingFor"),
					"tags",
					"area",
				],
			},
		],
	};
}

/** The type's views; a type without any shows one table of all. */
export function typeTabs(type: Item, lang: Lang): ViewTab[] {
	if (type.schema?.views?.length) return type.schema.views;
	return [
		{ id: "v_all", name: translate(lang, "setup.view.all"), kind: "table", pos: keysFor(1)[0]! },
	];
}

/**
 * Stores the current FORMAT, so an older app stays read-only even offline once it has synced this.
 * Runs when the server opens a workspace; a second run changes nothing.
 */
export function upgradeSetup(w: Writer) {
	const settings = w.get(SETTINGS_ID);
	if (settings && (settings.settings?.format ?? 0) < FORMAT)
		w.change(SETTINGS_ID, (doc) => setSettings(doc, { format: FORMAT }));
}

/** "Restore default" of the inbox. */
export function resetInbox(w: Writer) {
	w.change(SETTINGS_ID, (doc) => setSettings(doc, { inbox: null }));
}

/** Safe to run twice (fixed ids merge). */
export function runSetup(w: Writer, lang: Lang, origin?: string) {
	const fresh = !w.get(SYS.project);
	restoreDefaultTypes(w, lang, origin);
	// order under "Types" and in the phone's bar
	if (fresh) {
		const order = [SYS.project, SYS.task, SYS.card];
		const pos = keysFor(order.length);
		for (const [i, id] of order.entries()) w.change(id, (d) => setSchemaField(d, "pos", pos[i]!));
	}
	if (!w.get(SETTINGS_ID))
		w.change(SETTINGS_ID, (doc) => {
			initItem(doc, { kind: "settings", title: "Settings" });
			setSettings(doc, { setupLang: lang, format: FORMAT, captureTypes: DEFAULT_CAPTURE_TYPES });
			// the inbox's to-dos: an ordinary tab, to change or remove like any other
			setTab(doc, "v_todos", {
				kind: "list",
				name: translate(lang, "setup.view.todos"),
				pos: keyBetween(null, null),
				where: { type: SYS.task },
				columns: [translate(lang, "setup.prop.priority")],
			});
		});
}
