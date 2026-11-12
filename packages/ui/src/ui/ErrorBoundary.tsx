// Wraps one page, so a rendering error never blanks the whole app.

import { RotateCw } from "lucide-react";
import { Component, type ReactNode } from "react";
import { tr } from "../i18n";
import { Button } from "./primitives";

export class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidCatch(error: Error) {
		console.error("[page]", error);
	}

	override render() {
		const { error } = this.state;
		if (!error) return this.props.children;
		return (
			<div className="mx-auto max-w-xl px-4 py-16 text-center" data-error-boundary>
				<h1 className="text-lg font-semibold">{tr("error.title")}</h1>
				<p className="mt-2 text-sm text-muted-foreground">{tr("error.hint")}</p>
				<pre className="mt-4 overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 text-left text-xs text-muted-foreground">
					{error.message}
				</pre>
				<Button className="mt-5 px-3" onClick={() => location.reload()} variant="primary">
					<RotateCw size={14} /> {tr("error.reload")}
				</Button>
			</div>
		);
	}
}
