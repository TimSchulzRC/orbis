import { Check, ChevronDown, MoreHorizontal, Plus, X } from "lucide-react";
import {
	type ComponentProps,
	type ComponentType,
	createContext,
	type MouseEvent,
	type ReactNode,
	useRef,
	useState,
} from "react";
import { Button as ShadcnButton } from "../components/ui/button";
import {
	DialogContent,
	DialogHeader,
	Dialog as DialogRoot,
	DialogTitle,
} from "../components/ui/dialog";
import { PopoverAnchor, PopoverContent, Popover as PopoverRoot } from "../components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { useT } from "../i18n";
import { cn } from "../lib/utils";

const VARIANTS = {
	ghost: "ghost",
	primary: "default",
	outline: "outline",
	danger: "destructive",
	"danger-outline": "outline",
	plain: "plain",
} as const;

/** The app's only button. `plain` has no look of its own, the caller styles it. */
export function Button({
	variant = "ghost",
	small,
	className,
	type,
	...rest
}: Omit<ComponentProps<typeof ShadcnButton>, "variant" | "size"> & {
	variant?: keyof typeof VARIANTS;
	small?: boolean;
}) {
	if (variant === "plain")
		return <ShadcnButton className={className} size="none" type={type} variant="plain" {...rest} />;
	return (
		<ShadcnButton
			aria-label={rest["aria-label"] ?? rest.title}
			size="sm"
			type={type ?? "button"}
			variant={VARIANTS[variant]}
			{...rest}
			className={cn(
				"tap h-auto rounded-lg px-2.5 py-1.5",
				small && "px-1.5 py-0.5",
				variant === "danger-outline" && "text-danger",
				className,
			)}
		/>
	);
}

const ICON_SIZES = { md: "rounded-lg p-1.5", sm: "rounded-md p-1", xs: "rounded p-0.5" };

/** `md` for bars and heads, `sm`/`xs` in rows. Forwards button props, so it works as a popover trigger. */
export function IconButton({
	label,
	icon: Icon,
	size = "md",
	iconSize = 16,
	className,
	...rest
}: {
	label: string;
	icon: ComponentType<{ size?: number }>;
	size?: keyof typeof ICON_SIZES;
	iconSize?: number;
} & Omit<ComponentProps<"button">, "children">) {
	return (
		<ShadcnButton
			aria-label={label}
			size="none"
			title={label}
			type="button"
			variant="plain"
			{...rest}
			className={cn(
				"tap inline-flex items-center justify-center text-muted-foreground transition-colors hover:bg-hover hover:text-fg disabled:opacity-40",
				ICON_SIZES[size],
				className,
			)}
		>
			<Icon size={iconSize} />
		</ShadcnButton>
	);
}

export const REVEAL = {
	any: "opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100",
	row: "opacity-0 group-hover/row:opacity-100 focus:opacity-100 pointer-coarse:opacity-100",
	head: "opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
};

/** `menu` from useContextMenu also opens it at the mouse on a right click. */
export function MoreMenu({
	children,
	label,
	align = "right",
	size = "md",
	iconSize,
	className,
	menu,
	...rest
}: {
	children: (close: () => void) => ReactNode;
	label?: string;
	align?: "left" | "right";
	size?: keyof typeof ICON_SIZES;
	iconSize?: number;
	className?: string;
	menu?: ContextMenu;
} & Omit<ComponentProps<"button">, "children" | "onClick">) {
	const { t } = useT();
	return (
		<Popover
			align={menu?.point ? "left" : align}
			onOpenChange={menu?.onOpenChange}
			open={menu?.open}
			point={menu?.point}
			trigger={(p) => (
				<IconButton
					{...rest}
					{...p}
					className={className}
					icon={MoreHorizontal}
					iconSize={iconSize}
					label={label ?? t("more")}
					size={size}
				/>
			)}
		>
			{children}
		</Popover>
	);
}

type ContextMenu = {
	open: boolean;
	point: { x: number; y: number } | null;
	onOpenChange: (o: boolean) => void;
	onContextMenu: (e: MouseEvent) => void;
};

/** Put `onContextMenu` on the row and pass the whole object as MoreMenu's `menu`. */
export function useContextMenu(): ContextMenu {
	const [open, setOpen] = useState(false);
	const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
	return {
		open,
		point,
		// keep the point while the menu fades out, else it jumps to the "…" button over the next rows
		// and catches a right click meant for them
		onOpenChange: (o) => (setOpen(o), o && setPoint(null)),
		onContextMenu: (e) => {
			e.preventDefault();
			e.stopPropagation();
			// right clicks inside the open menu bubble to the row through the portal
			if (!e.currentTarget.contains(e.target as Node)) return;
			setPoint({ x: e.clientX, y: e.clientY });
			setOpen(true);
		},
	};
}

/** One look for every "+ …" entry point. Forwards button props, so it works as a popover trigger. */
export function AddButton({
	children,
	className,
	icon: Icon = Plus,
	...rest
}: ComponentProps<"button"> & { icon?: ComponentType<{ size?: number }> }) {
	return (
		<ShadcnButton
			size="none"
			type="button"
			variant="plain"
			{...rest}
			className={cn(
				"tap-y inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-hover hover:text-fg",
				className,
			)}
		>
			<Icon size={12} /> {children}
		</ShadcnButton>
	);
}

