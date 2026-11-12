// Settings as in the app's settings dialog: a group is a small heading over a card of rows, a
// row its title and hint on the left and its control on the right. "Edit type" uses them too.
import type { ReactNode } from "react";

export function SettingsGroup({
	title,
	hint,
	action,
	children,
}: {
	title: string;
	hint?: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section>
			<div className="mb-2 flex min-h-7 items-end gap-2 px-1">
				<h3 className="flex-1 pb-0.5 text-xs font-medium text-muted-foreground">{title}</h3>
				{action}
			</div>
			<div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
				{children}
			</div>
			{hint && <p className="mt-2 px-1 text-xs text-muted-foreground">{hint}</p>}
		</section>
	);
}

export function SettingRow({
	title,
	hint,
	control,
	children,
}: {
	title: ReactNode;
	hint?: ReactNode;
	control?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<div className="space-y-3 px-4 py-3">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<div className="min-w-0 flex-1 basis-56">
					<p className="truncate text-sm font-medium">{title}</p>
					{hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
				</div>
				{control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
			</div>
			{children}
		</div>
	);
}
