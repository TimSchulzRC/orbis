// shadcn/ui's button group (only the group itself): buttons side by side, joined into one frame.

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

const buttonGroupVariants = cva(
	"flex w-fit items-stretch *:focus-visible:relative *:focus-visible:z-10",
	{
		variants: {
			orientation: {
				horizontal: "*:not-first:rounded-l-none *:not-first:border-l-0 *:not-last:rounded-r-none",
				vertical:
					"flex-col *:not-first:rounded-t-none *:not-first:border-t-0 *:not-last:rounded-b-none",
			},
		},
		defaultVariants: { orientation: "horizontal" },
	},
);

function ButtonGroup({
	className,
	orientation,
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: a row of buttons, not form fields; a fieldset brings its own frame and spacing
		<div
			className={cn(buttonGroupVariants({ orientation }), className)}
			data-orientation={orientation}
			data-slot="button-group"
			role="group"
			{...props}
		/>
	);
}

export { ButtonGroup, buttonGroupVariants };
