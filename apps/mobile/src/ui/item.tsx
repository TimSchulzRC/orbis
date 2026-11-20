// An entry in a list: status circle, icon, title, where it lives and when it is due. A tap opens
// it, a long press shows its page as a preview with a menu (iOS context menu).

import type { Index } from "@orbis/core/graph";
import { fmtShortDate } from "@orbis/core/i18n";
import { type Item, todayISO } from "@orbis/core/model";
import { firstOfGroup, isDone, statusOf, statusProp } from "@orbis/core/traits";
import type { Repo } from "@orbis/sync";
import * as Haptics from "expo-haptics";
import { type Href, Link } from "expo-router";
import {
	Children,
	type ComponentProps,
	createContext,
	Fragment,
	isValidElement,
	type ReactNode,
	useContext,
} from "react";
import { ActionSheetIOS, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { lang, t, titleOf } from "../lib/i18n";
import { Icon, Row } from "./list";
import { lookOf } from "./look";
import { C, palHex } from "./theme";

/** The tab whose stack a screen sits in ("(inbox)"), set by the tab's layout. */
export const TabContext = createContext("(home)");

/**
 * The tab a screen belongs to: pages open on its own stack. Not the route on screen (useSegments):
 * the other tabs stay mounted, and their links must not change while you are elsewhere.
 */
export function useTab(): string {
	return useContext(TabContext);
}

export function itemHref(tab: string, space: string, id: string): Href {
	return `/(tabs)/${tab}/item/${space}/${id}` as Href;
}

export function typeHref(tab: string, space: string, id: string): Href {
	return `/(tabs)/${tab}/type/${space}/${id}` as Href;
}

export function DueText({ due, done }: { due?: string; done?: boolean }) {
	if (!due) return null;
	const today = todayISO();
	const overdue = !done && due < today;
	const isToday = due === today;
	return (
		<Text
			style={[
				styles.due,
				overdue && { color: C.red, fontWeight: "600" },
				isToday && { color: C.warn, fontWeight: "600" },
			]}
		>
			{isToday ? t("time.today") : fmtShortDate(lang, due)}
		</Text>
	);
}

/** Done or not with a tap; every status option with a long press. */
export function StatusCircle({ item, repo, ix }: { item: Item; repo: Repo; ix: Index }) {
	const schema = ix.schemaOf(item);
	const prop = statusProp(schema);
	const status = statusOf(item, schema);
	if (!prop || !status) return null;
	const group = status.group;
	const set = (option?: string) => {
		if (!option || option === status.option.id) return;
		const done = prop.options?.find((o) => o.id === option)?.group === "done";
		void Haptics.notificationAsync(
			done ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
		);
		repo.ownStep(() => repo.setProp(item.id, prop.id, option));
	};
	const toggle = () => set(firstOfGroup(schema, group === "done" ? "todo" : "done")?.id);
	const choose = () => {
		const options = prop.options ?? [];
		ActionSheetIOS.showActionSheetWithOptions(
			{
				title: prop.name,
				options: [
					...options.map((o) => (o.id === status.option.id ? `✓ ${o.name}` : o.name)),
					t("cancel"),
				],
				cancelButtonIndex: options.length,
			},
			(i) => set(options[i]?.id),
		);
	};
	const color =
		group === "done"
			? C.ok
			: group === "active"
				? C.accent
				: status.option.color
					? palHex(status.option.color)
					: C.faint;
	return (
		<Pressable
			accessibilityLabel={`${prop.name}: ${status.option.name}`}
			accessibilityRole="button"
			hitSlop={10}
			onLongPress={choose}
			onPress={toggle}
		>
			<Icon
				color={color}
				name={
					group === "done"
						? "checkmark.circle.fill"
						: group === "active"
							? "circle.lefthalf.filled"
							: "circle"
				}
				size={24}
			/>
		</Pressable>
	);
}

/** Progress as a ring, like the web app's "Running" list. */
export function Ring({ share, color, size = 28 }: { share: number; color: string; size?: number }) {
	const r = size / 2 - 3;
	const c = 2 * Math.PI * r;
	return (
		<Svg height={size} style={{ transform: [{ rotate: "-90deg" }] }} width={size}>
			<Circle cx={size / 2} cy={size / 2} fill="none" r={r} stroke="#8a8a8a33" strokeWidth={3} />
			<Circle
				cx={size / 2}
				cy={size / 2}
				fill="none"
				r={r}
				stroke={color}
				strokeDasharray={`${share * c} ${c}`}
				strokeLinecap="round"
				strokeWidth={3}
			/>
		</Svg>
	);
}

/** "Website › Relaunch", where the entry lives. */
export function placeOf(item: Item, ix: Index): string {
	return ix.pathText(ix.homePath(item.id).slice(-2));
}

export function confirmDelete(repo: Repo, item: Item, after?: () => void) {
	Alert.alert(t("delete.title", { title: titleOf(item) }), undefined, [
		{ text: t("cancel"), style: "cancel" },
		{
			text: t("item.delete"),
			style: "destructive",
			onPress: () => {
				repo.ownStep(() => repo.remove(item.id));
				void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
				after?.();
			},
		},
	]);
}

/** Menu entries without their fragments: Link.Menu keeps only its direct actions and submenus. */
function menuItems(node: ReactNode): ReactNode[] {
	return Children.toArray(node).flatMap((child) =>
		isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
			? menuItems(child.props.children)
			: [child],
	);
}

/**
 * An entry as a row. `menu` adds actions to its context menu (Open, Pin and Delete are always
 * there).
 */
export function ItemRow({
	space,
	item,
	ix,
	repo,
	subtitle,
	detail,
	right,
	status = true,
	icon,
	menu,
}: {
	space: string;
	item: Item;
	ix: Index;
	repo: Repo;
	subtitle?: string;
	detail?: ReactNode;
	right?: ReactNode;
	status?: boolean;
	/** Instead of the status circle or the type's symbol. */
	icon?: ReactNode;
	menu?: ReactNode;
}) {
	const tab = useTab();
	const look = lookOf(item, ix);
	const schema = ix.schemaOf(item);
	const circle =
		status && statusProp(schema) ? <StatusCircle item={item} ix={ix} repo={repo} /> : null;
	const done = isDone(item, schema);
	return (
		<Link asChild href={itemHref(tab, space, item.id)}>
			<Link.Trigger>
				<Pressable style={({ pressed }) => pressed && styles.pressed}>
					<Row
						detail={detail}
						icon={icon ?? circle ?? <Icon color={look.color} name={look.symbol} />}
						right={right}
						subtitle={subtitle}
						title={<Text style={done ? styles.done : undefined}>{titleOf(item)}</Text>}
					/>
				</Pressable>
			</Link.Trigger>
			<Link.Preview />
			<Link.Menu>
				{menuItems(menu)}
				<Link.MenuAction
					icon={item.pinned ? "pin.slash" : "pin"}
					onPress={() => repo.ownStep(() => repo.pin(item.id, !item.pinned))}
					title={item.pinned ? t("item.unpin") : t("item.pin")}
				/>
				<Link.MenuAction
					destructive
					icon="trash"
					onPress={() => confirmDelete(repo, item)}
					title={t("item.delete")}
				/>
			</Link.Menu>
		</Link>
	);
}

/** A row that opens a page. */
export function LinkRow({ href, ...row }: { href: Href } & ComponentProps<typeof Row>) {
	return (
		<Link asChild href={href}>
			<Pressable style={({ pressed }) => pressed && styles.pressed}>
				<Row {...row} />
			</Pressable>
		</Link>
	);
}

export function Chip({ label, color }: { label: string; color?: string }) {
	return (
		<View style={[styles.chip, color ? { backgroundColor: `${color}22` } : null]}>
			<Text numberOfLines={1} style={[styles.chipText, color ? { color } : null]}>
				{label}
			</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	due: { color: C.secondary, fontSize: 15, fontVariant: ["tabular-nums"] },
	pressed: { opacity: 0.6 },
	done: { color: C.secondary, textDecorationLine: "line-through" },
	chip: {
		backgroundColor: C.fill,
		borderRadius: 8,
		paddingHorizontal: 8,
		paddingVertical: 3,
	},
	chipText: { color: C.secondary, fontSize: 13, fontWeight: "500" },
});
