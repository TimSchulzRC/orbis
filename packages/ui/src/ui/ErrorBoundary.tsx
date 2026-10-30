// A rendering error on one page shows what went wrong and offers "Neu laden" – never a blank
// page. The rest of the app (sidebar, agent) keeps working.
import { Component, type ReactNode } from "react";
import { RotateCw } from "lucide-react";
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
      <div data-error-boundary className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-lg font-semibold">{tr("error.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{tr("error.hint")}</p>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 text-left text-xs text-muted-foreground">{error.message}</pre>
        <Button variant="primary" onClick={() => location.reload()} className="mt-5 px-3">
          <RotateCw size={14} /> {tr("error.reload")}
        </Button>
      </div>
    );
  }
}