/** At most one per section head. */
export function SectionAction({
	children,
	className,
	icon: Icon = Plus,
	...rest
}: ComponentProps<"button"> & { icon?: ComponentType<{ size?: number }> }) {
	return (
		<ShadcnButton
			size="none"
			type="button"
			variant="plain"
			{...rest}
			className={cn(
				"tap-y flex h-7 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-hover hover:text-fg",
				className,
			)}
		>
			<Icon size={14} /> {children}
		</ShadcnButton>
	);
}

export function EmptyValueButton({
	className,
	...rest
}: Omit<ComponentProps<"button">, "children">) {
	const { t } = useT();
	return (
		<ShadcnButton
			size="none"
			variant="plain"
			{...rest}
			className={cn(
				"tap-y -ml-1 rounded px-1 text-muted-foreground hover:bg-hover hover:text-fg",
				className,
			)}
		>
			{t("props.empty")}
		</ShadcnButton>
	);
}

export function DraftBar({
	onDiscard,
	onSave,
	className,
}: {
	onDiscard: () => void;
	onSave: () => void;
	className?: string;
}) {
	const { t } = useT();
	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-2 rounded-lg border border-focus px-2.5 py-1.5 text-sm",
				className,
			)}
			role="status"
		>
			<span className="mr-auto text-muted-foreground">{t("view.draft")}</span>
			<Button onClick={onDiscard} variant="outline">
				{t("view.discard")}
			</Button>
			<Button onClick={onSave} variant="primary">
				{t("view.save")}
			</Button>
		</div>
	);
}

/** `fill` centres it in the whole area. */
export function PagePlaceholder({ children, fill }: { children: ReactNode; fill?: boolean }) {
	return (
		<div
			className={
				fill
					? "flex h-full items-center justify-center text-muted-foreground"
					: "mx-auto max-w-3xl px-6 py-16 text-center text-muted-foreground"
			}
		>
			{children}
		</div>
	);
}

/** For a whole empty surface, one sentence and at most one button. Leave an empty section out instead. */
export function Empty({
	icon,
	title,
	children,
}: {
	icon?: ReactNode;
	title: string;
	children?: ReactNode;
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
			{icon && <div className="text-muted-foreground">{icon}</div>}
			<div className="text-[15px] text-muted-foreground">{title}</div>
			{children && <div className="max-w-sm text-sm text-muted-foreground">{children}</div>}
		</div>
	);
}

/** Design rules § 2.1: at most one action or switch on the right, no symbol before the title. */
export function SectionTitle({
	children,
	count,
	right,
	className,
}: {
	children: ReactNode;
	count?: ReactNode;
	right?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("mb-2.5 flex min-h-8 items-center gap-2", className)}>
			<h2 className="truncate text-[15px] font-semibold leading-[22px] text-fg">{children}</h2>
			{count !== undefined && count !== null && count !== "" && (
				<span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">{count}</span>
			)}
			{right && <div className="ml-auto flex shrink-0 items-center gap-1.5">{right}</div>}
		</div>
	);
}

/**
 * Set by a card around a list (a query block): a list that brings its own card leaves it out
 * and lines its outer edges up with the card's padding.
 */
export const InCard = createContext(false);

