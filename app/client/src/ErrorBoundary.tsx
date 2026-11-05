import { Button } from "@databricks/appkit-ui/react";
import { RotateCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

/** Catches an error while a page draws, so the person sees a short message and a Reload button, not a blank screen. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("The page failed to draw.", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    const { error, componentStack } = this.state;
    if (error === null) return this.props.children;
    return (
      <div role="alert" className="mx-auto flex min-h-screen max-w-xl flex-col items-start justify-center gap-3 p-6">
        <h1 className="text-lg font-semibold text-foreground">Something went wrong on this page.</h1>
        <p className="text-sm text-muted-foreground">Reload the page to try again. If it keeps happening, tell the person who runs Watchdog.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()} className="gap-1.5">
          <RotateCw aria-hidden="true" className="size-3.5" />
          Reload
        </Button>
        {import.meta.env.DEV ? (
          <pre className="mt-2 max-h-96 w-full overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
            {error.stack ?? error.toString()}
            {componentStack}
          </pre>
        ) : null}
      </div>
    );
  }
}
