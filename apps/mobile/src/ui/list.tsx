// Inset grouped lists as in iOS's own apps: sections of rounded cards, rows with an icon, a title,
// details on the right and separators that start at the text.

import { SymbolView } from "expo-symbols";
import { Children, Fragment, isValidElement, type ReactNode } from "react";
import {
	type ColorValue,
	PlatformColor,
	Pressable,
	RefreshControl,
	ScrollView,
	type ScrollViewProps,
	StyleSheet,
	Text,
	View,
	type ViewStyle,
} from "react-native";
import type { SFSymbol } from "sf-symbols-typescript";
import { C, GUTTER, RADIUS } from "./theme";

/** A scrolling page under a native header: large titles collapse with it. */
export function Screen({
	children,
	onRefresh,
	refreshing = false,
	...rest
}: ScrollViewProps & { onRefresh?: () => void; refreshing?: boolean }) {
	return (
		<ScrollView
			contentContainerStyle={styles.content}
			contentInsetAdjustmentBehavior="automatic"
			keyboardDismissMode="interactive"
			keyboardShouldPersistTaps="handled"
			refreshControl={
				onRefresh ? <RefreshControl onRefresh={onRefresh} refreshing={refreshing} /> : undefined
			}
			style={styles.screen}
			{...rest}
		>
			{children}
		</ScrollView>
	);
}

export function Section({
	title,
	footer,
	prominent,
	children,
	style,
}: {
	title?: ReactNode;
	footer?: ReactNode;
	/** A content section ("Due", "Running") with a big title, not a settings group. */
	prominent?: boolean;
	children: ReactNode;
	style?: ViewStyle;
}) {
	const rows = Children.toArray(children).filter(Boolean);
	if (!rows.length) return null;
	return (
		<View style={[styles.section, style]}>
			{title !== undefined &&
				(typeof title === "string" ? (
					<Text style={prominent ? styles.prominent : styles.header}>{title}</Text>
				) : (
					title
				))}
			<View style={styles.card}>
				{rows.map((row, i) => (
					<Fragment key={isValidElement(row) && row.key != null ? row.key : i}>
						{i > 0 && <View style={styles.separator} />}
						{row}
					</Fragment>
				))}
			</View>
			{footer !== undefined && <Text style={styles.footer}>{footer}</Text>}
		</View>
	);
}

export function Icon({
	name,
	color = C.secondary,
	size = 22,
}: {
	name: SFSymbol;
	color?: ColorValue;
	size?: number;
}) {
	return (
		<SymbolView
			name={name}
			resizeMode="scaleAspectFit"
			size={size}
			style={{ width: size, height: size }}
			tintColor={color}
			type="hierarchical"
		/>
	);
}

export function Row({
	icon,
	title,
	subtitle,
	detail,
	right,
	chevron,
	onPress,
	onLongPress,
	destructive,
	titleLines = 1,
	accessibilityLabel,
}: {
	icon?: ReactNode;
	title: ReactNode;
	subtitle?: ReactNode;
	detail?: ReactNode;
	right?: ReactNode;
	chevron?: boolean;
	onPress?: () => void;
	onLongPress?: () => void;
	destructive?: boolean;
	titleLines?: number;
	accessibilityLabel?: string;
}) {
	const body = (
		<View style={styles.row}>
			{icon !== undefined && <View style={styles.icon}>{icon}</View>}
			<View style={styles.texts}>
				<Text
					numberOfLines={titleLines}
					style={[
						styles.title,
						destructive && { color: C.red },
						!!onPress && destructive && styles.center,
					]}
				>
					{title}
				</Text>
				{subtitle !== undefined && subtitle !== "" && (
					<Text numberOfLines={2} style={styles.subtitle}>
						{subtitle}
					</Text>
				)}
			</View>
			{detail !== undefined && detail !== "" && (
				<Text numberOfLines={1} style={styles.detail}>
					{detail}
				</Text>
			)}
			{right}
			{chevron && <Icon color={C.tertiary} name="chevron.right" size={13} />}
		</View>
	);
	if (!onPress && !onLongPress) return body;
	return (
		<Pressable
			accessibilityLabel={accessibilityLabel}
			accessibilityRole="button"
			onLongPress={onLongPress}
			onPress={onPress}
			style={({ pressed }) => pressed && styles.pressed}
		>
			{body}
		</Pressable>
	);
}

/** Centred in an empty page: a symbol, a line and an explanation. */
export function Empty({ symbol, title, text }: { symbol: SFSymbol; title: string; text?: string }) {
	return (
		<View style={styles.empty}>
			<Icon color={C.tertiary} name={symbol} size={44} />
			<Text style={styles.emptyTitle}>{title}</Text>
			{text ? <Text style={styles.emptyText}>{text}</Text> : null}
		</View>
	);
}

/** A one-line note above or below the lists. */
export function Note({
	children,
	color = C.secondary,
}: {
	children: ReactNode;
	color?: ColorValue;
}) {
	return <Text style={[styles.note, { color }]}>{children}</Text>;
}

export const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: C.background },
	content: { paddingBottom: 48 },
	section: { marginTop: 22, marginHorizontal: GUTTER },
	header: {
		color: C.secondary,
		fontSize: 13,
		marginBottom: 7,
		marginHorizontal: GUTTER,
		textTransform: "uppercase",
	},
	prominent: {
		color: C.label,
		fontSize: 22,
		fontWeight: "700",
		marginBottom: 10,
		marginHorizontal: 4,
	},
	footer: { color: C.secondary, fontSize: 13, marginHorizontal: GUTTER, marginTop: 7 },
	card: {
		backgroundColor: C.card,
		borderCurve: "continuous",
		borderRadius: RADIUS,
		overflow: "hidden",
	},
	separator: {
		backgroundColor: C.separator,
		height: StyleSheet.hairlineWidth,
		marginLeft: 58,
	},
	row: {
		alignItems: "center",
		flexDirection: "row",
		gap: 12,
		minHeight: 52,
		paddingHorizontal: GUTTER,
		paddingVertical: 10,
	},
	pressed: { backgroundColor: PlatformColor("systemGray5") },
	icon: { alignItems: "center", justifyContent: "center", width: 30 },
	texts: { flex: 1, gap: 2 },
	title: { color: C.label, fontSize: 17 },
	center: { textAlign: "center" },
	subtitle: { color: C.secondary, fontSize: 14 },
	detail: { color: C.secondary, fontSize: 15, maxWidth: "45%" },
	empty: { alignItems: "center", gap: 10, paddingHorizontal: 40, paddingTop: 90 },
	emptyTitle: { color: C.label, fontSize: 20, fontWeight: "600", textAlign: "center" },
	emptyText: { color: C.secondary, fontSize: 15, textAlign: "center" },
	note: { fontSize: 15, lineHeight: 21, marginHorizontal: GUTTER + 4, marginTop: 6 },
});