/** Design rules § 2.9: never nest a card in a card. */
export function Card({ className, ...rest }: ComponentProps<"div">) {
	return <div {...rest} className={cn("rounded-xl border border-line bg-surface", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
	return (
		<kbd className="rounded border border-line bg-surface-2 px-1 font-mono text-[10px] text-muted-foreground">
			{children}
		</kbd>
	);
}

/** The only control for how a list looks. */
export function ViewMenu({
	label,
	sections,
}: {
	label: string;
	sections: {
		title?: string;
		value: string;
		options: { value: string; label: string }[];
		onChange: (v: string) => void;
	}[];
}) {
	const { t } = useT();
	const shown = sections.filter((s) => s.options.length > 1);
	if (!shown.length) return null;
	return (
		<Popover
			align="right"
			trigger={(p) => (
				<Button
					variant="plain"
					{...p}
					aria-label={t("view.label")}
					className="tap inline-flex items-center justify-center gap-1 rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-hover hover:text-fg"
				>
					{label} <ChevronDown size={14} />
				</Button>
			)}
		>
			{(close) =>
				shown.map((s, i) => (
					<div className={cn(i > 0 && "mt-1 border-t border-line pt-1")} key={i}>
						{s.title && (
							<p className="px-2.5 pb-0.5 pt-1 text-xs text-muted-foreground">{s.title}</p>
						)}
						{s.options.map((o) => (
							<MenuItem
								active={o.value === s.value}
								key={o.value}
								onClick={() => (close(), s.value !== o.value && s.onChange(o.value))}
							>
								{o.label}
							</MenuItem>
						))}
					</div>
				))
			}
		</Popover>
	);
}

export function Popover({
	trigger,
	children,
	open,
	onOpenChange,
	align = "left",
	triggerClass,
	point,
}: {
	trigger: (p: { onClick: () => void; "aria-expanded": boolean }) => ReactNode;
	children: ReactNode | ((close: () => void) => ReactNode);
	open?: boolean;
	onOpenChange?: (o: boolean) => void;
	align?: "left" | "right";
	triggerClass?: string;
	/** e.g. a right click, opens there instead of below the trigger */
	point?: { x: number; y: number } | null;
}) {
	const [inner, setInner] = useState(false);
	const previous = useRef<HTMLElement | null>(null);
	const isOpen = open ?? inner;
	const setOpen = (next: boolean) => {
		if (next) previous.current = document.activeElement as HTMLElement;
		if (open === undefined) setInner(next);
		onOpenChange?.(next);
	};
	const triggerNode = trigger({ onClick: () => setOpen(!isOpen), "aria-expanded": isOpen });
	// restore focus only if nothing took it meanwhile – taking it from another badge's menu would close that menu
	const restoreFocus = (e: Event) => {
		e.preventDefault();
		const now = document.activeElement;
		if (previous.current?.isConnected && (!now || now === document.body))
			previous.current.focus({ preventScroll: true });
	};
	return (
		<PopoverRoot onOpenChange={setOpen} open={isOpen}>
			{point ? (
				<>
					<PopoverAnchor
						virtualRef={{
							current: {
								getBoundingClientRect: () =>
									DOMRect.fromRect({ x: point.x, y: point.y, width: 0, height: 0 }),
							},
						}}
					/>
					<span className={cn("relative inline-flex", triggerClass)}>{triggerNode}</span>
				</>
			) : (
				<PopoverAnchor asChild>
					<span className={cn("relative inline-flex", triggerClass)}>{triggerNode}</span>
				</PopoverAnchor>
			)}
			<PopoverContent
				align={align === "right" ? "end" : "start"}
				className="z-50 max-h-[70vh] w-auto min-w-48 overflow-y-auto rounded-xl p-1"
				data-popover
				onCloseAutoFocus={restoreFocus}
				sideOffset={4}
			>
				{typeof children === "function" ? children(() => setOpen(false)) : children}
			</PopoverContent>
		</PopoverRoot>
	);
}

export function MenuItem({
	children,
	onClick,
	danger,
	active,
	icon,
}: {
	children: ReactNode;
	onClick: () => void;
	danger?: boolean;
	active?: boolean;
	icon?: ReactNode;
}) {
	return (
		<Button
			aria-current={active || undefined}
			className={cn(
				"tap-row flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover",
				danger && "text-danger",
				active && "font-medium",
			)}
			onClick={onClick}
			variant="plain"
		>
			{icon && (
				<span
					className={cn(
						"flex w-4 shrink-0 justify-center",
						danger ? "text-danger" : "text-muted-foreground",
					)}
				>
					{icon}
				</span>
			)}
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{active && <Check className="shrink-0 text-muted-foreground" size={14} />}
		</Button>
	);
}

export function Dialog({
	title,
	children,
	onClose,
	wide,
}: {
	title: string;
	children: ReactNode;
	onClose: () => void;
	wide?: boolean;
}) {
	const { t } = useT();
	const previous = useRef<HTMLElement | null>(document.activeElement as HTMLElement);
	return (
		<DialogRoot
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			open
		>
			<DialogContent
				aria-describedby={undefined}
				className={cn(
					"flex max-h-[84vh] flex-col gap-0 overflow-hidden rounded-2xl p-0",
					wide ? "sm:max-w-2xl" : "sm:max-w-lg",
				)}
				onCloseAutoFocus={(e) => {
					e.preventDefault();
					if (previous.current?.isConnected) previous.current.focus({ preventScroll: true });
				}}
				showCloseButton={false}
			>
				<DialogHeader className="flex-row items-center gap-2 border-b border-line px-4 py-3 text-left">
					<DialogTitle className="flex-1 text-base">{title}</DialogTitle>
					<IconButton icon={X} label={t("close")} onClick={onClose} />
				</DialogHeader>
				<div className="min-h-0 overflow-y-auto p-4">{children}</div>
			</DialogContent>
		</DialogRoot>
	);
}

export function Seg<T extends string>({
	value,
	options,
	onChange,
	label,
	className,
}: {
	value: T;
	options: { value: T; label: ReactNode }[];
	onChange: (v: T) => void;
	label: string;
	className?: string;
}) {
	return (
		<ToggleGroup
			aria-label={label}
			className={cn(
				"inline-flex rounded-lg border border-line bg-secondary p-0.5 text-xs",
				className,
			)}
			onValueChange={(v) => {
				if (v) onChange(v as T);
			}}
			type="single"
			value={value}
		>
			{options.map((o) => (
				<ToggleGroupItem
					className="tap h-auto min-w-0 rounded-md px-2 py-0.5 text-xs data-[state=on]:bg-card data-[state=on]:font-medium data-[state=on]:shadow-sm dark:text-muted-foreground dark:data-[state=on]:bg-foreground/15 dark:data-[state=on]:text-foreground"
					key={o.value}
					value={o.value}
				>
					{o.label}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}
