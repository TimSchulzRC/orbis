import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "../../lib/utils";

function Badge({
	className,
	asChild = false,
	...props
}: React.ComponentProps<"span"> & { asChild?: boolean }) {
	const Comp = asChild ? Slot.Root : "span";

	return (
		<Comp
			className={cn(
				"inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
				"border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
				className,
			)}
			data-slot="badge"
			{...props}
		/>
	);
}

export { Badge };
