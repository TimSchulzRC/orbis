// What changed between two versions of a text, line by line: removed lines red, added lines green,
// a few unchanged lines around each change, "⋯" between changes far apart.
import { type DiffLine, type TextDiff, type WordPart, wordDiff } from "@orbis/core/diff";
import { useT } from "../i18n";
import { cn } from "../lib/utils";

/**
 * For running text: a removed line followed by its replacement shows which words changed, each
 * line with its changed words marked more strongly.
 */
function withWords(lines: DiffLine[]): (DiffLine & { parts?: WordPart[] })[] {
	const out: (DiffLine & { parts?: WordPart[] })[] = lines.map((l) => ({ ...l }));
	for (let i = 0; i < out.length; ) {
		if (out[i]!.op !== "-") {
			i++;
			continue;
		}
		let minus = i;
		while (out[minus]?.op === "-") minus++;
		let plus = minus;
		while (out[plus]?.op === "+") plus++;
		// pairs only where as many lines came as went: else no line is the other's replacement
		if (plus - minus === minus - i)
			for (let n = 0; n < minus - i; n++) {
				const w = wordDiff(out[i + n]!.text, out[minus + n]!.text);
				out[i + n]!.parts = w.old;
				out[minus + n]!.parts = w.now;
			}
		i = plus;
	}
	return out;
}

export function DiffView({
	diff,
	className,
	words,
	tabIndex,
	label,
}: {
	diff: TextDiff;
	className?: string;
	words?: boolean;
	tabIndex?: number;
	label?: string;
}) {
	const { t } = useT();
	if (!diff.hunks.length)
		return (
			<p className={cn("text-sm text-muted-foreground", className)}>{t("history.noChange")}</p>
		);
	return (
		// a section with a label is a region, without one it stays a plain container
		<section
			aria-label={label}
			className={cn(
				"overflow-hidden rounded-lg border border-line font-mono text-xs leading-5",
				className,
			)}
			data-diff
			tabIndex={tabIndex}
		>
			{diff.hunks.map((h, i) => (
				<div key={`${h.oldStart}:${h.newStart}`}>
					{i > 0 && (
						<div className="select-none border-y border-line bg-surface-2 px-2 text-center text-muted-foreground">
							⋯
						</div>
					)}
					{(words ? withWords(h.lines) : h.lines).map((l: DiffLine & { parts?: WordPart[] }, j) => (
						<div
							className={cn(
								"flex whitespace-pre-wrap break-words px-2",
								l.op === "+" && "bg-[color-mix(in_srgb,var(--ok)_14%,transparent)]",
								l.op === "-" && "bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]",
							)}
							data-op={l.op === " " ? "same" : l.op === "+" ? "added" : "removed"}
							// biome-ignore lint/suspicious/noArrayIndexKey: a diff line has no identity but its place; the list is rebuilt, never reordered
							key={j}
						>
							<span
								aria-hidden
								className={cn(
									"w-4 shrink-0 select-none",
									l.op === "+" ? "text-ok" : l.op === "-" ? "text-danger" : "text-muted-foreground",
								)}
							>
								{l.op === "+" ? "+" : l.op === "-" ? "−" : ""}
							</span>
							<span className="sr-only">
								{l.op === "+" ? t("history.added") : l.op === "-" ? t("history.removed") : ""}
							</span>
							<span className="min-w-0 flex-1">
								{l.parts
									? l.parts.map((p, k) =>
											p.op === " " ? (
												p.text
											) : (
												<mark
													className={cn(
														"rounded-sm text-inherit",
														p.op === "+"
															? "bg-[color-mix(in_srgb,var(--ok)_32%,transparent)]"
															: "bg-[color-mix(in_srgb,var(--danger)_30%,transparent)] line-through decoration-danger/60",
													)}
													// biome-ignore lint/suspicious/noArrayIndexKey: changed words have no identity but their place in the line
													key={k}
												>
													{p.text}
												</mark>
											),
										)
									: l.text || " "}
							</span>
						</div>
					))}
				</div>
			))}
		</section>
	);
}

/** "+3 −1" in green and red: how many lines a change added and removed. */
export function LineCount({ diff }: { diff: TextDiff }) {
	return (
		<span className="tabular-nums">
			<span className="text-ok">+{diff.added}</span>{" "}
			<span className="text-danger">−{diff.removed}</span>
		</span>
	);
}
